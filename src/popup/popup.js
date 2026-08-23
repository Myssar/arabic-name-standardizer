import { install } from '../i18n/i18n.js';
import { transliterate } from '../engine/transliterate.js';
import { entryCount, overrideCount } from '../engine/dictionary.js';
import { loadApproved, recordPending } from '../engine/overrides.js';

const el = (id) => document.getElementById(id);
const ui = {
  lang: el('lang'), input: el('input'), result: el('result'),
  standard: el('standard'), copy: el('copy'),
  placeholder: el('placeholder'), count: el('count'),
  bulk: el('bulk'), options: el('options'),
};

let t = {};

function render(result) {
  if (!result?.ok || !result.standard) {
    ui.result.hidden = true;
    ui.placeholder.hidden = false;
    return;
  }
  ui.placeholder.hidden = true;
  ui.result.hidden = false;
  ui.standard.textContent = result.standard;

  // Anything the dictionary could not confirm is queued for approval on the
  // options page. Nothing about that appears here: the point of the tool is to
  // hand back one spelling, and hedging in the interface invites the user to
  // invent a second one.
  recordPending([result], 0).catch(() => {});
}

let timer;
ui.input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => render(transliterate(ui.input.value)), 110);
});

ui.copy.addEventListener('click', async () => {
  const original = t['popup.copy'];
  try {
    await navigator.clipboard.writeText(ui.standard.textContent);
    ui.copy.textContent = t['popup.copied'];
  } catch {
    ui.copy.textContent = '—';
  }
  setTimeout(() => { ui.copy.textContent = original; }, 1300);
});

ui.bulk.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/bulk/bulk.html') });
  window.close();
});

ui.options.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

(async () => {
  ({ t } = await install(ui.lang, (next) => {
    t = next;
    if (ui.input.value) render(transliterate(ui.input.value));
  }));

  await loadApproved();
  ui.count.textContent = String(entryCount() + overrideCount());

  // Reopen showing whatever the context menu last converted, so the two entry
  // points feel like one tool.
  try {
    const { lastResult } = await chrome.storage.session.get('lastResult');
    if (lastResult?.ok) {
      ui.input.value = lastResult.cleaned;
      render(lastResult);
    }
  } catch {
    // First run, or session storage unavailable.
  }
})();
