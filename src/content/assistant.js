/**
 * The field assistant — a classic content script.
 *
 * Watches editable fields on the page and offers the standard spelling of any
 * Arabic name typed into one. This is the feature that actually solves the
 * problem: someone filling in a university application should not have to stop,
 * open a tool, convert, and come back.
 *
 * WHY NO ENGINE IN HERE. The obvious build imports the transliteration modules
 * directly. Manifest V3 has no module content scripts, so that requires either
 * a second bundled copy of the engine (two transliteration tables drift apart)
 * or publishing the modules as web_accessible_resources — which makes every one
 * of them fetchable by any page on the internet, turning the extension into a
 * fingerprinting beacon. Instead this script sends the text to the service
 * worker and gets a string back. One engine, nothing exposed, and this file
 * stays small enough to audit in a sitting.
 *
 * The rules it follows, because it runs on every site:
 *
 *  1. NEVER change a field on its own. The suggestion is inert until clicked.
 *  2. NEVER read a password, payment or one-time-code field, whatever the page
 *     claims the field is for.
 *  3. NEVER send anything anywhere. There is no network API used in this file.
 *  4. Render into a CLOSED shadow root, so the page cannot read, restyle, hide
 *     or spoof the suggestion. Appending to document.body — as the obvious
 *     implementation does — lets any page style the badge into something else.
 *  5. Do nothing until the field actually contains Arabic letters, so on almost
 *     every page this code reads a value and stops.
 */

