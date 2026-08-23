/**
 * The user's approved dictionary, and the queue of names still waiting on a
 * decision.
 *
 * Storage layout (chrome.storage.local):
 *   approved: { "<arabic>": "STANDARD FORM" }
 *   pending:  { "<arabic>": { suggested, count, firstSeen } }
 *
 * `pending` is what turns this from a converter into a way of building a shared
 * standard. Every name that had to be resolved by rule rather than by the
 * dictionary is recorded once, so the person maintaining the standard can see
 * exactly which names still need a decision instead of discovering them one
 * spreadsheet at a time.
 */

import { setOverrides, overrideCount } from './dictionary.js';
import { clean } from './normalize.js';
import { toStandard } from './transliterate.js';

export const KEYS = { approved: 'approved', pending: 'pending', assist: 'assistEnabled' };

/** Hard ceilings so a runaway page or a prose-filled sheet cannot grow storage without bound. */
export const MAX_PENDING = 500;
const MAX_PENDING_KEY = 120;   // a full four-part Arabic name fits in ~60
export const MAX_APPROVED = 20_000;

function storage() {
  return globalThis.chrome?.storage?.local ?? null;
}

async function read(key, fallback) {
  const area = storage();
  if (!area) return fallback;
  try {
    const got = await area.get({ [key]: fallback });
    return got[key] ?? fallback;
  } catch {
    return fallback;
  }
}

async function write(key, value) {
  const area = storage();
  if (!area) return false;
  try {
    await area.set({ [key]: value });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Approved entries
// ---------------------------------------------------------------------------

export async function loadApproved() {
  const approved = await read(KEYS.approved, {});
  setOverrides(approved);
  return approved;
}

/**
 * @returns {Promise<{entries: Object, stored: boolean, dropped: number}>}
 *
 * `stored` is not decoration. `write` swallows the quota error, and this used to
 * return the trimmed object regardless — so an import that exceeded the storage
 * quota reported "N names imported", rendered a correct-looking table from the
 * in-memory copy, and was empty again after a reload with no explanation.
 */
export async function saveApproved(approved) {
  const entries = Object.entries(approved);
  const trimmed = Object.fromEntries(entries.slice(0, MAX_APPROVED));
  setOverrides(trimmed);
  const stored = await write(KEYS.approved, trimmed);
  return { entries: trimmed, stored, dropped: Math.max(0, entries.length - MAX_APPROVED) };
}

export async function approve(arabic, standard) {
  const key = clean(arabic);
  // Normalized through the same function the engine uses, so a spelling typed
  // by hand and one produced by the engine are byte-identical.
  const value = toStandard(standard);
  if (!key || !value) return null;

  const approved = await read(KEYS.approved, {});
  approved[key] = value;
  await saveApproved(approved);   // shape ignored here; the caller re-reads

  // Approving a name answers the question the queue was asking.
  const pending = await read(KEYS.pending, {});
  delete pending[key];
  await write(KEYS.pending, pending);

  return approved;
}

export async function remove(arabic) {
  const approved = await read(KEYS.approved, {});
  delete approved[clean(arabic)];
  await saveApproved(approved);
  return approved;
}

/** Keep the in-memory layer in step with edits made in another tab. */
export function watch(onChange) {
  const area = globalThis.chrome?.storage;
  if (!area?.onChanged) return () => {};
  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes[KEYS.approved]) return;
    setOverrides(changes[KEYS.approved].newValue ?? {});
    onChange?.(changes[KEYS.approved].newValue ?? {});
  };
  area.onChanged.addListener(listener);
  return () => area.onChanged.removeListener(listener);
}

export { overrideCount };

// ---------------------------------------------------------------------------
// Pending queue
// ---------------------------------------------------------------------------

/** True when a result was produced by rules rather than by a dictionary entry. */
export function needsApproval(result) {
  return Boolean(result?.ok)
    && result.segments.some((segment) => segment.source === 'rules' || segment.source === 'compound');
}

export async function loadPending() {
  return read(KEYS.pending, {});
}

/**
 * Record names that were resolved by rule. Deliberately fire-and-forget: this
 * runs behind a user typing, and a storage hiccup must never interrupt them.
 */
export async function recordPending(results, timestamp = 0) {
  const candidates = results.filter(needsApproval);
  if (!candidates.length) return null;

  const pending = await read(KEYS.pending, {});
  let changed = false;

  for (const result of candidates) {
    /*
     * A queue entry is a NAME. A spreadsheet cell can hold a hundred kilobytes
     * of prose, and storing it verbatim — key and suggestion both — is how a
     * single import exhausts the storage quota, at which point `write` fails
     * silently and the whole feature stops. Anything longer than a name is not
     * one, so it is skipped rather than truncated into a different string.
     */
    const key = clean(result.cleaned || result.input);
    if (!key || key.length > MAX_PENDING_KEY) continue;
    if (pending[key]) {
      pending[key].count += 1;
      changed = true;
    } else if (Object.keys(pending).length < MAX_PENDING) {
      pending[key] = {
        suggested: String(result.standard ?? '').slice(0, MAX_PENDING_KEY * 3),
        count: 1,
        firstSeen: timestamp,
      };
      changed = true;
    }
  }

  if (changed) await write(KEYS.pending, pending);
  return changed ? pending : null;
}

export async function dismissPending(arabic) {
  const pending = await read(KEYS.pending, {});
  delete pending[clean(arabic)];
  await write(KEYS.pending, pending);
  return pending;
}

export async function clearPending() {
  await write(KEYS.pending, {});
  return {};
}

// ---------------------------------------------------------------------------
// Assistant toggle
// ---------------------------------------------------------------------------

export async function isAssistEnabled() {
  return (await read(KEYS.assist, true)) !== false;
}

export async function setAssistEnabled(enabled) {
  await write(KEYS.assist, Boolean(enabled));
}
