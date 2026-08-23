/**
 * Service worker: context-menu conversion of selected text.
 *
 * The overlay here is injected with chrome.scripting only at the moment the user
 * chooses the context-menu item, under activeTab.
 *
 * Note that from v2 the extension DOES ship a content script on all URLs, for
 * the field assistant — so the old claim that it has no standing page access no
 * longer holds and is not repeated here. What remains true, and is what the
 * privacy claim actually rests on, is that no code in this extension makes a
 * network request of any kind.
 */

import { transliterate } from '../engine/transliterate.js';
import { loadApproved, recordPending, isAssistEnabled } from '../engine/overrides.js';
import { stringsFor, DEFAULT_LANGUAGE } from '../i18n/strings.js';

const MENU_ID = 'arabic-name-normalizer.convert';

const WELCOME_FLAG = 'welcomeShown';

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Convert "%s" to standardized English',
      contexts: ['selection'],
    });
  });

  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    showWelcomeOnce();
  }
});

/**
 * First run only.
 *
 * `reason === 'install'` alone is not sufficient: it also fires when a user
 * removes and reinstalls the extension, and Chrome can replay onInstalled after
 * a profile is restored or synced to a new machine. A persisted flag in
 * chrome.storage.local is what actually makes this once-ever rather than
 * once-per-install-event, and it is checked before opening rather than after so
 * two rapid events cannot both open a tab.
 */
async function showWelcomeOnce() {
  try {
    const stored = await chrome.storage.local.get(WELCOME_FLAG);
    if (stored[WELCOME_FLAG]) return;
    await chrome.storage.local.set({ [WELCOME_FLAG]: Date.now() });
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
  } catch (error) {
    // Never let a failed welcome tab break installation.
    console.warn('Arabic Name Standardizer: could not open the welcome page.', error);
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;

  // Approved spellings must win here too, or the context menu becomes a second
  // source of truth that disagrees with the rest of the extension.
  await loadApproved();
  const result = transliterate(info.selectionText ?? '');
  recordPending([result], 0).catch(() => {});

  // Keep the last conversion so the popup opens showing what the user just did.
  try {
    await chrome.storage.session.set({ lastResult: result });
  } catch {
    // storage.session is unavailable in some contexts; not worth failing over.
  }

  try {
    // No `world` option, so this runs in the ISOLATED world. That is
    // load-bearing, not incidental: it is why the hostile page cannot override
    // attachShadow, Element.prototype.remove or navigator.clipboard underneath
    // this code, and why the mode:'closed' shadow root is unreadable from the
    // page. Adding `world: 'MAIN'` here would invalidate all of that at once.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: renderOverlay,
      args: [result],
    });
  } catch (error) {
    // Injection is blocked on chrome:// pages, the Web Store, and PDF viewers.
    // Fail quietly: the popup still has the result.
    console.warn('Arabic Name Standardizer: overlay injection blocked.', error);
  }
});

/**
 * Injected into the page. Must be fully self-contained — it is serialized and
 * executed in the page's world, so it cannot close over anything from here.
 */
