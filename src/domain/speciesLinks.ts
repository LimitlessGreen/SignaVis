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

/**
 * Names to query Xeno-canto with, in order: the taxonomy's own name first,
 * then Xeno-canto's spelling as a fallback. The BirdNET taxonomy's xc_name is
 * sometimes outdated or misspelled (e.g. "Falco longipennisr"), so it must not
 * replace a name that already finds recordings.
 */
export function xcSearchNames(record: any, sciName: string): string[] {
  const supplied = String(sciName || '').trim();
  const canonical = record?.s ? String(record.s).trim() : '';
  const xc = record?.xc ? String(record.xc).trim() : '';
  // Canonical name first (the supplied one may be an older synonym), XC spelling last.
  return [...new Set([canonical, supplied, xc].filter(Boolean))];
}
