// session-sets.js — persist and restore session label sets

const SESSION_SETS_KEY = 'signavis.session-sets.v1';

/** Persist session sets from `state` into localStorage. */
export function saveSessionSets(state) {
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
 * Returns true when restoration occurred, false otherwise.
 */
export function restoreSessionSets(state, { rebuild = null } = {}) {
  try {
    const raw = localStorage.getItem(SESSION_SETS_KEY);
    if (!raw) return false;
    const { sets, activeSetId } = JSON.parse(raw);
    if (!Array.isArray(sets) || !sets.length) return false;
    state.labelSets = new Map(sets);
    // Prefer explicit activeSetId when valid
    if (activeSetId && state.labelSets.has(activeSetId)) {
      state.activeSetId = activeSetId;
      state._sessionSetId = activeSetId;
    } else {
      // Fallback: use first restored set id as the session set id
      const first = (sets && sets.length && sets[0] && sets[0][0]) ? sets[0][0] : null;
      if (first && state.labelSets.has(first)) {
        if (!state.activeSetId) state.activeSetId = first;
        state._sessionSetId = first;
      }
    }
    if (typeof rebuild === 'function') rebuild();
    return true;
  } catch (e) {
    return false;
  }
}
