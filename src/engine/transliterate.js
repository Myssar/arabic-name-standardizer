/**
 * The transliteration engine.
 *
 * Resolution order per name segment, highest confidence first:
 *   1. multi-token dictionary match  (نور الدين -> Nooruldeen)
 *   2. single-token dictionary match (محمد     -> Muhammad)
 *   3. generative Abd- compound rule (عبد الشكور -> Abdulshakoor)
 *   4. name particle                 (بن        -> Bin)
 *   5. rule-based fallback           (flagged LOW confidence)
 *
 * Step 5 is explicitly untrustworthy and says so in its output. Arabic script
 * does not encode short vowels, so a rule engine cannot distinguish Omar from
 * Umar from Amr. Anything reaching step 5 needs a human to confirm it against
 * the passport.
 */

import { clean, tokenize, hasArabic, lookupKey } from './normalize.js';
import { lookup } from './dictionary.js';
import {
  PASSPORT_CONSONANTS,
  VOWEL_LETTERS,
  INITIAL_VOWELS,
  ICAO_MRZ,
  PARTICLES,
  TITLES,
  AL,
} from './rules.js';

export const CONFIDENCE = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

const MAX_VARIANTS = 12;
const MAX_WINDOW = 3;

/**
 * A personal name has a handful of parts. These ceilings exist because the
 * input is untrusted — a spreadsheet cell can contain anything, and without
 * them a single hostile cell can hang the tab:
 *
 *  - MAX_TOKENS bounds the main resolution loop.
 *  - MAX_VARIANT_SEGMENTS bounds variant generation, which is quadratic in the
 *    number of parts. A 20,000-token cell took this from milliseconds to
 *    minutes, which is a denial of service reachable from a pasted cell.
 */
const MAX_TOKENS = 64;
const MAX_VARIANT_SEGMENTS = 8;

// ---------------------------------------------------------------------------
// Rule-based fallback
// ---------------------------------------------------------------------------

/** Split a token into ordered phonetic units. */
function toUnits(token) {
  const units = [];
  const chars = [...token];

  chars.forEach((ch, i) => {
    const isFirst = i === 0;
    const isLast = i === chars.length - 1;

    if (ch === 'ة') {
      // ة  taa marbuta: silent -a finally, /t/ in construct position
      units.push(isLast ? { type: 'v', text: 'a' } : { type: 'c', text: 't' });
      return;
    }

    if (ch === 'ى') {
      units.push({ type: 'v', text: 'a' });
      return;
    }

    if (VOWEL_LETTERS.has(ch)) {
      if (isFirst) {
        // Word-initial waw and yaa are consonants (w/y), not long vowels.
        // Treating them as vowels swallows the following syllable: الوليد
        // came out "Al-Wlid" instead of "Al-Walid".
        const initial = INITIAL_VOWELS.get(ch) ?? 'a';
        const isSemivowel = ch === 'و' || ch === 'ي';
        units.push({ type: isSemivowel ? 'c' : 'v', text: initial });
        return;
      }
      switch (ch) {
        case 'و': units.push({ type: 'v', text: 'u' }); return;
        case 'ي': units.push({ type: 'v', text: 'i' }); return;
        case 'ؤ': units.push({ type: 'v', text: 'u' }); return;
        case 'ئ': units.push({ type: 'v', text: 'i' }); return;
        default:  units.push({ type: 'v', text: 'a' }); return; // ا آ أ إ
      }
    }

    const mapped = PASSPORT_CONSONANTS.get(ch);
    if (mapped === undefined) return; // unknown glyph: drop rather than guess
    if (mapped === '') {
      // ع and ء are unwritten in passport convention but still occupy a slot.
      // They are tracked separately because they behave differently at the end
      // of a word: a final ء lengthens the vowel before it (الزهراء -> Zahraa),
      // a final ع does not (ربيع is Rabi, not Rabii).
      units.push({ type: 'z', text: '', hamza: ch !== 'ع', final: isLast });
      return;
    }
    units.push({ type: 'c', text: mapped });
  });

  return units;
}

/**
 * Vowelless roots follow predictable CV templates. Handling them explicitly is
 * markedly more accurate than blind epenthesis:
 *   3 consonants -> CaCaC   (حسن -> hasan)
 *   4 consonants -> CaCCaC  (فرقد -> farqad)
 */
