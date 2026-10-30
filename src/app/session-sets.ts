// session-sets.js — persist and restore session label sets

import { normalizeSet, ensureOwnSet } from './annotation-sets.ts';

const SESSION_SETS_KEY = 'signavis.session-sets.v1';

/** Persist session sets from `state` into localStorage. */
export function saveSessionSets(state: any) {
  try {
    localStorage.setItem(SESSION_SETS_KEY, JSON.stringify({
      sets: [...(state.labelSets || new Map()).entries()],
      activeSetId: state.activeSetId,
    }));
  } catch (e) {
    // ignore storage errors
  }
}

/**
 * Restore session sets into `state` from localStorage.
 * Sets are normalized to the set model; the own (editable) set becomes `state.ownSetId`.
 * Returns true when restoration occurred, false otherwise.
 */
export function restoreSessionSets(state: any, { rebuild = null as ((() => void) | null) } = {}) {
  try {
    const raw = localStorage.getItem(SESSION_SETS_KEY);
    if (!raw) return false;
    const { sets, activeSetId } = JSON.parse(raw);
    if (!Array.isArray(sets) || !sets.length) return false;
    state.labelSets = new Map(sets.map(([id, s]: any) => [id, normalizeSet(s)]));
    const ownId = ensureOwnSet(state.labelSets, activeSetId, () => null);
    if (ownId) {
      state.ownSetId = ownId;
      state.activeSetId = ownId;
    }
    if (typeof rebuild === 'function') rebuild();
    return true;
  } catch (e) {
    return false;
  }
}
