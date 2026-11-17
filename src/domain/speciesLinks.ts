/**
 * External species references from a taxonomy record
 * (fields `ebird`, `inat`, `xc` written by scripts/build-birdnet-taxonomy.js).
 */
export interface SpeciesLink { label: string; url: string }

/** Links to eBird and iNaturalist for a taxonomy record (empty if it has no IDs). */
export function speciesLinks(record: any): SpeciesLink[] {
  const out: SpeciesLink[] = [];
  if (record?.ebird) out.push({ label: 'eBird', url: `https://ebird.org/species/${encodeURIComponent(record.ebird)}` });
  if (record?.inat) out.push({ label: 'iNaturalist', url: `https://www.inaturalist.org/taxa/${encodeURIComponent(record.inat)}` });
  return out;
}

/** Scientific name to query Xeno-canto with: its own spelling when it differs. */
export function xcSearchName(record: any, sciName: string): string {
  return (record?.xc && String(record.xc).trim()) || sciName;
}
