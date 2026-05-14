// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/MockCorpusAdapter.ts
//
// In-memory mock implementation of every TauriCorpusAdapter function.
// Activated automatically in browser/dev mode (no Tauri context).
// Provides realistic bioaccoustic data for UI development and testing.
// ═══════════════════════════════════════════════════════════════════════

import type {
    Dataset,
    Recording,
    SavedView,
} from '../../domain/corpus/types.ts';

import type {
    ImportResult,
    RecordingListArgs,
    BirdnetRunArgs,
    BirdnetRunSummary,
    DatasetAddFieldArgs,
    DatasetSaveViewArgs,
    AnalysisRunRecord,
    BirdnetDonePayload,
} from './TauriCorpusAdapter.ts';

// ── In-memory store ───────────────────────────────────────────────────

let datasets: Dataset[] = buildDatasets();
let recordings: Map<string, Recording[]> = buildRecordings();

function now(): number { return Date.now(); }
function uuid(): string { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ── Datasets ──────────────────────────────────────────────────────────

export async function datasetCreate(name: string, description?: string): Promise<Dataset> {
    const ds: Dataset = {
        id: uuid(),
        name, description,
        mediaType: 'audio',
        createdAt: now(), updatedAt: now(),
        recordingCount: 0,
        fieldSchema: [],
        savedViews: [],
        analysisRuns: {},
        knownTags: [],
    };
    datasets.push(ds);
    recordings.set(ds.id, []);
    return ds;
}

export async function datasetList(): Promise<Dataset[]> {
    return [...datasets].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function datasetGet(id: string): Promise<Dataset> {
    const ds = datasets.find((d) => d.id === id);
    if (!ds) throw new Error(`Dataset not found: ${id}`);
    return ds;
}

export async function datasetDelete(id: string): Promise<void> {
    datasets = datasets.filter((d) => d.id !== id);
    recordings.delete(id);
}

export async function datasetUpdateMeta(id: string, name?: string, description?: string): Promise<Dataset> {
    const ds = await datasetGet(id);
    if (name) ds.name = name;
    if (description !== undefined) ds.description = description;
    ds.updatedAt = now();
    return ds;
}

export async function datasetAddFieldToSchema(args: DatasetAddFieldArgs): Promise<Dataset> {
    const ds = await datasetGet(args.datasetId);
    if (!ds.fieldSchema.some((f) => f.name === args.fieldName)) {
        ds.fieldSchema.push({
            name: args.fieldName,
            kind: args.fieldKind as never,
            description: args.description,
            group: args.group,
        });
    }
    ds.updatedAt = now();
    return ds;
}

export async function datasetSaveView(args: DatasetSaveViewArgs): Promise<Dataset> {
    const ds = await datasetGet(args.datasetId);
    ds.savedViews = ds.savedViews.filter((v) => v.name !== args.name);
    ds.savedViews.push({ name: args.name, stages: args.stages as never[], createdAt: now() });
    ds.updatedAt = now();
    return ds;
}

export async function datasetDeleteView(datasetId: string, name: string): Promise<Dataset> {
    const ds = await datasetGet(datasetId);
    ds.savedViews = ds.savedViews.filter((v) => v.name !== name);
    ds.updatedAt = now();
    return ds;
}

export async function datasetListRuns(datasetId: string): Promise<AnalysisRunRecord[]> {
    const ds = await datasetGet(datasetId);
    return Object.values(ds.analysisRuns ?? {}) as unknown as AnalysisRunRecord[];
}

export async function datasetGetRun(datasetId: string, jobId: string): Promise<AnalysisRunRecord | null> {
    const ds = await datasetGet(datasetId);
    return ((ds.analysisRuns ?? {})[jobId] as unknown as AnalysisRunRecord) ?? null;
}

// ── Recordings ────────────────────────────────────────────────────────

export async function recordingList(args: RecordingListArgs): Promise<Recording[]> {
    const recs = recordings.get(args.datasetId) ?? [];
    let filtered = recs;
    if (args.tagFilter) {
        filtered = filtered.filter((r) => r.tags.includes(args.tagFilter!));
    }
    const offset = args.offset ?? 0;
    const limit  = args.limit ?? 100;
    return filtered.slice(offset, offset + limit);
}

export async function recordingGet(id: string): Promise<Recording> {
    for (const recs of recordings.values()) {
        const r = recs.find((r) => r.id === id);
        if (r) return r;
    }
    throw new Error(`Recording not found: ${id}`);
}

export async function recordingSetTags(id: string, tags: string[]): Promise<void> {
    for (const recs of recordings.values()) {
        const r = recs.find((r) => r.id === id);
        if (r) { r.tags = tags; return; }
    }
}

export async function recordingDelete(id: string): Promise<void> {
    for (const [dsId, recs] of recordings.entries()) {
        const idx = recs.findIndex((r) => r.id === id);
        if (idx !== -1) {
            recs.splice(idx, 1);
            const ds = datasets.find((d) => d.id === dsId);
            if (ds) ds.recordingCount = recs.length;
            return;
        }
    }
}

export async function recordingSetField(id: string, fieldName: string, value: unknown): Promise<void> {
    for (const recs of recordings.values()) {
        const r = recs.find((r) => r.id === id);
        if (r) { (r.fields as Record<string, unknown>)[fieldName] = value; return; }
    }
}

export async function recordingCount(datasetId: string): Promise<number> {
    return (recordings.get(datasetId) ?? []).length;
}

export async function recordingDistinctValues(datasetId: string, fieldName: string): Promise<string[]> {
    const recs = recordings.get(datasetId) ?? [];
    const vals = new Set<string>();
    for (const r of recs) {
        const v = (r.fields as Record<string, unknown>)[fieldName];
        if (typeof v === 'string') vals.add(v);
    }
    return [...vals].sort();
}

export async function recordingImportFolder(): Promise<ImportResult> {
    return { imported: 0, skipped: 0, errors: 0, errorMessages: ['Demo mode: import not available.'], durationMs: 0 };
}

// ── BirdNET (simulated) ───────────────────────────────────────────────

export async function datasetRunBirdnet(args: BirdnetRunArgs): Promise<BirdnetRunSummary> {
    const jobId = uuid();
    const recs  = recordings.get(args.datasetId) ?? [];

    // Simulate async progress via events
    simulateBirdnetRun(jobId, args.datasetId, args.fieldName, recs.slice(0, 5));

    return { jobId, datasetId: args.datasetId, fieldName: args.fieldName, processed: 0, errors: 0, skipped: 0 };
}

function simulateBirdnetRun(
    jobId: string, datasetId: string, fieldName: string, recs: Recording[],
): void {
    const total = recs.length;
    let current = 0;

    const tick = () => {
        if (current >= total) {
            // Emit done
            window.dispatchEvent(new CustomEvent('signavis:mock-event', {
                detail: {
                    event: 'dataset:birdnet-done',
                    payload: {
                        jobId, datasetId,
                        processed: total, errors: 0, skipped: 0,
                        status: 'completed',
                    } satisfies BirdnetDonePayload,
                },
            }));
            return;
        }
        const rec = recs[current];
        // Add mock detections
        (rec.fields as Record<string, unknown>)[fieldName] = {
            soundEvents: randomDetections(),
        };
        current++;
        window.dispatchEvent(new CustomEvent('signavis:mock-event', {
            detail: {
                event: 'dataset:birdnet-progress',
                payload: { jobId, datasetId, current, total, filepath: rec.filepath },
            },
        }));
        setTimeout(tick, 400);
    };
    setTimeout(tick, 200);
}

// ── Mock data builders ────────────────────────────────────────────────

function buildDatasets(): Dataset[] {
    const sites = ['Forest-Edge-North', 'Lake-Shore', 'Meadow-South', 'Riparian-Strip'];
    const d1: Dataset = {
        id: 'mock-ds-1',
        name: 'Nordbayern 2024',
        description: 'Passive acoustic monitoring — spring survey',
        mediaType: 'audio',
        createdAt: Date.now() - 86400000 * 14,
        updatedAt: Date.now() - 3600000,
        recordingCount: 432,
        knownTags: ['train', 'val', 'test', 'validated', 'flagged', 'reviewed'],
        fieldSchema: [
            { name: 'filepath',    kind: 'string',      system: true },
            { name: 'recorderId',  kind: 'string',      group: 'Import', description: 'Recorder device ID' },
            { name: 'site',        kind: 'string',      group: 'Import', description: 'Monitoring site name' },
            { name: 'week',        kind: 'string',      group: 'Import', description: 'Calendar week (KW-XX)' },
            { name: 'birdnetV24',  kind: 'sound_events',group: 'BirdNET', description: 'BirdNET v2.4 detections' },
        ],
        savedViews: [
            { name: 'High confidence', stages: [{ kind: 'match_tags', params: { tags: ['validated'] } }] as never[], createdAt: Date.now() - 7200000 },
            { name: 'Training set',    stages: [{ kind: 'match_tags', params: { tags: ['train'] } }] as never[],     createdAt: Date.now() - 3600000 },
        ],
        analysisRuns: {
            'run-bn-1': {
                key: 'run-bn-1', type: 'inference' as const,
                config: { model: 'birdnet', version: '2.4', outputField: 'birdnetV24', minConf: 0.5 },
                status: 'completed', startedAt: Date.now() - 7200000, completedAt: Date.now() - 6800000,
                processed: 432, errors: 3,
            },
        },
    };

    const d2: Dataset = {
        id: 'mock-ds-2',
        name: 'Xeno-canto Sparrows',
        description: 'Passer domesticus — reference recordings',
        mediaType: 'audio',
        createdAt: Date.now() - 86400000 * 3,
        updatedAt: Date.now() - 86400000,
        recordingCount: 89,
        knownTags: ['train', 'val'],
        fieldSchema: [
            { name: 'filepath',   kind: 'string', system: true },
            { name: 'xcId',       kind: 'string', group: 'Xeno-canto' },
            { name: 'recordist',  kind: 'string', group: 'Xeno-canto' },
            { name: 'country',    kind: 'string', group: 'Xeno-canto' },
            { name: 'quality',    kind: 'string', group: 'Xeno-canto' },
        ],
        savedViews: [],
        analysisRuns: {},
    };

    return [d1, d2];
}

function buildRecordings(): Map<string, Recording[]> {
    const map = new Map<string, Recording[]>();
    map.set('mock-ds-1', buildNordbayernRecordings());
    map.set('mock-ds-2', buildXcRecordings());
    return map;
}

function buildNordbayernRecordings(): Recording[] {
    const sites    = ['Forest-Edge-North', 'Lake-Shore', 'Meadow-South', 'Riparian-Strip'];
    const recIds   = ['REC-01', 'REC-02', 'REC-03'];
    const weeks    = ['KW-18', 'KW-19', 'KW-20', 'KW-21', 'KW-22'];
    const tags_pool= [['train'], ['val'], ['test'], ['train', 'validated'], ['flagged'], []];
    const recs: Recording[] = [];

    for (let i = 0; i < 32; i++) {
        const site = sites[i % sites.length];
        const rec  = recIds[i % recIds.length];
        const week = weeks[i % weeks.length];
        const dur  = 120 + Math.floor(Math.random() * 480);
        const id   = `mock-rec-${i + 1}`;
        const tags = tags_pool[i % tags_pool.length];
        const hasBirdnet = i < 12;

        recs.push({
            id,
            datasetId: 'mock-ds-1',
            filepath: `/data/nordbayern2024/${rec}/${site}/${week}/audio_${String(i + 1).padStart(3, '0')}.wav`,
            tags,
            metadata: {
                duration: dur,
                sampleRate: 48000,
                numChannels: 1,
                sizeBytes: dur * 48000 * 2,
                mimeType: 'audio/wav',
            },
            importedAt: Date.now() - 86400000 * 14 + i * 3600000,
            recordedAt: Date.now() - 86400000 * 20 + i * 7200000,
            fields: {
                recorderId: rec,
                site,
                week,
                ...(hasBirdnet ? { birdnetV24: { soundEvents: randomDetections() } } : {}),
            },
        });
    }
    return recs;
}

function buildXcRecordings(): Recording[] {
    const countries = ['Germany', 'Netherlands', 'France', 'UK', 'Spain'];
    const recordists = ['J. Schmidt', 'M. van den Berg', 'P. Dupont', 'A. Smith'];
    const recs: Recording[] = [];

    for (let i = 0; i < 20; i++) {
        const xcId  = 700000 + i * 137;
        const country = countries[i % countries.length];
        recs.push({
            id: `mock-xc-${i + 1}`,
            datasetId: 'mock-ds-2',
            filepath: `/data/xc_sparrows/XC${xcId}.mp3`,
            tags: i < 14 ? ['train'] : ['val'],
            metadata: {
                duration: 15 + Math.floor(Math.random() * 45),
                sampleRate: 44100,
                numChannels: 2,
                sizeBytes: 500000 + Math.floor(Math.random() * 1000000),
                mimeType: 'audio/mp3',
            },
            importedAt: Date.now() - 86400000 * 3 + i * 1800000,
            fields: {
                xcId: `XC${xcId}`,
                recordist: recordists[i % recordists.length],
                country,
                quality: ['A', 'A', 'B', 'B', 'C'][i % 5],
            },
        });
    }
    return recs;
}

const SPECIES = [
    'Turdus merula', 'Erithacus rubecula', 'Parus major',
    'Fringilla coelebs', 'Sylvia atricapilla', 'Phylloscopus collybita',
    'Carduelis carduelis', 'Cyanistes caeruleus', 'Troglodytes troglodytes',
    'Passer domesticus',
];

function randomDetections() {
    const n = 1 + Math.floor(Math.random() * 4);
    const used = new Set<string>();
    const events = [];
    for (let i = 0; i < n; i++) {
        const species = SPECIES[Math.floor(Math.random() * SPECIES.length)];
        if (used.has(species)) continue;
        used.add(species);
        const start = Math.floor(Math.random() * 50) * 3;
        events.push({
            label:      species,
            confidence: 0.5 + Math.random() * 0.48,
            support:    [start, start + 3],
            tags:       [],
        });
    }
    return events;
}