function templateFill(units) {
  const solid = units.filter((u) => u.type !== 'z');
  if (solid.some((u) => u.type === 'v')) return null;
  const c = solid.map((u) => u.text);
  if (c.length === 3) return `${c[0]}a${c[1]}a${c[2]}`;
  if (c.length === 4) return `${c[0]}a${c[1]}${c[2]}a${c[3]}`;
  return null;
}

function joinUnits(units) {
  const templated = templateFill(units);
  let out = templated ?? '';

  if (!templated) {
    let consonantsSinceVowel = 0;
    for (const unit of units) {
      if (unit.type === 'v') {
        out += unit.text;
        consonantsSinceVowel = 0;
        continue;
      }
      if (unit.type === 'z') {
        // ain and hamza are not written in passport convention, but they are
        // syllable-bearing: dropping them silently welds the surrounding
        // consonants together (سعود became "Sud" instead of "Saud").
        // They surface as the supporting vowel instead.
        if (out === '' || consonantsSinceVowel >= 1) {
          out += 'a';
          consonantsSinceVowel = 0;
          continue;
        }
        // Word-final اء: the hamza is what makes the preceding alef long, and
        // collapsing it to a single vowel produced Zahra, Bara, Isra — names
        // their owners spell Zahraa, Baraa, Israa.
        if (unit.hamza && unit.final && /a$/.test(out)) out += 'a';
        continue;
      }
      if (consonantsSinceVowel >= 1) out += 'a';
      out += unit.text;
      consonantsSinceVowel += 1;
    }
  }

  // Collapse the doubled vowels that ain-dropping can produce.
  return out.replace(/([aiu])\1+/g, '$1$1').replace(/^a(?=[aiu])/, '');
}

function capitalize(word) {
  if (!word) return word;
  return word[0].toUpperCase() + word.slice(1);
}

/**
 * The canonical presentation.
 *
 * Title case, single spaces, apostrophes dropped, and the letter after a hyphen
 * capitalized so `Al-Jubouri` keeps its shape. Deterministic: the same Arabic
 * input produces a byte-identical string no matter which surface of the
 * extension produced it, which is what makes it usable as a database key.
 *
 * This was upper case at first — passports print capitals — but capitals are
 * hard to read in a long column and nobody types a name that way into a form.
 * The value of a standard is that everyone uses the same one, not that it
 * shouts.
 */
