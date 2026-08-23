/**
 * Bulk conversion: spreadsheet in, spreadsheet out.
 *
 * The workflow this serves is narrow and worth stating, because it drives every
 * design choice here: someone has a column of Arabic names in Excel or Sheets,
 * selects it, copies, pastes here, and needs a column back that they can paste
 * into the adjacent column **in the same row order**. Row alignment is the whole
 * product. A result that is correct but shifted by one row is worse than useless,
 * so blank rows are preserved rather than skipped and nothing is ever reordered
 * or deduplicated away.
 */

import { transliterate } from './transliterate.js';
import { hasArabic, clean, lookupKey } from './normalize.js';

/** Rendering more than this many rows freezes the tab; export still covers all. */
export const DISPLAY_LIMIT = 500;

// ---------------------------------------------------------------------------
// Grid parsing
// ---------------------------------------------------------------------------

/**
 * Excel and Google Sheets both put TAB between cells and NEWLINE between rows on
 * the clipboard, regardless of the file's own format. Commas are only treated as
 * delimiters for actual .csv files, because an Arabic cell may legitimately
 * contain a comma but will never contain a tab.
 */
export function detectDelimiter(text, { assumeCsv = false } = {}) {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (!lines.length) return null;

  // Measured per line, not by raw count.
  //
  // Testing `includes('\t')` meant ONE stray tab anywhere in a .csv re-parsed
  // the whole file as TSV — rows collapsed into single cells and columns were
  // fused onto the ends of names, silently. But counting tabs against the line
  // count over-corrected in the other direction: a ragged TSV where a single
  // row is missing its second column dropped below the threshold and collapsed
  // to one column, which is the same failure wearing different clothes.
  //
  // The question that actually distinguishes them is "does this character
  // appear on most lines?", which a stray tab never does and a real delimiter
  // always does, however ragged the data.
  const share = (ch) => lines.filter((line) => line.includes(ch)).length / lines.length;
  const tabShare = share('\t');
  const commaShare = share(',');

  if (assumeCsv) {
    if (tabShare >= 0.5 && tabShare > commaShare) return '\t';
    return commaShare > 0 ? ',' : (tabShare >= 0.5 ? '\t' : null);
  }
  return tabShare >= 0.5 ? '\t' : null;
}

/**
 * RFC 4180 field parsing: handles quoted fields, embedded delimiters, embedded
 * newlines, and doubled quotes. Written out rather than split(',') because
 * exported spreadsheets routinely contain all four.
 */
function scan(text, delimiter, { literal }) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    // A quote opens a quoted field only when nothing but whitespace precedes it.
    // Testing `field === ''` instead rejected the very common exporter output
    // `, "value, with comma"`, which then split into a phantom extra column that
    // the name-column detector could go on to select — dropping most of the
    // names on the sheet without a word of warning.
    if (!literal && ch === '"' && field.trim() === '') { quoted = true; field = ''; continue; }
    if (delimiter && ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }

  row.push(field);
  rows.push(row);
  return { rows, unterminated: quoted };
}

/**
 * RFC 4180 field parsing: handles quoted fields, embedded delimiters, embedded
 * newlines, and doubled quotes. Written out rather than split(',') because
 * exported spreadsheets routinely contain all four.
 *
 * @returns {{rows: string[][], malformed: boolean}}
 */
export function parseDelimitedDetailed(text, delimiter) {
  const normalized = text.replace(/\r\n?/g, '\n');

  // A single unbalanced quote used to swallow the entire rest of the file:
  // once inside a quoted field there was no recovery, so every later delimiter
  // and newline was absorbed and four people could arrive as two fused rows.
  // A well-formed document always contains an even number of quote characters,
  // so an odd count is positive evidence of damage — parse literally instead of
  // pretending the structure is intact, and say so.
  //
  // Counted in a loop rather than with `match(/"/g)`: that builds an array with
  // one one-character string per quote, which on a 16 MB file of quotes — the
  // largest this accepts — cost 280 MB and 1.9 s just to learn a parity bit.
  let quoteCount = 0;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized.charCodeAt(i) === 34) quoteCount++;
  }
  let malformed = quoteCount % 2 === 1;

  let { rows, unterminated } = scan(normalized, delimiter, { literal: malformed });
  if (unterminated) {
    malformed = true;
    ({ rows } = scan(normalized, delimiter, { literal: true }));
  }

  // A trailing newline produces one empty row; drop only that.
  if (rows.length > 1 && rows[rows.length - 1].every((c) => c === '')) rows.pop();

  return { rows, malformed };
}

/** Back-compatible wrapper: rows only. */
export function parseDelimited(text, delimiter) {
  return parseDelimitedDetailed(text, delimiter).rows;
}

/**
 * Turn pasted clipboard text or a file's contents into a rectangular grid.
 *
 * @returns {{grid: string[][], malformed: boolean}}
 */
