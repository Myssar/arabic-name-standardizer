/**
 * Applies the string table to a page and keeps the choice in sync.
 *
 * Text is written with textContent and attributes with setAttribute, never
 * innerHTML — the strings are ours, but making the translation layer incapable
 * of injecting markup means it stays safe when someone later adds a language by
 * pasting text from somewhere else.
 */

import { stringsFor, DEFAULT_LANGUAGE, LANGUAGES } from './strings.js';

const STORAGE_KEY = 'language';

export async function getLanguage() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    return LANGUAGES.includes(value) ? value : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export async function setLanguage(language) {
  if (!LANGUAGES.includes(language)) return;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: language });
  } catch {
    // Non-fatal: the page still switches for this session.
  }
}

/** Translate every [data-i18n] node in `root` and set document direction. */
export function apply(language, root = document) {
  const t = stringsFor(language);

  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n;
    // A missing key shows as the key itself. Silent blanks hide the mistake.
    node.textContent = t[key] ?? key;
  }

  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    // Format: "placeholder:bulk.pastePlaceholder, title:popup.copy"
    for (const pair of node.dataset.i18nAttr.split(',')) {
      const [attribute, key] = pair.split(':').map((s) => s.trim());
      if (attribute && key) node.setAttribute(attribute, t[key] ?? key);
    }
  }

  if (root === document) {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    const title = document.querySelector('title[data-i18n]');
    if (title) document.title = t[title.dataset.i18n] ?? document.title;
  }

  return t;
}

/**
 * Wire an AR/EN toggle. Returns the translator for the active language and
 * calls `onChange` with a fresh one whenever the user switches.
 */
export async function install(container, onChange) {
  let language = await getLanguage();
  let t = apply(language);

  if (container) {
    container.replaceChildren();
    for (const code of LANGUAGES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = code === 'ar' ? 'العربية' : 'English';
      button.setAttribute('aria-pressed', String(code === language));
      button.addEventListener('click', async () => {
        language = code;
        await setLanguage(code);
        t = apply(language);
        for (const sibling of container.children) {
          sibling.setAttribute('aria-pressed', String(sibling === button));
        }
        onChange?.(t, language);
      });
      container.append(button);
    }
  }

  return { t, language };
}
