// infrastructure/tauri/catalogApi.ts — Lite commands of the project catalog (src-tauri-lite/src/catalog.rs)

import type {
    CatalogCursor, CatalogFilter, CatalogPage, CatalogSort, Facets, HeatCell, ImportResult, Preview, ProfileSpec, RootInfo,
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
    import: (projectRoot: string, source: string, rootName: string, profile: ProfileSpec, importTables: boolean) =>
        call<ImportResult>('catalog_import', { projectRoot, source, rootName, profile, importTables }),
    profiles: (projectRoot: string) => call<ProfileSpec[]>('catalog_profiles', { projectRoot }),
    roots: (projectRoot: string) => call<RootInfo[]>('catalog_roots', { projectRoot }),
    facets: (projectRoot: string, filter: CatalogFilter) => call<Facets>('catalog_facets', { projectRoot, filter }),
    list: (projectRoot: string, filter: CatalogFilter, sort: CatalogSort, after: CatalogCursor | null, limit: number) =>
        call<CatalogPage>('catalog_list', { projectRoot, filter, sort, after, limit }),
    heatmap: (projectRoot: string, filter: CatalogFilter) => call<HeatCell[]>('catalog_heatmap', { projectRoot, filter }),
    recordingPath: (projectRoot: string, recordingId: number) =>
        call<string | null>('catalog_recording_path', { projectRoot, recordingId }),
};

export async function pickFolder(title: string): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const p = await open({ directory: true, multiple: false, title });
    return typeof p === 'string' && p ? p : null;
}
