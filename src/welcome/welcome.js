import { install } from '../i18n/i18n.js';

install(document.getElementById('lang'));

document.getElementById('start').addEventListener('click', () => {
  // Navigate rather than open a tab: the welcome page has served its purpose,
  // and leaving it behind as clutter is worse than replacing it.
  window.location.href = chrome.runtime.getURL('src/bulk/bulk.html');
});
