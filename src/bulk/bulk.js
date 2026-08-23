import { install } from '../i18n/i18n.js';
import {
  parseGridDetailed, convertGrid, detectArabicColumn, detectHeader,
  toColumn, toCsv, DISPLAY_LIMIT,
} from '../engine/batch.js';
import { readXlsx, LIMITS } from '../engine/xlsx.js';
import { buildXlsx, resultsToGrid } from '../engine/xlsx-write.js';
import { loadApproved, approve, recordPending } from '../engine/overrides.js';
import { overrideCount } from '../engine/dictionary.js';
import { clean } from '../engine/normalize.js';

/** Text files are read whole into a string, so they need their own ceiling. */
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

const el = (id) => document.getElementById(id);
const ui = {
  app: el('app'), lang: el('lang'),
  navAll: el('nav-all'), navReview: el('nav-review'), navApproved: el('nav-approved'),
  navSaved: el('nav-saved'), navHow: el('nav-how'),
  countAll: el('count-all'), countReview: el('count-review'), countApproved: el('count-approved'),
  viewTitle: el('view-title'), viewSub: el('view-sub'),
  search: el('search'),
  copyColumn: el('copy-column'), downloadCsv: el('download-csv'), downloadXlsx: el('download-xlsx'),
  controls: el('controls'), sheet: el('sheet'), sheetControl: el('sheet-control'),
  column: el('column'), columnControl: el('column-control'),
  header: el('header'), clear: el('clear'), sourceLabel: el('source-label'),
  empty: el('empty'), input: el('input'), file: el('file'), dropBtn: el('drop-btn'),
  drop: el('drop'),
  cols: el('cols'), rows: el('rows'), truncation: el('truncation'), statusNote: el('status-note'),
  inspector: el('inspector'),
  insArabic: el('ins-arabic'), insStandard: el('ins-standard'), insParts: el('ins-parts'),
  insAltWrap: el('ins-alt-wrap'), insAlt: el('ins-alt'), insRemember: el('ins-remember'),
  insSkip: el('ins-skip'), insApprove: el('ins-approve'),
};

let t = {};
let approvedKeys = new Set();
const state = {
  sheets: null, activeSheet: 0, grid: [], sourceLabel: null,
  columnOverride: null, headerOverride: null, warning: null, result: null,
  filter: 'all',            // all | review | approved
  query: '',
  selected: null,           // index into result.rows
};

const MALFORMED = () => t['bulk.malformed'] ?? (
  document.documentElement.lang === 'ar'
    ? 'البيانات فيها علامات اقتباس غير مغلقة أو صفوف غير مرتبة، فقُرئت حرفياً حتى لا يضيع أي اسم. راجع الصفوف قبل استخدامها.'
    : 'This data had unbalanced quotation marks or out-of-order rows, so it was read literally to avoid losing anyone. Check the rows before using them.'
);

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function loadGrid(grid, { sheets = null, sourceLabel = null, warning = null } = {}) {
  Object.assign(state, {
    grid, sheets, sourceLabel, warning,
    columnOverride: null, headerOverride: null, selected: null,
  });
  refresh();
}

const readAs = (file, how) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
  reader[how](file);
});

const megabytes = (bytes) => `${Math.max(1, Math.round(bytes / 1048576))} MB`;

