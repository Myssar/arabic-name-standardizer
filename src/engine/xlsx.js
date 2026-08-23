/**
 * Minimal .xlsx reader — no third-party library.
 *
 * An .xlsx file is a ZIP archive of XML parts. Everything needed to read a sheet
 * of names is: the ZIP central directory, DEFLATE decompression (which the
 * platform provides via DecompressionStream), and enough XML scanning to pull
 * values out of two machine-generated documents.
 *
 * Writing this out rather than pulling in SheetJS keeps the extension
 * dependency-free and fully auditable — which matters more than usual for a tool
 * that people paste personal data into. The tradeoff is scope: this reads cell
 * values and nothing else. Formulas are read as their cached values, and styles,
 * number formats, merged cells, charts and macros are ignored. That is
 * sufficient for a column of names and is not a general-purpose xlsx parser.
 */

const textDecoder = new TextDecoder('utf-8');

/**
 * Resource limits.
 *
 * An .xlsx is an untrusted archive from an untrusted party, and every field
 * that drives an allocation here is attacker-controlled: compressed sizes, the
 * inflated stream length, the `r="..."` row number, and the cell reference that
 * becomes a column index. Without ceilings, a small file can ask this code to
 * allocate arbitrarily — a decompression bomb, or a worksheet declaring
 * `<row r="99999999">` that turns into a hundred-million-element array before
 * a single name is read. These are the ceilings, not suggestions.
 */
export const LIMITS = {
  fileBytes: 25 * 1024 * 1024,        // archive as delivered
  inflatedBytes: 120 * 1024 * 1024,   // total across all parts read
  partBytes: 60 * 1024 * 1024,        // any single part
  rows: 200_000,
  columns: 16_384,                    // XFD, Excel's own last column
  cells: 2_000_000,                   // rows x width, the product that matters
  sheets: 64,
};

class XlsxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XlsxError';
  }
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(view) {
  // The EOCD record is 22 bytes plus an optional comment of up to 65535 bytes,
  // so scanning back from the end is the only way to locate it.
  const maxScan = Math.min(view.byteLength, 22 + 0xffff);
  for (let i = view.byteLength - 22; i >= view.byteLength - maxScan; i--) {
    if (i < 0) break;
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/** @returns {Map<string, {method:number, start:number, compressedSize:number}>} */
function readCentralDirectory(buffer) {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new XlsxError('Not a valid .xlsx file (no ZIP end-of-central-directory record).');

  const entryCount = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);

  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new XlsxError('This .xlsx uses the ZIP64 format, which this reader does not support. Copy the cells and paste them instead.');
  }
  if (directoryOffset >= view.byteLength) {
    throw new XlsxError('Corrupt .xlsx: the central directory points outside the file.');
  }

  const entries = new Map();
  let cursor = directoryOffset;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > view.byteLength) {
      throw new XlsxError('Corrupt .xlsx: the central directory is truncated.');
    }
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new XlsxError('Corrupt .xlsx: unexpected data in the ZIP central directory.');
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength > view.byteLength) {
      throw new XlsxError('Corrupt .xlsx: an entry name runs past the end of the file.');
    }
    const name = textDecoder.decode(new Uint8Array(buffer, cursor + 46, nameLength));

    // First definition wins. A duplicate name is the classic ZIP-confusion
    // trick: two entries claiming the same path so that a validator reads one
    // and a consumer reads the other.
    if (!entries.has(name)) entries.set(name, { method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Inflate with a hard ceiling, consuming the stream incrementally.
 *
 * `new Response(stream).arrayBuffer()` cannot be stopped once started, so a
 * decompression bomb would be fully materialized before any size check could
 * run. Reading chunk by chunk means the ceiling is enforced while inflating,
 * and the stream is cancelled the moment it is exceeded.
 */
async function inflate(bytes, budget) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.partBytes || total > budget.remaining) {
        await reader.cancel();
        throw new XlsxError(
          'This .xlsx expands to far more data than a spreadsheet of names should. ' +
          'Refusing to load it.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  budget.remaining -= total;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

async function readEntry(buffer, entry, budget) {
  const view = new DataView(buffer);

  // Every offset below is attacker-controlled. Validate before slicing, because
  // an out-of-range Uint8Array view throws a RangeError that says nothing
  // useful, and an in-range but wrong one silently reads adjacent archive data.
  if (entry.localOffset < 0 || entry.localOffset + 30 > buffer.byteLength) {
    throw new XlsxError('Corrupt .xlsx: local header offset is outside the file.');
  }
  if (view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
    throw new XlsxError('Corrupt .xlsx: bad local file header.');
  }

  // The local header repeats the name and extra fields with its own lengths,
  // which may differ from the central directory's. Trust the local ones here.
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;

  if (start + entry.compressedSize > buffer.byteLength || start < 0) {
    throw new XlsxError('Corrupt .xlsx: entry data extends past the end of the file.');
  }
  if (entry.compressedSize > LIMITS.partBytes) {
    throw new XlsxError('Corrupt .xlsx: a part inside the archive is implausibly large.');
  }

  const bytes = new Uint8Array(buffer, start, entry.compressedSize);

  if (entry.method === 0) {
    if (bytes.byteLength > budget.remaining) {
      throw new XlsxError('This .xlsx contains more data than this reader will load.');
    }
    budget.remaining -= bytes.byteLength;
    return bytes;
  }
  if (entry.method === 8) return inflate(bytes, budget);
  throw new XlsxError(`Unsupported ZIP compression method ${entry.method} in .xlsx.`);
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // fromCodePoint throws on anything outside the Unicode range, and on
      // surrogate halves; an entity is not worth an exception.
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? match;
  });
}

/**
 * Linear tag scanning.
 *
 * The previous implementation used regexes of the shape
 * `/<row\b([^>]*)>([\s\S]*?)<\/row>/g`. Against well-formed input that is
 * fine, but against a crafted worksheet the lazy body scan is quadratic: for
 * every unmatched `<row` the engine reads to the end of the document looking
 * for a close tag that is not there. 50,000 unclosed tags measured at 6.8
 * seconds, and an .xlsx is a ZIP — that payload compresses to a few kilobytes.
 * A malicious file could hang the tab.
 *
 * These scanners are index-based and monotonic: the cursor only ever moves
 * forward past what has been consumed, so the work is linear in the input
 * regardless of how malformed it is.
 */

/** True if `xml` has `<name` at `i` and the name is not merely a prefix. */
function tagStartsAt(xml, i, name) {
  if (!xml.startsWith(`<${name}`, i)) return false;
  const after = xml[i + name.length + 1];
  return after === undefined || after === '>' || after === '/' || /\s/.test(after);
}

/**
 * Walk every `<name ...>...</name>` element at the top level of `xml`,
 * calling `visit(attributes, body)`. Self-closing elements yield an empty body.
 */
function forEachElement(xml, name, visit) {
  const close = `</${name}>`;
  let cursor = 0;

  while (cursor < xml.length) {
    const start = xml.indexOf(`<${name}`, cursor);
    if (start < 0) return;
    if (!tagStartsAt(xml, start, name)) { cursor = start + 1; continue; }

    const attributesEnd = xml.indexOf('>', start);
    if (attributesEnd < 0) return;               // truncated: stop, never rescan

    const attributes = xml.slice(start + name.length + 1, attributesEnd);
    if (xml[attributesEnd - 1] === '/') {
      visit(attributes.replace(/\/$/, ''), '');
      cursor = attributesEnd + 1;
      continue;
    }

    const bodyEnd = xml.indexOf(close, attributesEnd);
    if (bodyEnd < 0) return;                     // unterminated: stop, never rescan
    visit(attributes, xml.slice(attributesEnd + 1, bodyEnd));
    cursor = bodyEnd + close.length;
  }
}

/** Concatenate every <t> in a fragment. Rich text splits one string across runs. */
function textRuns(fragment) {
  let out = '';
  forEachElement(fragment, 't', (_attributes, body) => { out += decodeEntities(body); });
  return out;
}

function firstValue(body) {
  let value;
  forEachElement(body, 'v', (_attributes, inner) => { if (value === undefined) value = inner; });
  return value;
}

function parseSharedStrings(xml) {
  const strings = [];
  forEachElement(xml, 'si', (_attributes, body) => { strings.push(textRuns(body)); });
  return strings;
}

/** "BC12" -> 54 (zero-based). */
export function columnIndex(reference) {
  const letters = /^([A-Za-z]{1,3})/.exec(String(reference ?? ''))?.[1];
  if (!letters) return 0;
  let index = 0;
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  index -= 1;
  // Out of range returns -1 so the caller DROPS the cell. Clamping instead
  // silently folded every reference from EQP to XFD onto the same index, where
  // the later cell overwrote the earlier one — and, worse, let a two-cell
  // worksheet declare a 4096-wide grid that every row then had to be padded to.
  return index < LIMITS.columns ? index : -1;
}

function parseSheet(xml, sharedStrings) {
  const grid = [];
  let stop = false;
  let truncated = false;
  let malformed = false;
  let lastRow = -1;

  /*
   * Cells allocated so far.
   *
   * The product ceiling below runs after the grid exists, which is too late: a
   * sheet whose every row declares one cell in column XFD pads each row to
   * 16,384 entries as it is read. 5,000 such rows — 348 KB of XML, a few KB
   * once deflated inside the .xlsx, so nothing the file-size or inflate budgets
   * would stop — reached 878 MB of heap, and 20,000 rows aborted the tab. The
   * budget has to be spent while building, not audited afterwards.
   */
  let allocated = 0;

  forEachElement(xml, 'row', (rowAttributes, rowBody) => {
    if (stop) return;
    const rowNumber = Number(/\br="(\d+)"/.exec(rowAttributes)?.[1]);
    const cells = [];

    forEachElement(rowBody, 'c', (attributes, body) => {
      const reference = /\br="([A-Za-z]+\d+)"/.exec(attributes)?.[1];
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? 'n';
      const index = reference ? columnIndex(reference) : cells.length;
      if (index < 0 || index >= LIMITS.columns) return;

      let value = '';
      if (type === 's') {
        value = sharedStrings[Number(firstValue(body))] ?? '';
      } else if (type === 'inlineStr') {
        value = textRuns(body);
      } else {
        // 'n', 'str' (formula result), 'b', 'd' — take the cached value as text.
        const raw = firstValue(body);
        value = raw === undefined ? '' : decodeEntities(raw);
      }

      while (cells.length < index) cells.push('');
      cells[index] = value;
    });

    // Sheets omit empty rows entirely; pad so row numbers stay aligned with the
    // spreadsheet the user is looking at. The row number is attacker-controlled,
    // so a declared `r="99999999"` must not become a 100-million-element array.
    const declared = Number.isFinite(rowNumber) ? rowNumber - 1 : grid.length;

    // Row numbers must increase. Duplicated or decreasing ones used to write
    // over an already-populated row, so `r=1,2,2,3` returned three rows and lost
    // a person. Out-of-order rows are appended instead, and reported.
    let target;
    if (declared > lastRow) {
      target = Math.max(0, declared);
    } else {
      target = grid.length;
      malformed = true;
    }

    if (target >= LIMITS.rows) { stop = true; truncated = true; return; }

    allocated += cells.length;
    if (allocated > LIMITS.cells) { stop = true; truncated = true; return; }

    while (grid.length < target) grid.push([]);
    grid[target] = cells;
    lastRow = target;
  });

  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);

  // The ceiling that matters is the PRODUCT. Rows and columns were each capped
  // at a sane value, but nothing capped rows x width, so a 795-byte file
  // declaring one far-right cell and one far-down row asked this loop to
  // materialize 819 million cells and took the tab out of memory. Cap the
  // rectangle, and report it rather than quietly returning a short sheet.
  let keep = grid.length;
  if (width > 0 && grid.length * width > LIMITS.cells) {
    keep = Math.max(1, Math.floor(LIMITS.cells / width));
    truncated = true;
  }

  const rows = grid.slice(0, keep).map((row) => {
    const padded = [...row];
    while (padded.length < width) padded.push('');
    return padded.map((cell) => String(cell ?? '').trim());
  });

  // Reported, never silent. A sheet that stops at the row ceiling looks exactly
  // like a sheet that ended there, and the user would have no way to tell that
  // names were dropped.
  return { grid: rows, truncated, malformed };
}