export function toStandard(text) {
  return String(text ?? '')
    .replace(/[’']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_match, before, letter) => before + letter.toUpperCase());
}

/**
 * Romanize a bare token. Returns a record rather than a string because the
 * definite-article path can recover dictionary confidence: الزهراء is not a
 * dictionary key, but زهراء is.
 */
function romanizeByRules(token) {
  let working = token;
  let prefix = '';

  // Definite article: rendered Al- and hyphenated, the convention used on most
  // Arab passports for family names (Al-Jubouri, Al-Zaidi). The lam is written
  // even before sun letters, where it is not pronounced, because document
  // matching beats phonetic fidelity here.
  if (working.startsWith(AL) && [...working].length > 3) {
    working = working.slice(2);
    prefix = 'Al-';
  }

  if (prefix) {
    const known = lookup(working);
    if (known) {
      const stem = known.primary.replace(/^Al-/, '');
      return {
        latin: prefix + stem,
        confidence: CONFIDENCE.MEDIUM,
        source: 'dictionary+article',
        variants: known.variants.map((v) => prefix + v.replace(/^Al-/, '')),
      };
    }
  }

  const body = joinUnits(toUnits(working));
  if (!body) {
    return { latin: prefix.replace(/-$/, ''), confidence: CONFIDENCE.LOW, source: 'rules', variants: [] };
  }
  return {
    latin: prefix + capitalize(body),
    confidence: CONFIDENCE.LOW,
    source: 'rules',
    variants: [],
  };
}

// ---------------------------------------------------------------------------
// -al-Din compounds
// ---------------------------------------------------------------------------

const DEEN = 'الدين';

/**
 * X + الدين behaves like the Abd- compounds: it is one name, and passports
 * print it joined. Keeping it joined also avoids it being split across the
 * given-name and surname fields on an application form.
 */
function tryDeenCompound(tokens, index) {
  if (tokens[index + 1] !== DEEN) return null;

  // Same first-refusal rule as the Abd- compounds above.
  const pinned = lookup(`${tokens[index]} ${DEEN}`);
  if (pinned) {
    return {
      consumed: 2,
      latin: pinned.primary,
      variants: pinned.variants,
      source: 'dictionary',
      confidence: CONFIDENCE.HIGH,
    };
  }

  const known = lookup(tokens[index]);
  const stem = known ? known.primary : capitalize(joinUnits(toUnits(tokens[index])));
  if (!stem) return null;

  const base = stem.replace(/aa$/i, 'a');
  return {
    consumed: 2,
    latin: capitalize(`${base}uldeen`),
    variants: [`${stem} Al-Din`, `${base}uddin`, `${base}eddine`],
    source: 'compound',
    confidence: known ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
  };
}

// ---------------------------------------------------------------------------
// X + الله compounds
// ---------------------------------------------------------------------------

const ALLAH = 'الله';

/**
 * نصر الله, عطا الله, هبة الله, عبد الله.
 *
 * الله is not the definite article plus a noun, but it looks exactly like one:
 * the article stripper removed ال and romanized the remaining له, so نصر الله
 * came out as "Nasar Al-Lah" — not a spelling any passport has ever printed.
 * These are single names and are printed joined (Nasrallah, Ataallah), which
 * also keeps them from being split across the given-name and surname fields on
 * an application form.
 *
 * عبد الله is left to the Abd- branch, which runs first and has the pinned
 * dictionary entry for it.
 */
function tryAllahCompound(tokens, index) {
  const first = tokens[index];
  let stemToken = null;
  let consumed = 1;

  if (tokens[index + 1] === ALLAH) {
    stemToken = first;
    consumed = 2;
  } else if (first.endsWith(ALLAH) && [...first].length > 5) {
    stemToken = first.slice(0, first.length - ALLAH.length);
  } else {
    return null;
  }

  if (!stemToken) return null;

  // The dictionary gets first refusal on the whole thing, so pinned spellings
  // such as عبيد الله win over anything generated here.
  const span = tokens.slice(index, index + consumed).join(' ');
  const pinned = lookup(span) ?? lookup(stemToken + ALLAH);
  if (pinned) {
    return {
      consumed,
      latin: pinned.primary,
      variants: pinned.variants,
      source: 'dictionary',
      confidence: CONFIDENCE.HIGH,
    };
  }

  const known = lookup(stemToken);
  const stem = known ? known.primary : capitalize(joinUnits(toUnits(stemToken)));
  if (!stem) return null;

  // Nasr + allah, not Nasr + ullah: the linking vowel is part of the stem's
  // final syllable, and "-allah" is what is actually printed.
  const base = stem.replace(/[aeiou]+$/i, '');
  return {
    consumed,
    latin: capitalize(`${base}allah`),
    variants: [`${stem} Allah`, `${base}ullah`],
    source: 'compound',
    confidence: known ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
  };
}

// ---------------------------------------------------------------------------
// Abd- compounds
// ---------------------------------------------------------------------------

const ABD = 'عبد';

/**
 * عبد + definite-article noun. Written joined or separated in Arabic; passports
 * overwhelmingly print it joined (Abdulrahman, Abdullah), which is also what
 * avoids the split-name problems on Canadian forms that have a single
 * "given names" field.
 */
function tryAbdCompound(tokens, index) {
  const first = tokens[index];
  let attribute = null;
  let consumed = 1;

  if (first === ABD && tokens[index + 1]?.startsWith(AL)) {
    attribute = tokens[index + 1].slice(2);
    consumed = 2;
  } else if (first.startsWith(ABD + AL) && [...first].length > 5) {
    attribute = first.slice(5);
  } else {
    return null;
  }

  if (!attribute) return null;

  // The compound rules run before the single-token dictionary (so that ضياء
  // does not match greedily and strand الدين). That ordering means a compound
  // written as ONE token — عبدالله rather than عبد الله — would reach the
  // generative branch even though it is a pinned dictionary entry, and be
  // reported as a low-confidence guess. Give the dictionary first refusal on
  // the whole span.
  const span = tokens.slice(index, index + consumed).join(' ');
  const pinned = lookup(span);
  if (pinned) {
    return {
      consumed,
      latin: pinned.primary,
      variants: pinned.variants,
      source: 'dictionary',
      confidence: CONFIDENCE.HIGH,
    };
  }

  const known = lookup(attribute);
  const attributeLatin = known
    ? known.primary.replace(/^Al-/, '')
    : capitalize(joinUnits(toUnits(attribute)));

  if (!attributeLatin) return null;

  const joined = `Abdul${attributeLatin.toLowerCase()}`;
  return {
    consumed,
    latin: capitalize(joined),
    variants: [
      `Abdel ${attributeLatin}`,
      `Abdul ${attributeLatin}`,
      `Abd Al-${attributeLatin}`,
    ],
    source: 'compound',
    confidence: known ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
  };
}

// ---------------------------------------------------------------------------
// ICAO MRZ (Doc 9303 Part 3 §6.C)
// ---------------------------------------------------------------------------

/**
 * Encode to the passport machine-readable zone alphabet.
 * This is NOT a name. It is included so a user can check the bottom two lines
 * of their own passport against what the standard specifies.
 */
export function toIcaoMrz(input) {
  const text = clean(input);
  if (!text) return '';
  return tokenize(text)
    .map((token) => {
      const chars = [...token];
      return chars
        .map((ch, i) => {
          if (ch === 'ة') return i === chars.length - 1 ? 'XAH' : 'XTA';
          return ICAO_MRZ.get(ch) ?? '';
        })
        .join('');
    })
    .join('<');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param {string} input  Arabic name, any length, with or without diacritics.
 * @returns {{
 *   ok: boolean,
 *   input: string,
 *   cleaned: string,
 *   primary: string,
 *   variants: string[],
 *   mrz: string,
 *   confidence: 'high'|'medium'|'low',
 *   segments: Array<{arabic:string, latin:string, source:string, confidence:string, variants:string[]}>,
 *   notes: string[]
 * }}
 */
export function transliterate(input) {
  const cleaned = clean(input);
  const empty = {
    ok: false,
    input: input ?? '',
    cleaned,
    primary: '',
    // `standard` is the field every caller renders. Leaving it off the rejected
    // shape meant `transliterate('').standard` was `undefined`, one missing
    // guard away from writing the string "undefined" into a spreadsheet cell.
    standard: '',
    variants: [],
    mrz: '',
    confidence: CONFIDENCE.LOW,
    segments: [],
    notes: [],
  };

  if (!cleaned) return { ...empty, notes: ['No input.'] };
  if (!hasArabic(cleaned)) {
    return { ...empty, notes: ['Input contains no Arabic letters.'] };
  }

  const allTokens = tokenize(cleaned);
  const tokens = allTokens.slice(0, MAX_TOKENS);
  const overlong = allTokens.length > MAX_TOKENS;
  const segments = [];
  const unromanized = [];
  let i = 0;

  while (i < tokens.length) {
    // 1. longest MULTI-token dictionary match.
    //    Single tokens are deliberately deferred until after the compound rules:
    //    ضياء is a dictionary entry on its own, and matching it greedily would
    //    strand الدين and produce "Dhiaa Al-Din" instead of "Dhiauldeen".
    let matched = false;
    for (let size = Math.min(MAX_WINDOW, tokens.length - i); size >= 2 && !matched; size--) {
      const window = tokens.slice(i, i + size);
      const hit = lookup(window.join(' '));
      if (hit) {
        segments.push({
          arabic: window.join(' '),
          latin: hit.primary,
          source: 'dictionary',
          confidence: CONFIDENCE.HIGH,
          variants: hit.variants,
          gender: hit.gender,
        });
        i += size;
        matched = true;
      }
    }
    if (matched) continue;

    // 2. generative compounds (Abd-, -al-Din)
    const compound = tryAbdCompound(tokens, i)
      ?? tryDeenCompound(tokens, i)
      ?? tryAllahCompound(tokens, i);
    if (compound) {
      segments.push({
        arabic: tokens.slice(i, i + compound.consumed).join(' '),
        latin: compound.latin,
        source: compound.source,
        confidence: compound.confidence,
        variants: compound.variants,
        gender: null,
      });
      i += compound.consumed;
      continue;
    }

    // 3. leading honorific.
    //    FIRST TOKEN ONLY, and only when a name follows. الشيخ and الحاج are
    //    also real family names (Al-Sheikh, Al-Hajj), and a family name never
    //    opens an Arabic full name. Anywhere else in the string it is a name.
    //
    //    The segment is kept for the caller but is NOT part of `standard`: a
    //    legal-name field takes the person's name, not their rank, and "Dr."
    //    would also put a period into a field that rejects one.
    const title = i === 0 && tokens.length > 1 ? TITLES.get(lookupKey(tokens[i])) : null;
    if (title) {
      segments.push({
        arabic: tokens[i], latin: title, source: 'title',
        confidence: CONFIDENCE.HIGH, variants: [], gender: null,
      });
      i += 1;
      continue;
    }

    // 4. single-token dictionary match
    const single = lookup(tokens[i]);
    if (single) {
      segments.push({
        arabic: tokens[i],
        latin: single.primary,
        source: 'dictionary',
        confidence: CONFIDENCE.HIGH,
        variants: single.variants,
        gender: single.gender,
      });
      i += 1;
      continue;
    }

    // 5. anything with no Arabic in it passes through untouched.
    //    Without this, a Latin word inside an Arabic name was silently deleted:
    //    "محمد Smith" came back as "Muhammad", losing the surname entirely.
    //    Arabic-first-name-plus-Latin-surname is common enough that this was
    //    quietly destroying real data in bulk conversions.
    if (!hasArabic(tokens[i])) {
      segments.push({
        arabic: tokens[i], latin: tokens[i], source: 'passthrough',
        confidence: CONFIDENCE.HIGH, variants: [], gender: null,
      });
      i += 1;
      continue;
    }

    // 6. name particle
    const particle = PARTICLES.get(tokens[i]);
    if (particle) {
      segments.push({
        arabic: tokens[i],
        latin: particle,
        source: 'particle',
        confidence: CONFIDENCE.HIGH,
        variants: [],
        gender: null,
      });
      i += 1;
      continue;
    }

    // 7. rules (with definite-article dictionary recovery)
    //
    //    An empty result here used to be pushed as-is, which DELETED a name
    //    part: any token built only from letters the rule table did not know
    //    came back as ''. "علي ی الجبوري" became "Ali Al-Jubouri" and the row
    //    was still reported as converted. Losing a name silently is the worst
    //    thing this program can do, so an empty romanization falls back to the
    //    Arabic itself, which is visibly wrong and therefore fixable.
    const ruled = romanizeByRules(tokens[i]);
    if (!ruled.latin) {
      ruled.latin = tokens[i];
      ruled.source = 'unromanized';
      unromanized.push(tokens[i]);
    }
    segments.push({
      arabic: tokens[i],
      latin: ruled.latin,
      source: ruled.source,
      confidence: ruled.confidence,
      variants: ruled.variants,
      gender: null,
    });
    i += 1;
  }

  const primary = segments.map((s) => s.latin).filter(Boolean).join(' ');
  const confidence = segments.some((s) => s.confidence === CONFIDENCE.LOW)
    ? CONFIDENCE.LOW
    : segments.some((s) => s.confidence === CONFIDENCE.MEDIUM)
      ? CONFIDENCE.MEDIUM
      : CONFIDENCE.HIGH;

  const notes = [];
  if (overlong) {
    notes.push(
      `This entry has ${allTokens.length} parts, which is not a personal name. ` +
      `Only the first ${MAX_TOKENS} were converted.`,
    );
  }
  const stripped = strippedCharacters(segments);
  if (stripped) {
    notes.push(
      `Removed from the standard form: ${stripped}. A Latin name field accepts `
      + 'letters, spaces, hyphens and apostrophes only; the Arabic above is unchanged.',
    );
  }
  if (unromanized.length) {
    notes.push(
      `Could not romanize ${unromanized.join(', ')} — the Arabic was kept as it is `
      + 'so nothing is lost. Type it in Latin letters yourself, or add it to the dictionary.',
    );
  }
  if (segments.some((s) => s.source === 'rules')) {
    notes.push(
      'One or more parts were produced by rules, not by the verified dictionary. ' +
      'Arabic script omits short vowels, so these are guesses. Check them against the passport.'
    );
  }
  if (segments.some((s) => s.source === 'compound' && s.confidence === CONFIDENCE.LOW)) {
    notes.push('An Abd- compound was built generatively; confirm the second element.');
  }

  return {
    ok: true,
    input: input ?? '',
    cleaned,
    primary,
    // THE output. Passports print names in capitals, and a single case removes
    // one more axis along which the same name can be recorded two ways — which
    // is the entire point of a standardizer. Everything user-facing uses this;
    // `primary` remains the internal, human-readable form.
    standard: buildStandard(segments),
    variants: buildVariants(segments, primary),
    // The truncated token list, not `cleaned`. Feeding the full string here
    // meant MAX_TOKENS bounded the main loop but not this one, so the ceiling
    // the notes advertise was not the ceiling that actually applied.
    mrz: toIcaoMrz(tokens.join(' ')),
    confidence,
    segments,
    notes,
  };
}

/**
 * Produce alternative full-name spellings the same person may hold documents
 * under. Bounded, because the combinatorics explode: a two-part name can have
 * thousands of attested romanizations across passport offices.
 */
/*
 * Characters a Latin name field accepts.
 *
 * `standard` is pasted straight into a passport application, a university
 * form, or a spreadsheet column that a registrar will import. Those fields take
 * letters, spaces, hyphens and apostrophes — nothing else. Passthrough segments
 * used to bypass every check, so "محمد 😀 علي" produced "Muhammad 😀 Ali", and
 * a stray "#1" or "<script>" in a spreadsheet cell rode through untouched.
 */
const NAME_CHARACTERS = /[^A-Za-z '\-]+/g;

function sanitizeNamePart(text) {
  return String(text ?? '')
    // Strip accents rather than delete or split the letter: Müller becomes
    // Muller. NFD separates the mark, which is then removed outright — replacing
    // it with a space the way the rule below does would give "Mu ller".
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(NAME_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Join segments into the standard form.
 *
 * Titles are deliberately dropped: an honorific is not part of a legal name,
 * and every one of them carries a period. They stay in `segments` for any
 * caller that wants to show what was removed.
 */
function buildStandard(segments) {
  return segments
    .filter((segment) => segment.source !== 'title')
    .map((segment) => {
      // A part the rule engine could not romanize is carried through in Arabic,
      // unsanitized and on purpose. The alternative is deleting it, and a form
      // that rejects visible Arabic is a far better outcome than a name that
      // quietly arrives with a piece missing.
      if (segment.source === 'unromanized') return segment.latin;
      if (segment.source === 'passthrough') return sanitizeNamePart(segment.latin);
      return sanitizeNamePart(toStandard(segment.latin));
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What the sanitizer took out, as a short human-readable list.
 *
 * Silently deleting characters is how a tool loses a digit from an ID or half a
 * surname without anyone noticing. The removal is right — those characters do
 * not belong in a name field — but it has to be visible.
 */
function strippedCharacters(segments) {
  const removed = new Set();
  for (const segment of segments) {
    if (segment.source === 'title' || segment.source === 'unromanized') continue;
    const before = segment.source === 'passthrough' ? segment.latin : toStandard(segment.latin);
    for (const character of String(before).normalize('NFD').replace(/\p{M}+/gu, '')) {
      if (/[^A-Za-z '\-\s]/.test(character)) removed.add(character);
    }
  }
  return removed.size ? [...removed].join(', ') : '';
}

function buildVariants(segments, primary) {
  const base = segments.map((s) => s.latin);
  const out = new Set();

  // Both loops below rebuild the whole name per candidate, so their cost is
  // quadratic in the number of parts. Bounding the segments considered keeps
  // that quadratic term small and constant regardless of input length.
  const limit = Math.min(segments.length, MAX_VARIANT_SEGMENTS);
  const ceiling = MAX_VARIANTS * 3;

  // Single substitutions first. Someone comparing two documents almost always
  // differs in one name part, so "Mohammed Abdulrahman Al-Jubouri" is far more
  // useful than the twelfth permutation of the same first two parts — which is
  // what a naive cartesian product surfaces.
  outer:
  for (let i = 0; i < limit; i++) {
    for (const alternative of segments[i].variants) {
      if (!alternative) continue;
      const candidate = base.map((part, j) => (j === i ? alternative : part));
      out.add(candidate.filter(Boolean).join(' '));
      if (out.size > ceiling) break outer;
    }
  }

  // Then pairwise combinations, to cover documents that differ in two parts.
  pairs:
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      for (const a of segments[i].variants) {
        for (const b of segments[j].variants) {
          const candidate = base.map((part, k) => (k === i ? a : k === j ? b : part));
          out.add(candidate.filter(Boolean).join(' '));
          if (out.size > ceiling) break pairs;
        }
      }
    }
  }

  out.delete(primary);
  return [...out].filter(Boolean).slice(0, MAX_VARIANTS);
}

export default transliterate;