async function loadFile(file) {
  const name = file.name.toLowerCase();
  try {
    // Checked before anything is read: a file this size is not a column of
    // names, and reading it first only to reject it is how a tab runs out of
    // memory.
    const ceiling = name.endsWith('.xlsx') ? LIMITS.fileBytes : MAX_TEXT_BYTES;
    if (file.size > ceiling) {
      throw new Error(`${file.name} — ${megabytes(file.size)} > ${megabytes(ceiling)}`);
    }

    if (name.endsWith('.xlsx')) {
      const sheets = await readXlsx(await readAs(file, 'readAsArrayBuffer'));
      state.activeSheet = Math.max(0, sheets.findIndex((s) => s.grid.some((r) => r.some(Boolean))));
      const active = sheets[state.activeSheet];
      loadGrid(active.grid, {
        sheets,
        sourceLabel: file.name,
        warning: active.truncated
          ? `${file.name}: ${t['bulk.truncated']}`
          : active.malformed ? MALFORMED() : null,
      });
      return;
    }

    if (name.endsWith('.xls')) {
      // The legacy binary format is a different container entirely. Saying so
      // beats half-parsing it into plausible nonsense.
      throw new Error(document.documentElement.lang === 'ar'
        ? 'صيغة .xls القديمة غير مدعومة. احفظ الملف كـ .xlsx أو انسخ الخلايا والصقها هنا.'
        : 'The legacy .xls format is not supported. Save the file as .xlsx, or copy the cells and paste them here.');
    }

    const text = await readAs(file, 'readAsText');
    const { grid, malformed } = parseGridDetailed(text, { assumeCsv: name.endsWith('.csv') });
    ui.input.value = text.length <= 40000 ? text : '';
    loadGrid(grid, {
      sourceLabel: file.name,
      warning: malformed ? MALFORMED() : null,
    });
  } catch (error) {
    showError(error.message);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function refresh() {
  clearError();
  if (state.warning) showError(state.warning);

  if (!state.grid.length) {
    state.result = null;
    state.selected = null;
    ui.controls.hidden = true;
    ui.cols.hidden = true;
    ui.rows.hidden = true;
    ui.truncation.hidden = true;
    ui.empty.hidden = false;
    closeInspector();
    setCounts(0, 0);
    for (const button of [ui.copyColumn, ui.downloadCsv, ui.downloadXlsx]) button.disabled = true;
    ui.viewSub.textContent = '';
    ui.input.focus();
    return;
  }

  const column = state.columnOverride ?? detectArabicColumn(state.grid);
  const hasHeader = state.headerOverride ?? detectHeader(state.grid, column);
  state.result = convertGrid(state.grid, { column, hasHeader });

  // Names resolved by rule go to the approval queue so the shared standard can
  // grow. This page is a surface the user deliberately pasted into, so queuing
  // here is expected; the inline field assistant never does it.
  recordPending(state.result.unlisted, 0).catch(() => {});

  renderControls(column, hasHeader);
  renderRows();
}

function setCounts(total, review) {
  ui.countAll.textContent = String(total);
  ui.countReview.textContent = String(review);
  ui.countApproved.textContent = String(overrideCount());
  ui.navReview.disabled = review === 0;
  if (review === 0 && state.filter === 'review') state.filter = 'all';
}

function renderControls(column, hasHeader) {
  ui.controls.hidden = false;

  const multi = state.sheets && state.sheets.length > 1;
  ui.sheetControl.hidden = !multi;
  if (multi) {
    ui.sheet.replaceChildren();
    state.sheets.forEach((sheet, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${sheet.name} (${sheet.grid.length})`;
      ui.sheet.append(option);
    });
    ui.sheet.value = String(state.activeSheet);
  }

  const width = state.grid[0]?.length ?? 1;
  ui.column.replaceChildren();
  for (let i = 0; i < width; i++) {
    const sample = state.grid.find((row) => (row[i] ?? '').trim() !== '')?.[i] ?? '';
    const option = document.createElement('option');
    option.value = String(i);
    const label = sample.length > 24 ? `${sample.slice(0, 24)}…` : sample;
    option.textContent = label ? `${i + 1} — ${label}` : String(i + 1);
    ui.column.append(option);
  }
  ui.column.value = String(column);
  ui.columnControl.hidden = width === 1;
  ui.header.checked = hasHeader;
  ui.sourceLabel.textContent = state.sourceLabel ?? '';
}

/** The rows this view is currently showing, after filter and search. */
function visibleRows() {
  const rows = state.result?.rows ?? [];
  const query = state.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (state.filter === 'review' && !row.needsReview) return false;
    if (state.filter === 'approved' && !approvedKeys.has(clean(row.original))) return false;
    if (!query) return true;
    return `${row.original} ${row.standard}`.toLowerCase().includes(query);
  });
}

function sourceLabelFor(row) {
  if (row.status === 'blank') return '';
  if (row.status === 'passthrough') return t['bulk.srcAsWritten'];
  if (approvedKeys.has(clean(row.original))) return t['bulk.srcApproved'];
  if (row.needsReview) return t['bulk.srcRules'];
  return t['bulk.srcDictionary'];
}

function renderRows() {
  const all = state.result.rows;
  const review = all.filter((row) => row.needsReview).length;
  setCounts(all.length, review);

  for (const button of [ui.copyColumn, ui.downloadCsv, ui.downloadXlsx]) button.disabled = false;

  const rows = visibleRows();
  ui.empty.hidden = true;
  ui.cols.hidden = false;
  ui.rows.hidden = false;

  ui.viewTitle.textContent = {
    all: t['side.currentList'], review: t['side.needsReview'], approved: t['side.approvedByYou'],
  }[state.filter];
  ui.viewSub.textContent = state.filter === 'all'
    ? `${all.length} ${t['bulk.namesWord']} · ${review} ${t['bulk.needReviewWord']}`
    : `${rows.length} ${t['bulk.namesWord']}`;

  for (const [button, key] of [[ui.navAll, 'all'], [ui.navReview, 'review'], [ui.navApproved, 'approved']]) {
    button.classList.toggle('is-on', state.filter === key);
  }

  const shown = rows.slice(0, DISPLAY_LIMIT);
  const fragment = document.createDocumentFragment();

  for (const row of shown) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'row';
    item.dataset.status = row.status;
    if (row.needsReview) item.dataset.review = 'true';
    item.dataset.index = String(row.index);
    if (state.selected === row.index) item.classList.add('is-selected');

    for (const [className, text] of [
      ['r-num num', String(row.index + 1)],
      ['r-ar', row.original],
      ['r-en', row.standard],
      ['r-src', sourceLabelFor(row)],
    ]) {
      const cell = document.createElement('span');
      cell.className = className;
      cell.textContent = text;                 // untrusted spreadsheet content
      item.append(cell);
    }

    item.addEventListener('click', () => select(row.index));
    fragment.append(item);
  }
  ui.rows.replaceChildren(fragment);

  // Never truncate silently: a list that stops at 500 reads as "that is all".
  ui.truncation.hidden = rows.length <= shown.length;
  if (!ui.truncation.hidden) ui.truncation.textContent = t['bulk.truncated'];
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function rowByIndex(index) {
  return state.result?.rows.find((row) => row.index === index) ?? null;
}

function select(index) {
  const row = rowByIndex(index);
  if (!row || row.status === 'blank') return;
  state.selected = index;
  openInspector(row);
  for (const node of ui.rows.children) {
    node.classList.toggle('is-selected', node.dataset.index === String(index));
  }
}

function openInspector(row) {
  ui.app.classList.add('with-inspector');
  ui.inspector.hidden = false;

  ui.insArabic.textContent = row.original;
  ui.insStandard.value = row.standard;

  // Where each part of the spelling came from. This is the whole reason the
  // panel exists: a name is trustworthy in pieces, not as a whole.
  ui.insParts.replaceChildren();
  for (const segment of row.segments ?? []) {
    const chip = document.createElement('span');
    chip.className = 'ins-part';
    chip.dataset.source = segment.source;
    const arabic = document.createTextNode(`${segment.arabic} → `);
    const latin = document.createElement('b');
    latin.textContent = segment.latin;
    const source = document.createTextNode(` · ${t[`source.${segment.source}`] ?? segment.source}`);
    chip.append(arabic, latin, source);
    ui.insParts.append(chip);
  }

  const variants = (row.variants ?? []).filter((v) => v && v !== row.standard).slice(0, 4);
  ui.insAltWrap.hidden = variants.length === 0;
  ui.insAlt.replaceChildren();
  for (const variant of variants) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = variant;
    button.addEventListener('click', () => { ui.insStandard.value = variant; });
    ui.insAlt.append(button);
  }
}

function closeInspector() {
  ui.app.classList.remove('with-inspector');
  ui.inspector.hidden = true;
  state.selected = null;
  for (const node of ui.rows.children) node.classList.remove('is-selected');
}

/** Apply the inspector's spelling to the row, and optionally to the dictionary. */
async function applyInspector() {
  const row = rowByIndex(state.selected);
  if (!row) return;
  const value = ui.insStandard.value.trim();
  if (!value) return;

  if (ui.insRemember.checked) {
    // Saved once, applied for ever — in every later list and in every field the
    // assistant sees. This is what turns a converter into a standard.
    approvedKeys.add(clean(row.original));
    await approve(row.original, value);
    refresh();
  } else {
    row.standard = value;
    row.needsReview = false;
    renderRows();
  }
  closeInspector();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function showError(text) {
  clearError();
  const box = document.createElement('p');
  box.className = 'notice';
  box.id = 'error';
  box.style.margin = '.6rem 1.1rem 0';
  ui.controls.after(box);
  box.textContent = text;
}
function clearError() { document.getElementById('error')?.remove(); }

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function copy(text, button, doneKey = 'popup.copied') {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = t[doneKey] ?? 'Copied';
  } catch {
    button.textContent = '—';
  }
  setTimeout(() => { button.textContent = original; }, 1400);
}

function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let debounce;
ui.input.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    // Wrapped because this runs detached in a timer: an exception here would
    // otherwise vanish, leaving stale results and no explanation.
    try {
      // The same ceiling the file path enforces. A paste had none at all, so
      // the one route a user can trivially overload was the unguarded one.
      const text = ui.input.value;
      if (text.length > MAX_TEXT_BYTES) {
        throw new Error(`${megabytes(text.length)} > ${megabytes(MAX_TEXT_BYTES)}`);
      }
      const { grid, malformed } = parseGridDetailed(text);
      loadGrid(grid, { warning: malformed ? MALFORMED() : null });
    } catch (error) {
      showError(error.message);
    }
  }, 140);
});

ui.dropBtn.addEventListener('click', () => ui.file.click());
ui.file.addEventListener('change', () => {
  if (ui.file.files?.[0]) loadFile(ui.file.files[0]);
  ui.file.value = '';
});

/*
 * The whole window is the drop target, not a rectangle inside it. Once a list
 * is loaded there is no drop zone left on screen, and hunting for one is the
 * kind of small friction that makes a tool feel unfinished.
 */
let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  ui.drop.hidden = false;
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) ui.drop.hidden = true;
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  ui.drop.hidden = true;
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

ui.sheet.addEventListener('change', () => {
  state.activeSheet = Number(ui.sheet.value);
  state.columnOverride = null;
  state.headerOverride = null;
  state.grid = state.sheets[state.activeSheet].grid;
  refresh();
});
ui.column.addEventListener('change', () => {
  state.columnOverride = Number(ui.column.value);
  state.headerOverride = null;
  refresh();
});
ui.header.addEventListener('change', () => {
  state.headerOverride = ui.header.checked;
  refresh();
});
ui.clear.addEventListener('click', () => {
  ui.input.value = '';
  state.activeSheet = 0;
  state.filter = 'all';
  state.query = '';
  ui.search.value = '';
  loadGrid([]);
});

for (const [button, key] of [[ui.navAll, 'all'], [ui.navReview, 'review'], [ui.navApproved, 'approved']]) {
  button.addEventListener('click', () => {
    if (!state.result) return;
    state.filter = key;
    closeInspector();
    renderRows();
  });
}
ui.navSaved.addEventListener('click', () => chrome.runtime.openOptionsPage());
ui.navHow.addEventListener('click', () => chrome.runtime.openOptionsPage());

ui.search.addEventListener('input', () => {
  state.query = ui.search.value;
  if (state.result) renderRows();
});

ui.insApprove.addEventListener('click', applyInspector);
ui.insSkip.addEventListener('click', closeInspector);
ui.insStandard.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); applyInspector(); }
  if (event.key === 'Escape') closeInspector();
});

ui.copyColumn.addEventListener('click', () => copy(toColumn(visibleRows()), ui.copyColumn));
ui.downloadCsv.addEventListener('click', () =>
  download('standardized-names.csv', toCsv(visibleRows()), 'text/csv;charset=utf-8'));

ui.downloadXlsx.addEventListener('click', () => {
  // A real .xlsx rather than a CSV: the encoding is declared so Arabic cannot
  // arrive as mojibake, and every cell is written as an inline string, so a cell
  // beginning with = is data rather than a formula waiting to run.
  const bytes = buildXlsx(resultsToGrid(visibleRows(), [t['bulk.colArabic'], t['bulk.colStandard']]));
  const url = URL.createObjectURL(new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'standardized-names.xlsx';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

(async () => {
  ({ t } = await install(ui.lang, (next) => {
    t = next;
    if (state.grid.length) refresh();
  }));
  approvedKeys = new Set(Object.keys(await loadApproved()));
  refresh();
})();
