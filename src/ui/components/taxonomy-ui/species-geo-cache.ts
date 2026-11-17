/**
 * Geo occurrence scores for species search ranking.
 *
 * Holds the BirdNET area-model scores for one recording context (coordinates +
 * date). Scores always belong to the current context: a context change clears
 * them, results of an outdated request are discarded (and the current context is
 * requested instead), and failed lookups are not cached, so the next refresh retries.
 */

export interface GeoContext { lat: number; lon: number; date?: Date | string | null }

export interface SpeciesGeoCacheDeps {
  /** Current recording context, or null when no location is known. */
  getContext: () => GeoContext | null;
  /** Scores for a context: scientific name → occurrence probability; null = no area model. */
  fetchScores: (ctx: GeoContext) => Promise<Map<string, number> | null>;
  /** Called after new scores were installed. */
  onUpdate?: () => void;
  onError?: (err: unknown) => void;
}

export function geoContextKey(ctx: GeoContext | null) {
  if (!ctx) return '';
  const day = ctx.date ? new Date(ctx.date).toISOString().slice(0, 10) : '';
  return `${ctx.lat.toFixed(3)},${ctx.lon.toFixed(3)},${day}`;
}

export function createSpeciesGeoCache({ getContext, fetchScores, onUpdate, onError }: SpeciesGeoCacheDeps) {
  let key = '';                      // context the installed scores belong to
  let scores = new Map<string, number>();
  let pending: Promise<void> | null = null;
  let pendingKey = '';

  function score(sci: string) { return scores.get(sci) ?? null; }

  function refresh(): Promise<void> {
    const ctx = getContext();
    const want = geoContextKey(ctx);
    if (want !== key && scores.size) {
      // Never show another context's scores; re-render open dropdowns without them.
      scores = new Map(); key = '';
      onUpdate?.();
    }
    if (!ctx) { key = ''; return Promise.resolve(); }
    if (want === key) return Promise.resolve();
    if (pending && pendingKey === want) return pending;
    pendingKey = want;
    const run = (async () => {
      try {
        const result = await fetchScores(ctx);
        if (geoContextKey(getContext()) !== want) return;   // context changed meanwhile
        scores = result || new Map();
        key = want;                  // also caches "no area model" for this context
        onUpdate?.();
      } catch (err) {
        onError?.(err);              // not cached: the next refresh retries
      }
    })();
    const tracked: Promise<void> = run.finally(() => {
      if (pending === tracked) pending = null;
    }).then(() => {
      // A newer context may have been requested while this one ran.
      if (getContext() && geoContextKey(getContext()) !== want) return refresh();
    });
    pending = tracked;
    return tracked;
  }

  return { score, refresh, get key() { return key; } };
}