export function parseGridDetailed(text, { assumeCsv = false } = {}) {
  if (typeof text !== 'string' || text.trim() === '') return { grid: [], malformed: false };

  const delimiter = detectDelimiter(text, { assumeCsv });
  const { rows, malformed } = parseDelimitedDetailed(text, delimiter);

  // reduce, not Math.max(...rows.map(…)): the spread passes one argument per
  // row, so a 130,000-row paste — about 1.1 MB, well inside the file limit and
  // well inside what the .xlsx reader accepts — threw RangeError: Maximum call
  // stack size exceeded. On the paste path that surfaced as nothing happening.
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);

  const grid = rows.map((row) => {
    const padded = [...row];
    while (padded.length < width) padded.push('');
    return padded.map((cell) => cell.trim());
  });

  return { grid, malformed };
}

/** Back-compatible wrapper: grid only. */
export function parseGrid(text, options = {}) {
  return parseGridDetailed(text, options).grid;
}

// ---------------------------------------------------------------------------
// Column and header detection
// ---------------------------------------------------------------------------

/** Enough rows to characterize a column without transliterating the whole sheet. */
const COLUMN_SAMPLE = 60;

/**
 * How name-like is this column?
 *
 * Counting Arabic cells is not enough, and assuming otherwise was a real defect:
 * on a sheet with columns [ت | الاسم الكامل | القسم], the department column
 * (هندسة, طب, قانون…) has *more* Arabic cells than the name column, so the
 * highest-count rule confidently picked the wrong one.
 *
 * The signal that actually separates them is dictionary recognition. Personal
 * names resolve against the name dictionary; department, city and note columns
 * fall through to the rule engine. Scoring by the fraction of segments that
 * resolve as name parts distinguishes the two cleanly.
 */
function scoreColumn(grid, column) {
  const sample = grid.slice(0, COLUMN_SAMPLE);
  let arabicCells = 0;
  let recognized = 0;
  let tokens = 0;

  for (const row of sample) {
    const cell = row[column] ?? '';
    if (!hasArabic(cell)) continue;
    arabicCells++;
    const { segments } = transliterate(cell);
    if (!segments.length) continue;
    tokens += segments.length;
    const known = segments.filter(
      (s) => s.source.startsWith('dictionary') || s.source === 'compound' || s.source === 'particle',
    ).length;
    recognized += known / segments.length;
  }

  return {
    arabicCells,
    nameScore: arabicCells ? recognized / arabicCells : 0,
    averageTokens: arabicCells ? tokens / arabicCells : 0,
  };
}

/**
 * Choose the column most likely to hold the names. Ranked by dictionary
 * recognition, then by how many name parts the cells contain (a full name has
 * more than a category label), then by Arabic density, then leftmost.
 */
export function detectArabicColumn(grid) {
  if (!grid.length) return 0;
  const width = grid[0].length;
  const scores = [];
  for (let column = 0; column < width; column++) scores.push(scoreColumn(grid, column));

  const best = scores.reduce((bestIndex, current, index) => {
    const incumbent = scores[bestIndex];
    if (current.arabicCells === 0) return bestIndex;
    if (incumbent.arabicCells === 0) return index;

    // Treat near-equal recognition as a tie; a 1-in-20 difference is noise.
    if (current.nameScore - incumbent.nameScore > 0.05) return index;
    if (incumbent.nameScore - current.nameScore > 0.05) return bestIndex;

    if (current.averageTokens - incumbent.averageTokens > 0.3) return index;
    if (incumbent.averageTokens - current.averageTokens > 0.3) return bestIndex;

    return current.arabicCells > incumbent.arabicCells ? index : bestIndex;
  }, 0);

  return best;
}

/**
 * Column labels, Arabic and English.
 *
 * The Arabic half is not decoration. A sheet produced by an Arabic-speaking
 * registrar has Arabic headers, and the "first row has no Arabic" heuristic
 * alone silently converts الاسم الكامل ("full name") into a person called
 * "Al-Asam Al-Kamil". That was a real defect found by spot-checking.
 */
const HEADER_TERMS_ARABIC = [
  'اسم', 'الاسم', 'الاسم الكامل', 'الاسم الثلاثي', 'الاسم الرباعي',
  'اسم الطالب', 'اسم الطالبة', 'الطالب', 'الطالبة', 'اسم الاب', 'اسم الجد',
  'الاسم الاول', 'اللقب', 'الكنية', 'الاسم بالعربي', 'الاسم باللغة العربية',
  'الاسم بالانكليزي', 'التسلسل', 'ت', 'م', 'رقم', 'الرقم', 'العدد',
  'الملاحظات', 'ملاحظات', 'القسم', 'الفرع', 'المرحلة', 'الجنس',
  'تاريخ الميلاد', 'المواليد', 'الجامعة', 'الكلية', 'التخصص',
];

