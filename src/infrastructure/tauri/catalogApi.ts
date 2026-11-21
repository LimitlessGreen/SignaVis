// infrastructure/tauri/catalogApi.ts — Lite commands of the project catalog (src-tauri-lite/src/catalog.rs)

import type {
    CatalogCursor, CatalogFilter, CatalogPage, CatalogSort, Facets, HashProgress, HeatCell, ImportResult, Integrity, Preview, ProfileSpec, RootInfo, Suggestion, SiteInfo, ClockReport, ClockPeriod, ClockShift, DeviceInfo,
    SiteFields, DeviceFields, DeploymentInfo, DeriveReport, TagInfo, Selection, BulkEdit, BulkReport, RecordingDetail, CatalogStats,
} from '../../domain/catalog/catalog-types.ts';

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
    recordingPath: (projectRoot: string, recordingId: number) =>
        call<string | null>('catalog_recording_path', { projectRoot, recordingId }),
};

export async function pickFolder(title: string): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const p = await open({ directory: true, multiple: false, title });
    return typeof p === 'string' && p ? p : null;
}