function parseWorkbookSheets(workbookXml, relsXml) {
  const relationships = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
    if (id && target) relationships.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const name = decodeEntities(/\bname="([^"]*)"/.exec(match[1])?.[1] ?? `Sheet${sheets.length + 1}`);
    const relationshipId = /\br:id="([^"]+)"/.exec(match[1])?.[1];
    const target = relationshipId ? relationships.get(relationshipId) : null;
    const path = target ? `xl/${target}` : null;

    // The relationship target comes from inside the archive and can say
    // anything, including `../../..`. It is only ever used as a key into the
    // in-memory entry map, never as a filesystem path, but constraining it to
    // the worksheets directory means a crafted workbook cannot redirect this
    // reader at some other part of its own archive.
    const safe = path && /^xl\/worksheets\/[\w.-]+\.xml$/.test(path) ? path : null;
    sheets.push({ name, path: safe });
    if (sheets.length >= LIMITS.sheets) break;
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read every worksheet in an .xlsx file.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<{name: string, grid: string[][]}>>}
 */
export async function readXlsx(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new XlsxError('Expected the raw bytes of an .xlsx file.');
  }
  if (buffer.byteLength < 22) {
    throw new XlsxError('Not a valid .xlsx file (too small to be a ZIP archive).');
  }
  if (buffer.byteLength > LIMITS.fileBytes) {
    throw new XlsxError(
      `That file is ${Math.round(buffer.byteLength / 1048576)} MB. This reader stops at ` +
      `${Math.round(LIMITS.fileBytes / 1048576)} MB — copy the name cells and paste them instead.`,
    );
  }

  const entries = readCentralDirectory(buffer);
  // One budget shared across every part, so many medium parts cannot add up to
  // what a single oversized part is not allowed to do.
  const budget = { remaining: LIMITS.inflatedBytes };
  const read = async (path) => {
    const entry = entries.get(path);
    if (!entry) return null;
    return textDecoder.decode(await readEntry(buffer, entry, budget));
  };

  const sharedStringsXml = await read('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : [];

  const workbookXml = await read('xl/workbook.xml');
  const relsXml = await read('xl/_rels/workbook.xml.rels');

  let descriptors = workbookXml && relsXml ? parseWorkbookSheets(workbookXml, relsXml) : [];
  descriptors = descriptors.filter((s) => s.path && entries.has(s.path));

  if (!descriptors.length) {
    // Fall back to whatever worksheet parts exist, in name order.
    descriptors = [...entries.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort()
      .slice(0, LIMITS.sheets)
      .map((path, i) => ({ name: `Sheet${i + 1}`, path }));
  }

  if (!descriptors.length) throw new XlsxError('No worksheets found in this .xlsx file.');

  const sheets = [];
  for (const descriptor of descriptors) {
    const xml = await read(descriptor.path);
    const parsed = xml ? parseSheet(xml, sharedStrings) : { grid: [], truncated: false, malformed: false };
    sheets.push({
      name: descriptor.name,
      grid: parsed.grid,
      truncated: parsed.truncated,
      malformed: parsed.malformed,
    });
  }
  return sheets;
}

export const __internal = { parseSharedStrings, parseSheet, decodeEntities, parseWorkbookSheets };
