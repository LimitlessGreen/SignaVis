// session-sets.js — persist and restore session label sets

import { normalizeSet } from './annotation-sets.ts';
import { OWN_SOURCE_ID, migrateToOwnSource } from './label-sources.ts';

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
 * Sets are normalized to the set model; the own (editable) set moves to OWN_SOURCE_ID
 * (labels are migrated later, together with the recordings — see migrateToOwnSource).
 * Returns true when restoration occurred, false otherwise.
 */
export function restoreSessionSets(state: any, { rebuild = null as ((() => void) | null) } = {}) {
  try {
    const raw = localStorage.getItem(SESSION_SETS_KEY);
    if (!raw) return false;
    const { sets, activeSetId } = JSON.parse(raw);
    if (!Array.isArray(sets) || !sets.length) return false;
    state.labelSets = new Map(sets.map(([id, s]: any) => [id, normalizeSet(s)]));
    migrateToOwnSource(state.labelSets, [], { preferredId: activeSetId });
    if (state.labelSets.has(OWN_SOURCE_ID)) state.activeSetId = OWN_SOURCE_ID;
    if (typeof rebuild === 'function') rebuild();
    return true;
  } catch (e) {
    return false;
  }
}
