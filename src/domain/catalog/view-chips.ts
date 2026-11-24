// ═══════════════════════════════════════════════════════════════════════
// domain/catalog/view-chips.ts — the active filter as chips
//
// One chip per filter part (dataset, each site/recorder/tag, time of day,
// period, area, …), each removable on its own. Used by the view bar above
// the spaces and for the filter text of a saved dataset. No DOM.
// ═══════════════════════════════════════════════════════════════════════

import {
    bboxLabel, safeColor, sunWindowLabel,
    type CatalogFilter, type DatasetInfo, type Facets,
} from './catalog-types.ts';

export type ChipKind =
    | 'dataset' | 'site' | 'device' | 'tag' | 'path' | 'tod' | 'period' | 'localdays'
    | 'nosite' | 'labels' | 'pos' | 'bbox' | 'status' | 'unassigned' | 'sun';

export interface ViewChip {
    kind: ChipKind;
    /** Field name shown before the value ("Site", "Time", …). */
    field: string;
    label: string;
    /** Facet value id (sites, recorders, tags): one chip each. */
    id?: number;
    /** Colour of the value (sites and recorders as in the tiles, datasets their own). */
    color?: string;
}

/** Colour of a facet value (the library's palette); passed in, the domain has no styles. */
export type ValueColor = (field: 'site' | 'device', name: string) => string;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hh = (h: number | null | undefined) => String(h ?? 0).padStart(2, '0');

export function viewChips(filter: CatalogFilter, facets: Facets | null, datasets: DatasetInfo[], color?: ValueColor): ViewChip[] {
    const tf = filter;
    const named = (ids: number[] | undefined, vals: Facets['sites'] | undefined) =>
        (ids ?? []).map((id) => ({ id, name: vals?.find((v) => v.id === id)?.name ?? `#${id}` }));
    const chips: ViewChip[] = [];
    if (tf.datasetId != null) {
        const d = datasets.find((x) => x.id === tf.datasetId);
        chips.push({ kind: 'dataset', field: 'Dataset', label: d?.name ?? `dataset ${tf.datasetId}`, color: safeColor(d?.color) ?? undefined });
    }
    for (const v of named(tf.siteIds, facets?.sites)) chips.push({ kind: 'site', field: 'Site', label: v.name, id: v.id, color: color?.('site', v.name) });
    for (const v of named(tf.deviceIds, facets?.devices)) chips.push({ kind: 'device', field: 'Recorder', label: v.name, id: v.id, color: color?.('device', v.name) });
    for (const v of named(tf.tagIds, facets?.tags)) chips.push({ kind: 'tag', field: 'Tag', label: `#${v.name}`, id: v.id });
    if (tf.pathContains) chips.push({ kind: 'path', field: 'Path', label: `“${tf.pathContains}”` });
    if (tf.hourFrom != null) chips.push({ kind: 'tod', field: 'Time', label: `${hh(tf.hourFrom)}–${hh(tf.hourTo)} h` });
    if (tf.sun) chips.push({ kind: 'sun', field: 'Sun', label: sunWindowLabel(tf.sun) });
    if (tf.fromMs != null || tf.toMs != null) {
        chips.push({ kind: 'period', field: 'Period', label: `${tf.fromMs != null ? day(tf.fromMs) : '…'} – ${tf.toMs != null ? day(tf.toMs - 86_400_000) : '…'}` });
    }
    if (tf.localDayFrom || tf.localDayTo) chips.push({ kind: 'localdays', field: 'Days', label: `${tf.localDayFrom ?? '…'} – ${tf.localDayTo ?? '…'} (local)` });
    if (tf.noSite) chips.push({ kind: 'nosite', field: 'Site', label: 'none' });
    if (tf.hasLabels != null) chips.push({ kind: 'labels', field: 'Labels', label: tf.hasLabels ? 'some' : 'none' });
    if (tf.hasPosition != null) chips.push({ kind: 'pos', field: 'Position', label: tf.hasPosition ? 'known' : 'unknown' });
    if (tf.bbox) chips.push({ kind: 'bbox', field: 'Area', label: bboxLabel(tf.bbox) });
    if (tf.status) chips.push({ kind: 'status', field: 'Status', label: tf.status });
    if (tf.unassigned) chips.push({ kind: 'unassigned', field: 'Site/recorder', label: 'none' });
    return chips;
}

/** Text of the chips for a dataset's description ("Site Standort 1 · Time 18–06 h"). */
export function chipsText(chips: ViewChip[]): string {
    return chips.map((c) => `${c.field} ${c.label}`).join(' · ');
}

/**
 * The filter without one chip (`'all'`: without any). Returns a new filter and the open dataset
 * that still applies: removing the dataset chip of a static dataset closes it, `'all'` closes any.
 */
export function withoutChip(
    filter: CatalogFilter, activeDs: number | null, active: DatasetInfo | null,
    kind: ChipKind | 'all', id: number | null = null,
): { filter: CatalogFilter; activeDs: number | null } {
    if (kind === 'all') return { filter: {}, activeDs: null };
    const f: CatalogFilter = structuredClone(filter);
    const drop = (ids: number[] | undefined) => (ids ?? []).filter((x) => x !== id);
    switch (kind) {
        case 'dataset': f.datasetId = null; if (active?.kind === 'static') activeDs = null; break;
        case 'sun': f.sun = null; break;
        case 'site': f.siteIds = drop(f.siteIds); break;
        case 'device': f.deviceIds = drop(f.deviceIds); break;
        case 'tag': f.tagIds = drop(f.tagIds); break;
        case 'path': f.pathContains = null; break;
        case 'tod': f.hourFrom = null; f.hourTo = null; break;
        case 'period': f.fromMs = null; f.toMs = null; break;
        case 'localdays': f.localDayFrom = null; f.localDayTo = null; break;
        case 'nosite': f.noSite = false; break;
        case 'labels': f.hasLabels = null; break;
        case 'pos': f.hasPosition = null; break;
        case 'bbox': f.bbox = null; break;
        case 'status': f.status = null; break;
        case 'unassigned': f.unassigned = false; break;
    }
    return { filter: f, activeDs };
}
