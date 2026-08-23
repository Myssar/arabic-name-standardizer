/**
 * Arabic text normalization.
 *
 * Two distinct outputs are produced from raw input:
 *
 *  - `clean`      : diacritics and joiners removed, but letter identity preserved.
 *                   This is what the rule engine consumes, because hamza carriers
 *                   and taa marbuta carry real phonetic information.
 *
 *  - `lookupKey`  : aggressively folded form used only for dictionary matching.
 *                   Orthographic variants that Arabic writers use interchangeably
 *                   (أ/إ/آ/ا, ى/ي, ة/ه) are collapsed so that عبدالله, عبد اللّه
 *                   and عبد الله all resolve to the same entry.
 */

// Tashkeel (harakat), superscript alef, and Quranic annotation marks.
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣣ࣡-ࣿ]/g;

// Tatweel / kashida — purely decorative letter elongation.
const TATWEEL = /ـ/g;

// Zero-width and bidi control characters that survive copy/paste from PDFs.
const INVISIBLES = /[​-‏‪-‮⁦-⁩﻿]/g;

const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

/** Ligature ﻻ and its hamzated forms, decomposed to their constituent letters. */
const LIGATURES = new Map([
  ['ﻻ', 'لا'], // ﻻ
  ['ﻵ', 'لآ'], // ﻵ
  ['ﻷ', 'لأ'], // ﻷ
  ['ﻹ', 'لإ'], // ﻹ
]);

export const ARABIC_LETTER = /[ء-يٮ-ۓ]/;

/** True if the string contains at least one Arabic letter. */
export function hasArabic(text) {
  return typeof text === 'string' && ARABIC_LETTER.test(text);
}

function foldDigits(text) {
  return text.replace(ARABIC_INDIC_DIGITS, (d) => {
    const code = d.codePointAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/*
 * Letters from the Persian, Urdu and Kurdish keyboard layouts that Iraqis and
 * other Arabic speakers type every day — often without noticing, because they
 * render almost identically. Every one of these was previously unknown to the
 * rule engine, which DELETED it: علی (with a Persian yeh) came back as "Al",
 * and محمد ی علي lost a whole name part in silence. Folding them here means one
 * place fixes every consumer.
 */
const FOREIGN_LETTERS = new Map([
  ['ی', 'ي'], ['ے', 'ي'], ['ۍ', 'ي'], ['ێ', 'ي'],   // Farsi/Urdu/Kurdish yeh
  ['ڪ', 'ك'],                                          // swash kaf
  ['ھ', 'ه'], ['ہ', 'ه'], ['ە', 'ه'], ['ۀ', 'ه'],   // heh forms
  ['ۆ', 'و'], ['ۇ', 'و'], ['ۊ', 'و'], ['ۏ', 'و'],   // Kurdish/Uyghur waw
  ['ڕ', 'ر'], ['ڵ', 'ل'], ['ڤ', 'ف'], ['ۋ', 'ف'],   // Kurdish r, l, v
]);
// ک گ پ چ ژ are deliberately absent: the rule table already romanizes them
// (k, g, p, ch, zh), and folding them onto Arabic letters would lose that.

function foldForeignLetters(text) {
  let out = '';
  for (const ch of text) out += FOREIGN_LETTERS.get(ch) ?? ch;
  return out;
}

function foldLigatures(text) {
  let out = '';
  for (const ch of text) out += LIGATURES.get(ch) ?? ch;
  return out;
}

/**
 * Remove decoration without destroying letter identity.
 * Also normalizes the several Unicode ways of writing the same separator.
 */
export function clean(input) {
  if (typeof input !== 'string') return '';
  let text = input.normalize('NFC');
  text = foldLigatures(text);
  text = foldForeignLetters(text);
  /*
   * Replaced with a SPACE, not deleted. A zero-width non-joiner between two
   * name parts is invisible to the person typing but is a real separator to
   * them: deleting it welded محمد‌علي into one token and produced
   * "Mahamadali" instead of "Muhammad Ali". A collapsed run of spaces is
   * harmless; a welded name is a different name.
   */
  text = text.replace(INVISIBLES, ' ');
  text = text.replace(DIACRITICS, '');
  text = text.replace(TATWEEL, '');
  text = foldDigits(text);
  // Arabic comma, ideographic space, non-breaking space -> plain separators.
  text = text.replace(/،/g, ',').replace(/[ 　]/g, ' ');
  // Normalize the various dashes people use between name parts.
  text = text.replace(/[‐-―−]/g, '-');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Aggressive fold for dictionary lookup only. Never render this to the user —
 * it deliberately discards distinctions the rule engine needs.
 */
export function lookupKey(input) {
  return clean(input)
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ -> ا
    .replace(/ى/g, 'ي')                     // ى -> ي
    .replace(/ة/g, 'ه')                     // ة -> ه
    .replace(/ؤ/g, 'و')                     // ؤ -> و
    .replace(/ئ/g, 'ي')                     // ئ -> ي
    .replace(/ء/g, '')                           // bare hamza dropped
    .replace(/[\s\-']/g, '')                          // spacing is not meaningful here
    .toLowerCase();
}

/**
 * Split a full name into tokens, preserving hyphenated compounds as single
 * tokens so that `عبد-الله` behaves like `عبد الله`.
 */
export function tokenize(input) {
  const text = clean(input);
  if (!text) return [];
  return text
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[-'"()\[\].]+|[-'"()\[\].]+$/g, ''))
    .filter(Boolean);
}
