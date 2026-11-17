/**
 * Species search ranking — pure helpers shared by the suggestion provider
 * and the search widget. No DOM, no taxonomy instance: easy to unit-test.
 *
 * Ranking (lower = better):
 *   1. exact name / scientific name, or a 4/6-letter species code
 *   2. direct match (display name or scientific name) — locally occurring species first
 *   3. match only through another language's common name
 * Within a bucket: match tier, then geo occurrence score, then name.
 */

/** Normalize text for search: lowercase + strip diacritics (ü→u, é→e, etc.) */
export function normalizeSearch(text: unknown) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export const MATCH = {
  NONE: -1,
  EXACT: 0,
  CODE: 1,
  PREFIX: 2,     // display name starts with query
  WORD: 3,       // a word of the display name starts with query
  SCI: 4,        // a word of the scientific name starts with query
  SUBSTRING: 5,  // query anywhere in display or scientific name
  ALT: 6,        // only another language's name matches
} as const;

/**
 * Banding-style species codes from a binomial: first 2+2 and 3+3 letters
 * ("Parus major" → ["pama", "parmaj"]). Empty for non-binomials.
 */
export function speciesCodes(scientificName: unknown): string[] {
  const parts = normalizeSearch(scientificName).replace(/[^a-z ]/g, '').trim().split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) return [];
  const [g, e] = parts;
  return [g.slice(0, 2) + e.slice(0, 2), g.slice(0, 3) + e.slice(0, 3)];
}

const words = (s: string) => s.split(/[\s\-'’]+/).filter(Boolean);

/**
 * How well a normalized query matches a species.
 * @param q        normalized query (see normalizeSearch)
 * @param name     display name (any case)
 * @param sci      scientific name
 * @param altNames common names in other languages
 */
export function matchTier(q: string, name: unknown, sci: unknown, altNames: unknown[] = []): number {
  if (!q) return MATCH.EXACT;
  const n = normalizeSearch(name);
  const s = normalizeSearch(sci);
  if (n === q || (s && s === q)) return MATCH.EXACT;
  if (q.length >= 4 && speciesCodes(sci).includes(q)) return MATCH.CODE;
  if (n.startsWith(q)) return MATCH.PREFIX;
  if (words(n).some((w) => w.startsWith(q))) return MATCH.WORD;
  if (s && words(s).some((w) => w.startsWith(q))) return MATCH.SCI;
  if (n.includes(q) || s.includes(q)) return MATCH.SUBSTRING;
  if (altNames.some((a) => normalizeSearch(a).includes(q))) return MATCH.ALT;
  return MATCH.NONE;
}

/** Geo score at or above which a species counts as "occurs here". */
export const LOCAL_THRESHOLD = 0.03;

export interface RankInput {
  name: string;
  tier: number;
  /** Geo occurrence probability, or null/undefined when unknown. */
  geo?: number | null;
}

/** Sort key bucket: 0 exact/code, 1 direct match, 2 other-language match. */
function bucket(tier: number) {
  if (tier <= MATCH.CODE) return 0;
  return tier === MATCH.ALT ? 2 : 1;
}

/** Comparator for taxonomy results (see module doc for the order). */
export function compareRanked(a: RankInput, b: RankInput) {
  const ba = bucket(a.tier), bb = bucket(b.tier);
  if (ba !== bb) return ba - bb;
  const la = (a.geo ?? 0) >= LOCAL_THRESHOLD ? 0 : 1;
  const lb = (b.geo ?? 0) >= LOCAL_THRESHOLD ? 0 : 1;
  if (la !== lb) return la - lb;
  if (a.tier !== b.tier) return a.tier - b.tier;
  const ga = a.geo ?? 0, gb = b.geo ?? 0;
  if (ga !== gb) return gb - ga;
  return a.name.localeCompare(b.name);
}

/** Split `text` around the first normalized occurrence of `q` (for <mark> highlighting). */
export function splitHighlight(text: string, q: string): [string, string, string] {
  if (!q) return [text, '', ''];
  const i = normalizeSearch(text).indexOf(q);
  // NFD normalization can change length for some scripts; only highlight when lengths agree.
  if (i < 0 || normalizeSearch(text).length !== text.length) return [text, '', ''];
  return [text.slice(0, i), text.slice(i, i + q.length), text.slice(i + q.length)];
}