const HEADER_TERMS_LATIN = [
  'name', 'full name', 'fullname', 'student name', 'applicant name',
  'arabic name', 'name in arabic', 'name (arabic)', 'first name', 'last name',
  'given name', 'given names', 'middle name', 'surname', 'family name',
  'id', 'no', 'no.', '#', 'number', 'seq', 'serial', 'index', 'row',
  'notes', 'remarks', 'program', 'programme', 'department', 'faculty',
  'gender', 'sex', 'dob', 'date of birth', 'email', 'phone',
];

const HEADER_LEXICON = new Set([
  ...HEADER_TERMS_ARABIC.map((term) => lookupKey(term)),
  ...HEADER_TERMS_LATIN,
]);

function looksLikeLabel(cell) {
  const text = clean(cell);
  if (!text) return false;
  if (hasArabic(text)) return HEADER_LEXICON.has(lookupKey(text));
  return HEADER_LEXICON.has(text.toLowerCase().replace(/\s+/g, ' '));
}

const NUMERIC = /^-?\d+([.,]\d+)?$/;

/**
 * Decide whether row 0 is a header. Three independent signals, any of which is
 * sufficient — they cover different real inputs and none subsumes the others.
 *
 * Guessing wrong in the other direction (treating a real name as a header) drops
 * a person from the output entirely, so every signal requires positive evidence
 * from the rows below rather than judging row 0 alone. The UI also exposes a
 * manual override, because no heuristic here should be the last word.
 */
