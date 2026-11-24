// infrastructure/tauri/catalogApi.ts — Lite commands of the project catalog (src-tauri-lite/src/catalog.rs)

import type {
    CatalogCursor, CatalogFilter, CatalogPage, CatalogSort, Facets, HashProgress, HeatCell, ImportResult, Integrity, Preview, ProfileSpec, RootInfo, Suggestion, SiteInfo, ClockReport, ClockPeriod, ClockShift, DeviceInfo,
    SiteFields, DeviceFields, DeploymentInfo, DeriveReport, TagInfo, Selection, BulkEdit, BulkReport, RecordingDetail, CatalogStats,
    MapData, TrackInfo, MatchReport, TrackImport, DatasetInfo, DatasetEdit, Membership,
} from '../../domain/catalog/catalog-types.ts';
import type { ThumbResult, ThumbSpec } from '../../domain/catalog/thumb-grid.ts';

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeP: Promise<Invoke> | null = null;
const call = async <T>(cmd: string, args?: Record<string, unknown>) => {
    invokeP ??= import('@tauri-apps/api/core').then((m) => m.invoke as Invoke);
    return (await invokeP)<T>(cmd, args);
};

export const catalogApi = {
    preview: (source: string, profile: ProfileSpec, refresh = false) =>
        call<Preview>('catalog_preview', { source, profile, refresh }),
    suggest: (source: string, refresh = false) => call<Suggestion[]>('catalog_suggest', { source, refresh }),
    import: (projectRoot: string, source: string, rootName: string, profile: ProfileSpec, importTables: boolean) =>
        call<ImportResult>('catalog_import', { projectRoot, source, rootName, profile, importTables }),
    profiles: (projectRoot: string) => call<ProfileSpec[]>('catalog_profiles', { projectRoot }),
    roots: (projectRoot: string) => call<RootInfo[]>('catalog_roots', { projectRoot }),
    /** The project has a catalog (asking does not create one, unlike the other calls). */
    exists: (projectRoot: string) => call<boolean>('catalog_exists', { projectRoot }),
    facets: (projectRoot: string, filter: CatalogFilter) => call<Facets>('catalog_facets', { projectRoot, filter }),
    list: (projectRoot: string, filter: CatalogFilter, sort: CatalogSort, after: CatalogCursor | null, limit: number) =>
        call<CatalogPage>('catalog_list', { projectRoot, filter, sort, after, limit }),
    heatmap: (projectRoot: string, filter: CatalogFilter) => call<HeatCell[]>('catalog_heatmap', { projectRoot, filter }),
    hashStart: (projectRoot: string, full = false) => call<void>('catalog_hash_start', { projectRoot, full }),
    hashCancel: () => call<void>('catalog_hash_cancel'),
    integrity: (projectRoot: string) => call<Integrity>('catalog_integrity', { projectRoot }),
    /** Subscribe to hashing progress; returns an unsubscribe function. */
    onHashProgress: async (cb: (p: HashProgress) => void): Promise<() => void> => {
        const { listen } = await import('@tauri-apps/api/event');
        return listen<HashProgress>('lite-catalog-hash', (e) => cb(e.payload));
    },
    sites: (projectRoot: string) => call<SiteInfo[]>('catalog_sites', { projectRoot }),
    setSiteClock: (projectRoot: string, siteId: number, clock: string) =>
        call<ClockReport>('catalog_set_site_clock', { projectRoot, siteId, clock }),
    devices: (projectRoot: string) => call<DeviceInfo[]>('catalog_devices', { projectRoot }),
    clockShifts: (projectRoot: string) => call<ClockShift[]>('catalog_clock_shifts', { projectRoot }),
    setDeviceClocks: (projectRoot: string, deviceId: number, periods: ClockPeriod[]) =>
        call<ClockReport>('catalog_set_device_clocks', { projectRoot, deviceId, periods }),
    siteFields: (projectRoot: string, siteId: number) => call<SiteFields>('catalog_site_fields', { projectRoot, siteId }),
    saveSite: (projectRoot: string, siteId: number | null, fields: SiteFields) => call<number>('catalog_save_site', { projectRoot, siteId, fields }),
    deviceFields: (projectRoot: string, deviceId: number) => call<DeviceFields>('catalog_device_fields', { projectRoot, deviceId }),
    saveDevice: (projectRoot: string, deviceId: number | null, fields: DeviceFields) => call<number>('catalog_save_device', { projectRoot, deviceId, fields }),
    deleteEntity: (projectRoot: string, table: 'site' | 'device', id: number) => call<void>('catalog_delete_entity', { projectRoot, table, id }),
    merge: (projectRoot: string, table: 'site' | 'device', from: number[], into: number) => call<number>('catalog_merge', { projectRoot, table, from, into }),
    deriveDeployments: (projectRoot: string, gapDays: number) => call<DeriveReport>('catalog_derive_deployments', { projectRoot, gapDays }),
    deployments: (projectRoot: string) => call<DeploymentInfo[]>('catalog_deployments', { projectRoot }),
    setDeploymentNotes: (projectRoot: string, id: number, notes: string | null) => call<void>('catalog_set_deployment_notes', { projectRoot, id, notes }),
    tags: (projectRoot: string) => call<TagInfo[]>('catalog_tags', { projectRoot }),
    metaKeys: (projectRoot: string) => call<[string, number][]>('catalog_meta_keys', { projectRoot }),
    bulkEdit: (projectRoot: string, selection: Selection, edit: BulkEdit) => call<BulkReport>('catalog_bulk_edit', { projectRoot, selection, edit }),
    recordingDetail: (projectRoot: string, recordingId: number) => call<RecordingDetail>('catalog_recording_detail', { projectRoot, recordingId }),
    stats: (projectRoot: string, filter: CatalogFilter) => call<CatalogStats>('catalog_stats', { projectRoot, filter }),
    importTrack: (projectRoot: string, path: string, deviceId: number | null, selection: Selection, maxGapS: number) =>
        call<TrackImport>('catalog_import_track', { projectRoot, path, name: null, deviceId, selection, maxGapS }),
    matchTrack: (projectRoot: string, trackId: number, selection: Selection, maxGapS: number) =>
        call<MatchReport>('catalog_match_track', { projectRoot, trackId, selection, maxGapS }),
    tracks: (projectRoot: string) => call<TrackInfo[]>('catalog_tracks', { projectRoot }),
    trackLine: (projectRoot: string, trackId: number) => call<[number, number][]>('catalog_track_line', { projectRoot, trackId }),
    deleteTrack: (projectRoot: string, trackId: number) => call<void>('catalog_delete_track', { projectRoot, trackId }),
    map: (projectRoot: string, filter: CatalogFilter, cellDeg: number) => call<MapData>('catalog_map', { projectRoot, filter, cellDeg }),
    thumbs: (projectRoot: string, ids: number[], spec: ThumbSpec) => call<ThumbResult[]>('catalog_thumbs', { projectRoot, ids, spec }),
    clearThumbs: (projectRoot: string) => call<number>('catalog_thumbs_clear', { projectRoot }),
    recordingPath: (projectRoot: string, recordingId: number) =>
        call<string | null>('catalog_recording_path', { projectRoot, recordingId }),
    datasets: (projectRoot: string) => call<DatasetInfo[]>('catalog_datasets', { projectRoot }),
    createDataset: (projectRoot: string, kind: 'static' | 'filter', dataset: DatasetEdit) =>
        call<number>('catalog_create_dataset', { projectRoot, kind, dataset }),
    updateDataset: (projectRoot: string, id: number, dataset: DatasetEdit) => call<void>('catalog_update_dataset', { projectRoot, id, dataset }),
    deleteDataset: (projectRoot: string, id: number) => call<void>('catalog_delete_dataset', { projectRoot, id }),
    datasetAdd: (projectRoot: string, id: number, selection: Selection, range: [number, number] | null = null) =>
        call<number>('catalog_dataset_add', { projectRoot, id, selection, range }),
    datasetRemove: (projectRoot: string, id: number, selection: Selection) => call<number>('catalog_dataset_remove', { projectRoot, id, selection }),
    duplicateDataset: (projectRoot: string, id: number, name: string, freeze: boolean) =>
        call<number>('catalog_duplicate_dataset', { projectRoot, id, name, freeze }),
    datasetRemoveRange: (projectRoot: string, id: number, recordingId: number, range: [number, number]) =>
        call<number>('catalog_dataset_remove_range', { projectRoot, id, recordingId, range }),
    recordingDatasets: (projectRoot: string, recordingId: number) => call<Membership[]>('catalog_recording_datasets', { projectRoot, recordingId }),
};

export async function pickFile(title: string, extensions: string[]): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const p = await open({ directory: false, multiple: false, title, filters: [{ name: extensions.join(', '), extensions }] });
    return typeof p === 'string' && p ? p : null;
}

export async function pickFolder(title: string): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const p = await open({ directory: true, multiple: false, title });
    return typeof p === 'string' && p ? p : null;
}
