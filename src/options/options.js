import { install } from '../i18n/i18n.js';
import { toStandard } from '../engine/transliterate.js';
import { clean } from '../engine/normalize.js';
import {
  loadApproved, saveApproved, approve, remove,
  loadPending, dismissPending, clearPending,
  isAssistEnabled, setAssistEnabled, MAX_PENDING,
} from '../engine/overrides.js';

const el = (id) => document.getElementById(id);
const ui = {
  lang: el('lang'), assist: el('assist'),
  arabic: el('arabic'), english: el('english'), add: el('add'), addMsg: el('add-msg'),
  count: el('count'), search: el('search'),
  exportBtn: el('export'), importBtn: el('import'), importFile: el('import-file'),
  empty: el('empty'), tableWrap: el('table-wrap'), rows: el('rows'),
  queueWrap: el('queue-wrap'), queueRows: el('queue-rows'),
  queueEmpty: el('queue-empty'), clearQueue: el('clear-queue'),
};

let approved = {};
let pending = {};
let t = {};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function button(labelKey, className, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = t[labelKey] ?? labelKey;
  b.addEventListener('click', onClick);
  return b;
}

function cell(text, className) {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = text;                     // imported data is untrusted
  return td;
}

function renderApproved() {
  const filter = ui.search.value.trim();
  const entries = Object.entries(approved)
    .filter(([arabic]) => !filter || arabic.includes(filter))
    .sort((a, b) => a[0].localeCompare(b[0], 'ar'));

  ui.count.textContent = String(Object.keys(approved).length);

  const any = Object.keys(approved).length > 0;
  ui.empty.hidden = any;
  ui.tableWrap.hidden = !any;
  if (!any) { ui.rows.replaceChildren(); return; }

  const fragment = document.createDocumentFragment();
  for (const [arabic, standard] of entries) {
    const tr = document.createElement('tr');
    tr.append(cell(arabic, 'ar-cell'), cell(standard, 'en-cell'));

    const actions = document.createElement('td');
    actions.className = 'actions';
    actions.append(
      button('options.edit', '', () => {
        ui.arabic.value = arabic;
        ui.english.value = standard;
        ui.arabic.scrollIntoView({ block: 'center' });
        ui.english.focus();
      }),
      button('options.delete', '', async () => {
        approved = await remove(arabic);
        renderApproved();
      }),
    );
    tr.append(actions);
    fragment.append(tr);
  }
  ui.rows.replaceChildren(fragment);
}

function renderPending() {
  const entries = Object.entries(pending)
    .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0));

  const any = entries.length > 0;
  ui.queueWrap.hidden = !any;
  ui.queueEmpty.hidden = any;
  ui.clearQueue.hidden = !any;
  if (!any) { ui.queueRows.replaceChildren(); return; }

  const fragment = document.createDocumentFragment();
  for (const [arabic, info] of entries) {
    const tr = document.createElement('tr');
    tr.append(cell(arabic, 'ar-cell'));

    // The suggested spelling is editable in place: approving is the moment the
    // decision gets made, so it has to be possible to correct it here.
    const suggestion = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = info.suggested ?? '';
    input.dir = 'ltr';
    suggestion.append(input);
    tr.append(suggestion);

    const actions = document.createElement('td');
    actions.className = 'actions';
    actions.append(
      button('options.approve', 'primary', async () => {
        const value = toStandard(input.value);
        if (!value) return;
        approved = await approve(arabic, value);
        pending = await loadPending();
        renderApproved();
        renderPending();
      }),
      button('options.dismiss', '', async () => {
        pending = await dismissPending(arabic);
        renderPending();
      }),
    );
    tr.append(actions);
    fragment.append(tr);
  }
  ui.queueRows.replaceChildren(fragment);
}

function message(text, isError = false) {
  ui.addMsg.hidden = false;
  ui.addMsg.textContent = text;
  ui.addMsg.dataset.error = String(isError);
  setTimeout(() => { ui.addMsg.hidden = true; }, 2600);
}

// ---------------------------------------------------------------------------
// Import and export
// ---------------------------------------------------------------------------

/*
 * The BOM is for Excel, which otherwise reads a UTF-8 CSV as the local codepage
 * and turns every Arabic name into mojibake. JSON is a different matter: the
 * spec says a BOM is not part of the document, and strict parsers reject it, so
 * a file this page exports would not load in the tools people pair it with.
 */
function download(filename, text, mime, { bom = false } = {}) {
  const url = URL.createObjectURL(new Blob([bom ? `﻿${text}` : text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Import accepts the file this page exports, and a two-column CSV.
 *
 * Everything read here is untrusted: keys are cleaned, values are forced
 * through toStandard, and anything that is not a usable pair is skipped rather
 * than stored. An imported file must not be able to write arbitrary keys into
 * extension storage.
 */
function parseImport(text, filename) {
  const out = {};
  if (filename.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [arabic, standard] of Object.entries(parsed)) {
      if (typeof standard !== 'string') continue;
      const key = clean(arabic);
      const value = toStandard(standard);
      if (key && value) out[key] = value;
    }
    return out;
  }

  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [arabic, standard] = line.split(',').map((part) => part.replace(/^"|"$/g, '').trim());
    const key = clean(arabic ?? '');
    const value = toStandard(standard ?? '');
    if (key && value) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

ui.add.addEventListener('click', async () => {
  const arabic = clean(ui.arabic.value);
  const standard = toStandard(ui.english.value);
  if (!arabic || !standard) { message(t['options.invalid'], true); return; }
  approved = await approve(arabic, standard);
  pending = await loadPending();
  ui.arabic.value = '';
  ui.english.value = '';
  message(t['options.saved']);
  renderApproved();
  renderPending();
});

ui.english.addEventListener('keydown', (event) => { if (event.key === 'Enter') ui.add.click(); });
ui.arabic.addEventListener('keydown', (event) => { if (event.key === 'Enter') ui.english.focus(); });
ui.search.addEventListener('input', renderApproved);

ui.exportBtn.addEventListener('click', () => {
  download('arabic-name-dictionary.json', JSON.stringify(approved, null, 2), 'application/json');
});

ui.importBtn.addEventListener('click', () => ui.importFile.click());
ui.importFile.addEventListener('change', async () => {
  const file = ui.importFile.files?.[0];
  ui.importFile.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const incoming = parseImport(text, file.name);
    const added = Object.keys(incoming).length;
    if (!added) { message(t['options.importFailed'], true); return; }
    const saved = await saveApproved({ ...approved, ...incoming });
    approved = saved.entries;
    renderApproved();
    // A failed write leaves the table looking right until the next reload, so
    // the failure has to be said out loud rather than inferred from the count.
    if (!saved.stored) { message(t['options.importFailed'], true); return; }
    message(`${added} ${t['options.imported']}`);
  } catch {
    message(t['options.importFailed'], true);
  }
});

ui.clearQueue.addEventListener('click', async () => {
  pending = await clearPending();
  renderPending();
});

ui.assist.addEventListener('change', () => setAssistEnabled(ui.assist.checked));

(async () => {
  ({ t } = await install(ui.lang, (next) => {
    t = next;
    renderApproved();
    renderPending();
  }));
  ui.assist.checked = await isAssistEnabled();
  approved = await loadApproved();
  pending = await loadPending();
  if (Object.keys(pending).length >= MAX_PENDING) {
    ui.queueEmpty.textContent = `${MAX_PENDING}+`;
  }
  renderApproved();
  renderPending();
})();