export function detectHeader(grid, column) {
  if (grid.length < 2) return false;
  const first = grid[0][column] ?? '';
  const body = grid.slice(1);

  // (a) Row 0 is a recognized column label in either language.
  if (looksLikeLabel(first)) return true;

  // (b) Some other column is numeric all the way down but not in row 0 —
  //     an ID or sequence column, which is language-independent evidence.
  const width = grid[0].length;
  for (let c = 0; c < width; c++) {
    const head = clean(grid[0][c] ?? '');
    const values = body.map((row) => clean(row[c] ?? '')).filter(Boolean);
    if (!head || values.length < 2) continue;
    if (!NUMERIC.test(head) && values.every((value) => NUMERIC.test(value))) return true;
  }

  // (c) The original signal: no Arabic in the name column, Arabic below it.
  if (hasArabic(first)) return false;
  return body.some((row) => hasArabic(row[column] ?? ''));
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a grid.
 *
 * @param {string[][]} grid
 * @param {{column?: number, hasHeader?: boolean, onProgress?: (done:number,total:number)=>void}} options
 * @returns {{rows: Array, summary: Object, header: string[]|null, column: number}}
 */
export function convertGrid(grid, options = {}) {
  const column = options.column ?? detectArabicColumn(grid);
  const hasHeader = options.hasHeader ?? detectHeader(grid, column);
  const header = hasHeader ? grid[0] : null;
  const body = hasHeader ? grid.slice(1) : grid;

  // Repeated names are common in real sheets (family members, duplicated rows).
  // The cache keeps a 5,000-row paste responsive without changing any output.
  const cache = new Map();
  const rows = [];
  const unlisted = [];
  // `unlisted` counts names resolved by rule rather than by the dictionary.
  // It is not shown as a per-row warning — it drives the approval queue, whose
  // job is to grow the shared standard rather than to make the user hesitate
  // over individual rows.
  const summary = { total: 0, converted: 0, high: 0, medium: 0, low: 0, blank: 0, skipped: 0, unlisted: 0 };

  body.forEach((source, index) => {
    const original = source[column] ?? '';
    summary.total++;

    if (original.trim() === '') {
      // Preserved, not skipped: dropping it would shift every row below it.
      summary.blank++;
      rows.push({ index, original, primary: '', standard: '', confidence: null, status: 'blank', variants: [], notes: [], segments: [], needsReview: false, source: null });
      return;
    }

    if (!hasArabic(original)) {
      // Already Latin, or a note, or a number. Passed through untouched so the
      // column still lines up and nothing the user wrote is destroyed.
      summary.skipped++;
      // Left exactly as written. Uppercasing text the tool did not convert
      // would be rewriting the user's own data on a guess.
      rows.push({ index, original, primary: original, standard: original, confidence: null, status: 'passthrough', variants: [], notes: [], segments: [], needsReview: false, source: null });
      return;
    }

    const key = clean(original);
    let result = cache.get(key);
    if (!result) {
      result = transliterate(original);
      cache.set(key, result);
    }

    summary.converted++;
    summary[result.confidence]++;
    if (result.segments.some((seg) => seg.source === 'rules' || seg.source === 'compound')) {
      summary.unlisted++;
      unlisted.push(result);
    }
    rows.push({
      index,
      original,
      primary: result.primary,
      standard: result.standard,
      confidence: result.confidence,
      status: 'converted',
      variants: result.variants,
      notes: result.notes,
      mrz: result.mrz,
      // Carried so the UI can show WHERE each part of the spelling came from.
      // A name is trustworthy in pieces, not as a whole: the surname may be a
      // verified dictionary entry while the given name is a rule-engine guess.
      segments: result.segments,
      // True when at least one part was produced by rules rather than looked
      // up. These are the only rows that need a human, and the interface
      // colours nothing else.
      needsReview: result.segments.some((seg) => seg.source === 'rules'
        || seg.source === 'compound' || seg.source === 'unromanized'),
      // Distinct mechanisms only: "dictionary+dictionary+dictionary" tells the
      // reader nothing that "dictionary" does not.
      source: [...new Set(result.segments.map((s) => s.source))].join(' + '),
    });

    if (options.onProgress && summary.total % 250 === 0) {
      options.onProgress(summary.total, body.length);
    }
  });

  options.onProgress?.(body.length, body.length);
  return { rows, summary, header, column, hasHeader, unlisted, cacheHits: summary.converted - cache.size };
}

/** Convenience wrapper for raw pasted text. */
export function convertText(text, options = {}) {
  const { grid, malformed } = parseGridDetailed(text, options);
  return { ...convertGrid(grid, options), malformed };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Spreadsheet formula injection
// ---------------------------------------------------------------------------

/**
 * Excel, LibreOffice and Google Sheets all evaluate a cell that begins with
 * =, +, - or @ as a formula — on CSV open AND on clipboard paste. That makes
 * every export path here an injection vector, because the input is a
 * spreadsheet someone else may have written and non-Arabic cells are echoed
 * back verbatim by design.
 *
 * A cell reading `=cmd|'/c calc'!A1` or `=HYPERLINK("http://evil","click")`
 * travels: attacker's sheet -> this tool -> the user's clipboard -> the user's
 * spreadsheet, where it executes in their context. Passing it through unchanged
 * would make this tool the delivery mechanism.
 *
 * Mitigation is the standard one: prefix with an apostrophe, which every major
 * spreadsheet treats as "the rest of this cell is literal text". The apostrophe
 * is not part of the stored value once pasted.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function neutralizeFormula(value) {
  const text = String(value ?? '');
  return FORMULA_TRIGGER.test(text) ? `'${text}` : text;
}

/**
 * Collapse anything that would end a line or a cell.
 *
 * This must run BEFORE neutralizeFormula, not after. A passthrough cell
 * containing an embedded newline — reachable from a quoted CSV field or an
 * .xlsx cell holding `&#10;` — used to emit two clipboard lines for one row.
 * That shifted every row below it out of alignment, and it also defeated the
 * formula guard outright: only the first line got the apostrophe, so
 * `benign\n=cmd|'/c calc'!A1` exported its payload completely unprotected.
 */
function flattenCell(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ');
}

/**
 * One value per line, same order as the input, no header. This is what gets
 * pasted into the column next to the original — the primary output of the tool.
 *
 * Generated Latin names can never start with a formula trigger, but
 * passthrough rows echo untrusted input verbatim, so this path needs the same
 * neutralization as the full table.
 */
export function toColumn(rows) {
  return rows.map((r) => neutralizeFormula(flattenCell(r.standard ?? r.primary))).join('\n');
}

/**
 * The engine still computes alternative spellings — they are on every result
 * object and available to anyone using the module directly. They are simply not
 * surfaced in the UI or the default export, because on a sheet of hundreds of
 * names a column of "also spelled…" is noise, not information.
 */
const FULL_COLUMNS = ['Arabic', 'Standard form'];

function escapeCell(value, delimiter) {
  // Flatten first, neutralize second — the reverse order leaves everything
  // after the first newline unguarded. See flattenCell.
  const text = neutralizeFormula(flattenCell(value));
  if (delimiter === '\t') {
    // Tabs would break the row alignment the whole feature depends on, so they
    // are flattened rather than quoted.
    return text.replace(/\t+/g, ' ');
  }
  // Note: quoting alone does NOT stop formula evaluation — Excel strips the
  // quotes and then evaluates. The apostrophe from neutralizeFormula is what
  // actually prevents it.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toTable(rows, { delimiter = '\t', header = true } = {}) {
  const lines = [];
  if (header) lines.push(FULL_COLUMNS.join(delimiter));
  for (const row of rows) {
    lines.push([
      row.original,
      row.standard ?? row.primary,
    ].map((cell) => escapeCell(cell, delimiter)).join(delimiter));
  }
  return lines.join('\n');
}

export function toCsv(rows, options = {}) {
  return toTable(rows, { ...options, delimiter: ',' });
}