function renderOverlay(result) {
  const HOST_ID = '__arabic_name_normalizer_overlay__';
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'top:16px', 'right:16px',
    'all:initial',
  ].join(';');

  // Shadow DOM so the host page's stylesheet cannot distort the overlay.
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .card {
      font: 14px/1.55 "SF Arabic","Geeza Pro","Noto Naskh Arabic","Segoe UI",Tahoma,sans-serif;
      background: #fff; color: #1c1c1e; width: 320px; padding: 12px 14px;
      border: 1px solid rgba(60,60,67,.16); border-radius: 14px;
      box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 12px 32px -10px rgba(0,0,0,.22);
      box-sizing: border-box;
    }
    .head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
    .title { font-size:12px; color:rgba(60,60,67,.62); }
    .close { cursor:pointer; border:0; background:none; font-size:15px; line-height:1; color:rgba(60,60,67,.32); padding:0 2px; }
    .src { direction:rtl; text-align:right; font-size:15px; color:rgba(60,60,67,.62); margin-bottom:6px; }
    .out {
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","Segoe UI",Arial,sans-serif;
      font-size:20px; font-weight:700; letter-spacing:-.02em; word-break:break-word; color:#1c1c1e;
      direction:ltr; text-align:left;
    }
    .row { display:flex; align-items:center; gap:8px; margin-top:12px; flex-wrap:wrap; }
    button.copy {
      font:inherit; font-size:13px; padding:6px 15px; cursor:pointer;
      border:0; border-radius:9px; background:#5f7f6e; color:#fff; font-weight:600;
    }
    button.copy:hover { background:#4d6a5b; }
    .empty { color:rgba(60,60,67,.62); }
  `;

  const card = document.createElement('div');
  card.className = 'card';

  if (!result.ok) {
    card.innerHTML = `
      <div class="head"><span class="title">Arabic Name Standardizer</span></div>
      <div class="empty">No Arabic name found in the selection.</div>`;
  } else {
    card.innerHTML = `
      <div class="head">
        <span class="title">Arabic Name Standardizer</span>
        <button class="close" aria-label="Close">&times;</button>
      </div>
      <div class="src"></div>
      <div class="out"></div>
      <div class="row"><button class="copy">Copy</button></div>`;

    // textContent everywhere: the selection is untrusted page content.
    card.querySelector('.src').textContent = result.cleaned;
    card.querySelector('.out').textContent = result.standard;

    card.querySelector('.close').addEventListener('click', () => host.remove());
    const copyButton = card.querySelector('.copy');
    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(result.standard);
        copyButton.textContent = 'Copied';
      } catch {
        copyButton.textContent = 'Copy blocked';
      }
      setTimeout(() => { copyButton.textContent = 'Copy'; }, 1500);
    });
  }

  shadow.append(style, card);
  document.documentElement.append(host);

  const dismiss = (event) => {
    if (event.key === 'Escape') {
      host.remove();
      document.removeEventListener('keydown', dismiss);
    }
  };
  document.addEventListener('keydown', dismiss);
  setTimeout(() => host.remove(), 20000);
}

// ---------------------------------------------------------------------------
// Field assistant bridge
// ---------------------------------------------------------------------------

/**
 * The content script has no engine of its own; it asks for a string and gets a
 * string back. Keeping the engine here means one transliteration table rather
 * than two, and — more importantly — it means the engine modules never have to
 * be published as web_accessible_resources, which would make every one of them
 * fetchable by any page on the internet.
 *
 * The listener is deliberately blunt. There is no `externally_connectable`, so
 * only this extension's own contexts can reach it, but the shape and size of
 * every message is still validated: a listener that trusts its input is a
 * listener that will eventually be reached by something unexpected.
 */
const MAX_MESSAGE_TEXT = 400;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'settings') {
    (async () => {
      const { language = DEFAULT_LANGUAGE } = await chrome.storage.local.get({ language: DEFAULT_LANGUAGE });
      const t = stringsFor(language);
      sendResponse({
        enabled: await isAssistEnabled(),
        language,
        strings: {
          label: t['assist.label'],
          apply: t['assist.apply'],
          close: t['assist.close'],
        },
      });
    })().catch(() => sendResponse(null));
    return true;                       // async response
  }

  if (message.type === 'standardize') {
    const text = typeof message.text === 'string' ? message.text.slice(0, MAX_MESSAGE_TEXT) : '';
    if (!text) { sendResponse({ standard: '' }); return false; }
    (async () => {
      await loadApproved();
      const result = transliterate(text);
      /*
       * Deliberately does NOT queue this name for approval.
       *
       * The content script runs on every site, and `readValue` returns the whole
       * value of a textarea or contentEditable region — a webmail draft, a
       * support chat, a medical form. Recording it would mean the extension
       * silently writes what you type on other people's sites to disk, which is
       * both a privacy harm and undisclosed collection. The approval queue is
       * fed only from surfaces where the user deliberately submitted text: the
       * popup and the bulk page.
       */
      sendResponse({ standard: result.ok ? result.standard : '' });
    })().catch(() => sendResponse({ standard: '' }));
    return true;
  }

  return false;
});