(() => {
  'use strict';

  /*
   * No fixed id. A constant id on a node in the page's own DOM is a one-line
   * "does this user run our extension" probe for any site, and a selector any
   * site can use to hide or fade the suggestion. The reference is held in the
   * `host` variable instead; nothing needs to look it up by name.
   */
  const DEBOUNCE_MS = 400;
  const MAX_FIELD_LENGTH = 400;
  const ARABIC = /[؀-ۿݐ-ݿ]/;

  /**
   * Field types this never reads.
   *
   * `type` alone is not enough: a site can style a password box as
   * `type="text"` with `autocomplete="current-password"`, and payment fields are
   * routinely plain text. Anything matching here is skipped before its value is
   * read, not after.
   */
  const BLOCKED_TYPES = new Set([
    'password', 'hidden', 'file', 'number', 'range', 'color', 'date',
    'datetime-local', 'month', 'time', 'week', 'url', 'tel', 'email',
    'checkbox', 'radio', 'submit', 'button', 'image', 'reset',
  ]);

  /*
   * Anchored to the autocomplete token, because that attribute has a defined
   * vocabulary and a prefix match on it is exact.
   */
  const BLOCKED_AUTOCOMPLETE = /^\s*(cc-|current-password|new-password|one-time-code)/i;

  /*
   * Deliberately narrower than "does the word card appear anywhere". The first
   * version blocked any field whose id merely contained `card`, which rejects
   * an ID-card holder's NAME field — exactly the kind of field this tool exists
   * for. Payment fields are matched by the phrases that actually name them.
   */
  const BLOCKED_HINT = new RegExp([
    'password', 'passwd', '\\bpin\\b', '\\botp\\b', '\\bcvv\\b', '\\bcvc\\b',
    'credit.?card', 'debit.?card', 'card.?number', 'card.?holder', 'cardnum',
    '\\biban\\b', '\\bswift\\b', '\\bsecret\\b', 'one-time-code',
    // Arabic. An Arabic-first extension whose refusal list was English-only
    // would happily read a field labelled الرقم السري on an Arabic banking site.
    'كلمة المرور', 'كلمة السر', 'الرقم السري', 'الرقم السرى', 'رمز التحقق',
    'رمز المرور', 'الرمز السري', 'بطاقة الائتمان', 'رقم البطاقة', 'الحساب السري',
  ].join('|'), 'i');

  let enabled = true;
  let strings = { label: 'Standard form', apply: 'Replace', close: 'Close' };
  let rtl = true;
  let host = null;
  let shadow = null;
  let activeField = null;
  let activeValue = '';
  let debounce = null;

  // -------------------------------------------------------------- eligibility

  function attributeHint(element) {
    return ['name', 'id', 'placeholder', 'aria-label', 'autocomplete']
      .map((attribute) => element.getAttribute?.(attribute))
      .filter(Boolean)
      .join(' ');
  }

  /** @returns {string|null} the reason it was skipped, or null when eligible. */
  function skipReason(element) {
    if (!element) return 'no element';
    if (element.disabled) return 'disabled';
    if (element.readOnly) return 'read-only';

    const tag = element.tagName;
    const isInput = tag === 'INPUT';
    if (!isInput && tag !== 'TEXTAREA' && element.isContentEditable !== true) {
      return `not an editable field (<${String(tag).toLowerCase()}>)`;
    }

    if (isInput) {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (BLOCKED_TYPES.has(type)) return `input type="${type}" is never read`;
    }

    const autocomplete = element.getAttribute?.('autocomplete') ?? '';
    if (BLOCKED_AUTOCOMPLETE.test(autocomplete)) {
      return `autocomplete="${autocomplete}" marks this a password or payment field`;
    }

    const hint = attributeHint(element);
    const matched = BLOCKED_HINT.exec(hint);
    if (matched) return `looks like a password or payment field ("${matched[0]}")`;

    return null;
  }

  function isEligibleField(element) {
    return skipReason(element) === null;
  }

  // One line per element, not per keystroke: enough to diagnose, not spam.
  const reported = new WeakSet();
  function reportSkip(element, reason) {
    if (!element || reported.has(element)) return;
    reported.add(element);
    console.debug(TAG, 'ignored a field —', reason, {
      tag: element.tagName,
      type: element.getAttribute?.('type') ?? null,
      name: element.getAttribute?.('name') ?? null,
      id: element.id || null,
    });
  }

  /**
   * Find the field we are actually attached to, right now.
   *
   * React, Vue and Angular — and Google's own search box — replace the input
   * node on re-render, so the element captured when the user started typing is
   * detached a few milliseconds later. Comparing against that stale reference
   * made the suggestion silently never appear on most modern sites: by the time
   * the standardized name came back, the node it belonged to no longer existed.
   *
   * Identity is therefore re-resolved on every use. A replacement node counts
   * as the same field when it is focused, eligible, and still holds the value
   * we converted.
   */
  function resolveField(field, value) {
    if (field?.isConnected) return field;
    const active = document.activeElement;
    if (active && isEligibleField(active) && readValue(active) === value) return active;
    return null;
  }

  function readValue(element) {
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return element.value ?? '';
    return element.innerText ?? element.textContent ?? '';
  }

  /**
   * Write through the native setter so frameworks notice.
   *
   * React and friends install their own `value` descriptor and remember the last
   * value they wrote; assigning `element.value` updates the DOM but leaves that
   * state stale, so the field visibly reverts on the next render. Calling the
   * prototype setter and then dispatching input/change is what makes it stick.
   */
  function writeValue(element, value) {
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      const prototype = element.tagName === 'INPUT'
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    } else {
      element.textContent = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ------------------------------------------------------------------ surface

  /*
   * Anchored under the field, the width of the field, like an autocomplete
   * dropdown — because that is exactly what it is, and every user already knows
   * that pattern.
   *
   * The first version floated a pill ABOVE the field, which covered the page's
   * own heading and read as a jumble: label, name and button all on one line in
   * mixed direction. Sitting under the field, matching its width, with the name
   * on its own line and one obvious action, removes all of that.
   */
  const CSS = `
    .card {
      position: fixed; z-index: 2147483647;
      box-sizing: border-box;
      font-family: "SF Arabic","Geeza Pro","Noto Naskh Arabic","Sakkal Majalla",
                   "Segoe UI",Tahoma,sans-serif;
      background: #ffffff;
      border: 1px solid rgba(60,60,67,.16);
      border-radius: 12px;
      padding: 10px 12px 11px;
      /* One soft shadow, no border colour, no ornament: on someone else's page
         the card should read as a system suggestion, not as our branding. */
      box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 8px 24px -8px rgba(0,0,0,.16);
      overflow: hidden;
    }
    .top {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; margin-bottom: 4px;
    }
    .label { font-size: 12px; color: rgba(60,60,67,.62); white-space: nowrap; }
    .close {
      border: 0; background: none; cursor: pointer;
      color: rgba(60,60,67,.32); font-size: 15px; line-height: 1;
      padding: 0 2px; border-radius: 4px;
    }
    .close:hover { color: #1c1c1e; }
    .row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; direction: ltr;
    }
    .value {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text",
                   "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 17px; font-weight: 600; letter-spacing: -.01em; color: #1c1c1e;
      word-break: break-word; flex: 1; text-align: left;
    }
    .apply {
      flex: 0 0 auto; cursor: pointer;
      font-family: inherit; font-size: 13px; font-weight: 600;
      color: #ffffff; background: #5f7f6e;
      border: 0; border-radius: 9px;
      padding: 6px 15px; white-space: nowrap;
    }
    .apply:hover { background: #4d6a5b; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1c1c1e; border-color: rgba(235,235,245,.18); }
      .label { color: rgba(235,235,245,.62); }
      .value { color: #f2f2f7; }
      .close { color: rgba(235,235,245,.32); }
      .close:hover { color: #f2f2f7; }
    }
  `;



  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    /*
     * The shadow root is closed, so the page cannot read or restyle the card
     * itself — but the HOST is an ordinary page node, and `#id { display:none
     * !important }` would still let a site hide the suggestion, or fade it and
     * paint a look-alike with a different spelling. Pinning the properties that
     * make it visible, with !important, closes that.
     */
    host.style.cssText = 'all:initial';
    for (const [property, value] of [
      ['display', 'block'], ['visibility', 'visible'], ['opacity', '1'],
      ['position', 'static'], ['transform', 'none'], ['filter', 'none'],
      ['clip-path', 'none'], ['pointer-events', 'auto'],
    ]) host.style.setProperty(property, value, 'important');

    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.append(style);
    (document.body ?? document.documentElement).append(host);
  }

  function hide() {
    shadow?.querySelector('.card')?.remove();
    activeField = null;
    detachTracking();
  }

  /**
   * Anchor to the field: same left edge, same width, sitting just under it.
   * Only flips above when there genuinely is no room below, which is the same
   * rule a native autocomplete follows.
   */
  function place(card, field) {
    const rect = field.getBoundingClientRect();
    const width = Math.max(240, Math.min(rect.width, 520));
    card.style.width = `${width}px`;

    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    card.style.left = `${left}px`;

    const height = card.offsetHeight || 66;
    const below = rect.bottom + 6;
    const fitsBelow = below + height <= window.innerHeight - 8;
    card.style.top = `${fitsBelow ? below : Math.max(8, rect.top - height - 6)}px`;
  }

  function show(field, standard) {
    ensureHost();
    shadow.querySelector('.card')?.remove();

    const card = document.createElement('div');
    card.className = 'card';

    const top = document.createElement('div');
    top.className = 'top';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = strings.label;
    if (rtl) label.dir = 'rtl';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.setAttribute('aria-label', strings.close);
    close.textContent = '×';
    top.append(label, close);

    const row = document.createElement('div');
    row.className = 'row';

    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = standard;            // page text is untrusted: never innerHTML

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'apply';
    apply.textContent = strings.apply;
    if (rtl) apply.dir = 'rtl';
    row.append(value, apply);

    // mousedown, not click: clicking moves focus out of the field first, and on
    // some sites blur commits or clears the value before click would ever fire.
    apply.addEventListener('mousedown', (event) => {
      event.preventDefault();
      // Resolve again at the moment of the click: writing into a node that has
      // since been replaced would look like the button simply did nothing.
      const live = resolveField(field, activeValue) ?? field;
      writeValue(live, standard);
      hide();
    });
    close.addEventListener('mousedown', (event) => { event.preventDefault(); hide(); });

    card.append(top, row);
    shadow.append(card);
    activeField = field;
    place(card, field);
    attachTracking();
  }

  /*
   * Repositioning reads getBoundingClientRect and offsetHeight, which forces the
   * page to lay out. Doing that synchronously inside a capture-phase scroll
   * listener means one forced layout per scroll event, on every scrollable
   * element on the page — enough to show up as a "Forced reflow" violation and
   * to make a heavy page feel sticky.
   *
   * Two changes: the work is deferred to the next animation frame and coalesced,
   * so a burst of scroll events costs one layout rather than dozens; and the
   * listeners are only attached while a suggestion is actually on screen, so
   * scrolling a page with no suggestion costs nothing at all.
   */
  let framePending = false;

  function reposition() {
    const card = shadow?.querySelector('.card');
    if (!card) { detachTracking(); return; }
    const live = resolveField(activeField, activeValue);
    if (live) { activeField = live; place(card, live); }
    else hide();
  }

  function scheduleReposition() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => { framePending = false; reposition(); });
  }

  let tracking = false;
  function attachTracking() {
    if (tracking) return;
    tracking = true;
    window.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });
    window.addEventListener('resize', scheduleReposition, { passive: true });
  }
  function detachTracking() {
    if (!tracking) return;
    tracking = false;
    window.removeEventListener('scroll', scheduleReposition, { capture: true });
    window.removeEventListener('resize', scheduleReposition);
  }

  // ------------------------------------------------------------------ wiring

  /*
   * A person types. A script loops.
   *
   * Nobody edits a name field more than a few times a second, so a bucket this
   * size is invisible to a human and caps what a page can extract from the
   * service worker by dispatching events at it. Refilled continuously rather
   * than in fixed windows, so a long editing session never hits a cliff.
   */
  const RATE_CAPACITY = 40;
  const RATE_REFILL_MS = 1500;      // one conversion back every 1.5s
  let tokens = RATE_CAPACITY;
  let lastRefill = Date.now();

  function spendConversion() {
    const now = Date.now();
    tokens = Math.min(RATE_CAPACITY, tokens + (now - lastRefill) / RATE_REFILL_MS);
    lastRefill = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  async function evaluateField(field) {
    const raw = readValue(field);
    if (!raw || raw.length > MAX_FIELD_LENGTH || !ARABIC.test(raw)) { hide(); return; }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'standardize', text: raw });
      if (!response?.standard) {
        warnOnce('no standard form came back for', raw, '- response was', response);
        hide();
        return;
      }

      // Re-resolve rather than comparing identity: the node may have been
      // replaced while the service worker was waking up.
      const target = resolveField(field, raw);
      if (!target) return;
      activeValue = raw;
      show(target, response.standard);
    } catch (error) {
      // Worker asleep, extension reloading, or context invalidated. Leave the
      // page alone rather than leaving a stale suggestion on screen.
      warnOnce('could not reach the extension —', error?.message ?? error,
        '(reload the page after updating the extension)');
      hide();
    }
  }

  function onInput(event) {
    if (!enabled) return;

    /*
     * NOT gated on event.isTrusted.
     *
     * The tempting guard is to ignore synthetic events, since a page can append
     * its own input and dispatch `new Event('input')` in a loop. It was tried
     * and reverted, because it breaks the feature for real people: framework
     * re-renders, on-screen and third-party keyboards, and other extensions all
     * produce untrusted events for text a human really did type, and "the
     * suggestion never appears" is the single most common way this tool has
     * failed its users.
     *
     * What made the guard necessary in the first place was that a conversion
     * used to be written to the approval queue. It no longer is — nothing on
     * this path touches storage — so a page dispatching fake events can make
     * the service worker transliterate strings it chose, read none of the
     * result (the card is in a closed shadow root), and persist nothing. The
     * rate limit below caps the cost of trying.
     */
    if (!spendConversion()) return;

    // composedPath()[0], not event.target. When the field lives inside an open
    // shadow root — any web component, and a growing share of real sites —
    // event.target is retargeted to the HOST element, which is not an input, so
    // every such field was silently ignored. composedPath sees through open
    // roots. Closed roots stay invisible by design and cannot be reached.
    const field = event.composedPath?.()[0] ?? event.target;

    const reason = skipReason(field);
    if (reason) { reportSkip(field, reason); return; }
    clearTimeout(debounce);
    debounce = setTimeout(() => evaluateField(field), DEBOUNCE_MS);
  }

  function onFocusOut(event) {
    const target = event.composedPath?.()[0] ?? event.target;
    if (target !== activeField) return;
    // Delayed so a click on the suggestion still lands; mousedown already
    // prevents the blur, this covers tabbing away.
    setTimeout(() => { if (document.activeElement !== activeField) hide(); }, 150);
  }

  /**
   * One line in the page console, so "it does not work" can be diagnosed
   * without guessing. A content script's console output appears in the page's
   * own DevTools console, which makes this the fastest way for a user to tell
   * whether the script is running at all, whether the service worker answered,
   * and what it answered with.
   */
  const TAG = 'Arabic Name Standardizer:';
  let warned = false;
  function warnOnce(...args) {
    if (warned) return;
    warned = true;
    console.warn(TAG, ...args);
  }

  async function loadSettings() {
    try {
      const settings = await chrome.runtime.sendMessage({ type: 'settings' });
      if (settings) {
        enabled = settings.enabled !== false;
        rtl = settings.language !== 'en';
        strings = settings.strings ?? strings;
      }
    } catch {
      // Defaults are fine; better to run than not to run.
    }
  }

  loadSettings().then(() => {
    console.debug(TAG, `field assistant active (${enabled ? 'on' : 'off'})`);
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.assistEnabled) {
      enabled = changes.assistEnabled.newValue !== false;
      if (!enabled) hide();
    }
    if (changes.language) loadSettings();
  });

  // Only three always-on listeners, all of which return immediately unless the
  // user is actually typing an Arabic name. Scroll and resize are attached only
  // while a suggestion is on screen — see attachTracking.
  document.addEventListener('input', onInput, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); }, true);

  // Exposed for the test harness, which evaluates this file in a sandbox.
  globalThis.__assistantTestHooks = { isEligibleField };
})();
