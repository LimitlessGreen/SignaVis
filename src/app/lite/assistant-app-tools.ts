// ═══════════════════════════════════════════════════════════════════════
// app/lite/assistant-app-tools.ts — the Lite app's tools for AI assistants (MCP)
//
// Descriptions and schemas are written for a language model: say what a tool does, the units
// (seconds from the start of the open recording, Hz) and what to call first. The handlers only
// shape data; the app passes in what they reach (`AppPort`, wired in labeling/main.js), so this
// module stays testable without the player.
// ═══════════════════════════════════════════════════════════════════════

import { ToolRegistry, type ToolContext } from './assistant-tools.ts';
import type { PaletteItem } from './command-search.ts';

export interface PortLabel {
    id: string; start: number; end: number; label?: string; scientificName?: string;
    freqMin?: number; freqMax?: number; origin?: string; confidence?: number; tags?: Record<string, string>; setId?: string;
}

export interface NewLabel { start: number; end: number; species: string; scientificName?: string; freqMin?: number; freqMax?: number; tags?: Record<string, string> }

export interface AppPort {
    state(): Record<string, unknown>;
    recordings(query: string, limit: number): Promise<{ id: string; name: string; where: string; open?: boolean }[]>;
    openRecording(id: string): Promise<void>;
    labels(): PortLabel[];
    /** One undo step; returns the new ids. */
    addLabels(labels: NewLabel[], summary: string): string[];
    /** One undo step; returns how many changed. */
    updateLabels(changes: { id: string; patch: Partial<PortLabel> }[], summary: string): number;
    deleteLabels(ids: string[], summary: string): number;
    view(): { duration: number; time: number; start: number; end: number } | null;
    seek(t: number): void;
    zoom(start: number, end: number): void;
    species(query: string, limit: number): { name: string; scientificName?: string }[];
    actions(): PaletteItem[];
    runAction(id: string): void;
    runBirdnet(): Promise<boolean>;
    canBirdnet(): boolean;
    /** PNG (base64, no data: prefix) of the visible spectrogram, or null. */
    spectrogramPng(maxWidth: number): Promise<string | null>;
}

const num = (description: string, extra = {}) => ({ type: 'number', description, ...extra });
const str = (description: string, extra = {}) => ({ type: 'string', description, ...extra });
const r3 = (x: number | undefined) => (x == null || !Number.isFinite(x) ? undefined : Math.round(x * 1000) / 1000);

export function compactLabel(l: PortLabel) {
    const out: Record<string, unknown> = { id: l.id, start: r3(l.start), end: r3(l.end), species: l.label || '' };
    if (l.scientificName && l.scientificName !== l.label) out.scientificName = l.scientificName;
    if (l.freqMin != null || l.freqMax != null) { out.freqMin = Math.round(l.freqMin ?? 0); out.freqMax = Math.round(l.freqMax ?? 0); }
    if (l.origin && l.origin !== 'manual') out.origin = l.origin;
    if (l.confidence != null) out.confidence = r3(l.confidence);
    if (l.tags && Object.keys(l.tags).length) out.tags = l.tags;
    return out;
}

/** Labels matching the filter (species: name or scientific name, case-insensitive substring). */
export function filterLabels(all: PortLabel[], f: { species?: string; from?: number; to?: number; origin?: string; minConfidence?: number }) {
    const sp = f.species?.trim().toLowerCase();
    return all.filter((l) => (!sp || `${l.label || ''} ${l.scientificName || ''}`.toLowerCase().includes(sp))
        && (f.from == null || l.end > f.from)
        && (f.to == null || l.start < f.to)
        && (!f.origin || (f.origin === 'manual' ? !l.origin || l.origin === 'manual' : l.origin === f.origin))
        && (f.minConfidence == null || (l.confidence ?? 1) >= f.minConfidence))
        .sort((a, b) => a.start - b.start);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function buildAppTools(app: AppPort, ctx: ToolContext): ToolRegistry {
    const reg = new ToolRegistry(ctx);
    const needView = () => {
        const v = app.view();
        if (!v) throw new Error('No recording is open. Use search_recordings and open_recording first.');
        return v;
    };
    const known = (ids: string[]) => {
        const have = new Set(app.labels().map((l) => l.id));
        const missing = ids.filter((id) => !have.has(id));
        if (missing.length) throw new Error(`Unknown label ids (not in the open recording): ${missing.slice(0, 5).join(', ')}`);
    };

    reg.add({
        name: 'get_app_state', title: 'App state', tier: 'read',
        description: 'What SignaVis shows now: project, open recording (name, duration in s, playhead, visible time range), active space, label template, label counts. Call this first.',
        run: () => app.state(),
    });

    reg.add({
        name: 'search_recordings', title: 'Search recordings', tier: 'read',
        description: 'Find recordings in the project and the catalog by words in the file path, site or device (e.g. "site B 2026-05"). Returns ids for open_recording.',
        input: { required: ['query'], properties: { query: str('Words that must all occur'), limit: num('Max results (default 10)', { minimum: 1, maximum: 50 }) } },
        run: (a) => app.recordings(a.query, a.limit ?? 10),
    });

    reg.add({
        name: 'open_recording', title: 'Open recording', tier: 'write',
        description: 'Open a recording (id from search_recordings) in the editor. Its labels become the ones the label tools work on.',
        input: { required: ['id'], properties: { id: str('Recording id from search_recordings') } },
        run: async (a) => { await app.openRecording(a.id); return app.state(); },
    });

    reg.add({
        name: 'navigate', title: 'Navigate', tier: 'read',
        description: 'Move the view of the open recording: zoom to start..end (seconds) and/or put the playhead at `time`. Changes no data.',
        input: { additionalProperties: false, properties: { start: num('View start, s', { minimum: 0 }), end: num('View end, s', { minimum: 0 }), time: num('Playhead, s', { minimum: 0 }) } },
        run: (a) => {
            const v = needView();
            if ((a.start == null) !== (a.end == null)) throw new Error('Give both start and end, or neither.');
            if (a.start != null) {
                if (a.end <= a.start) throw new Error('end must be after start.');
                app.zoom(Math.max(0, a.start), Math.min(v.duration, a.end));
            }
            if (a.time != null) app.seek(Math.min(v.duration, a.time));
            return app.view();
        },
    });

    reg.add({
        name: 'list_labels', title: 'List labels', tier: 'read',
        description: 'Labels of the open recording, sorted by start. Filter by species (name or scientific name, substring), time range (s), origin ("manual", "birdnet", …) or min confidence. Includes detector suggestions.',
        input: { properties: {
            species: str('Name or scientific name, substring'), from: num('Overlapping from, s'), to: num('Overlapping until, s'),
            origin: str('"manual" for own labels, or a detector origin'), minConfidence: num('0..1', { minimum: 0, maximum: 1 }),
            limit: num('Max labels (default 200)', { minimum: 1, maximum: 2000 }),
        } },
        run: (a) => {
            needView();
            const found = filterLabels(app.labels(), a);
            const limit = a.limit ?? 200;
            return { total: found.length, labels: found.slice(0, limit).map(compactLabel), ...(found.length > limit ? { truncated: true } : {}) };
        },
    });

    reg.add({
        name: 'search_species', title: 'Search species', tier: 'read',
        description: 'Look up species in the app taxonomy (common name in the label language, or scientific name). Use the result names for add_labels.',
        input: { required: ['query'], properties: { query: str('Name, part of it, or scientific name'), limit: num('Max (default 8)', { minimum: 1, maximum: 30 }) } },
        run: (a) => app.species(a.query, a.limit ?? 8),
    });

    const labelItem = {
        type: 'object', required: ['start', 'end', 'species'],
        properties: {
            start: num('s', { minimum: 0 }), end: num('s', { minimum: 0 }), species: str('Common name as in search_species'),
            scientificName: str('Optional'), freqMin: num('Hz; omit both freq fields for a time-only label', { minimum: 0 }), freqMax: num('Hz', { minimum: 0 }),
            tags: { type: 'object', description: 'Optional string tags (e.g. {"type":"song"})' },
        },
    };
    reg.add({
        name: 'add_labels', title: 'Add labels', tier: 'write',
        description: 'Add labels to the open recording (own labels, active set). All in one undo step. Returns the new ids.',
        input: { required: ['labels'], properties: { labels: { type: 'array', items: labelItem } } },
        run: (a) => {
            const v = needView();
            const list = a.labels as NewLabel[];
            if (!list.length) throw new Error('labels is empty.');
            for (const l of list) {
                if (!(l.end > l.start)) throw new Error(`end must be after start (${l.start}..${l.end}).`);
                if (l.start > v.duration) throw new Error(`start ${l.start} is after the end of the recording (${r3(v.duration)} s).`);
                if ((l.freqMin == null) !== (l.freqMax == null)) throw new Error('Give both freqMin and freqMax, or neither.');
                if (l.freqMin != null && !(l.freqMax! > l.freqMin)) throw new Error('freqMax must be above freqMin.');
            }
            const ids = app.addLabels(list.map((l) => ({ ...l, end: Math.min(l.end, v.duration) })), `AI: added ${plural(list.length, 'label')}`);
            return { added: ids.length, ids };
        },
    });

    reg.add({
        name: 'update_labels', title: 'Update labels', tier: 'write',
        description: 'Change labels by id: species, times, frequencies, tags. Accepting a detector suggestion = set origin "manual". One undo step.',
        input: { required: ['changes'], properties: { changes: { type: 'array', items: {
            type: 'object', required: ['id'],
            properties: {
                id: str('Label id'), species: str('New common name'), scientificName: str(''), start: num('s'), end: num('s'),
                freqMin: num('Hz'), freqMax: num('Hz'), tags: { type: 'object' }, origin: { type: 'string', enum: ['manual'] },
            },
        } } } },
        run: (a) => {
            needView();
            known(a.changes.map((c: { id: string }) => c.id));
            const changes = a.changes.map(({ id, species, ...rest }: Record<string, any>) => ({ id, patch: { ...rest, ...(species != null ? { label: species } : {}) } }));
            const n = app.updateLabels(changes, `AI: changed ${plural(changes.length, 'label')}`);
            return { updated: n };
        },
    });

    reg.add({
        name: 'delete_labels', title: 'Delete labels', tier: 'destructive',
        description: 'Delete labels of the open recording by id. The person is asked in SignaVis first; undo is possible.',
        input: { required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } },
        confirmText: (a) => `An AI assistant wants to delete ${plural(a.ids.length, 'label')} of the open recording. Allow?`,
        run: (a) => { needView(); known(a.ids); return { deleted: app.deleteLabels(a.ids, `AI: deleted ${plural(a.ids.length, 'label')}`) }; },
    });

    reg.add({
        name: 'run_birdnet', title: 'Run BirdNET', tier: 'write',
        description: 'Run BirdNET on the open recording. Detections appear as labels with origin "birdnet"; list them with list_labels.',
        run: async () => {
            needView();
            if (!app.canBirdnet()) throw new Error('BirdNET cannot run now (model not loaded or a run is going).');
            if (!await app.runBirdnet()) throw new Error('BirdNET did not finish (see the app).');
            const det = app.labels().filter((l) => l.origin && l.origin !== 'manual');
            return { detections: det.length };
        },
    });

    reg.add({
        name: 'get_spectrogram_image', title: 'Spectrogram image', tier: 'read',
        description: 'PNG of the spectrogram as visible now (time left→right, frequency bottom→top). Use navigate first to choose the range.',
        input: { properties: { maxWidth: num('Pixels (default 1200)', { minimum: 200, maximum: 2400 }) } },
        run: async (a) => {
            const v = needView();
            const png = await app.spectrogramPng(a.maxWidth ?? 1200);
            if (!png) throw new Error('The spectrogram is not drawn yet.');
            return { content: [
                { type: 'image', data: png, mimeType: 'image/png' },
                { type: 'text', text: `Visible ${r3(v.start)}–${r3(v.end)} s of ${r3(v.duration)} s.` },
            ] };
        },
    });

    reg.add({
        name: 'list_actions', title: 'List app actions', tier: 'read',
        description: 'Commands of the app\'s Ctrl K search: go to a space, show a panel, Project and Settings menu entries. Ids for run_action.',
        input: { properties: { query: str('Optional filter words') } },
        run: (a) => {
            const q = String(a.query || '').toLowerCase().trim();
            return app.actions()
                .filter((it) => !q || `${it.label} ${it.sub || ''} ${it.keywords || ''}`.toLowerCase().includes(q))
                .map((it) => ({ id: it.id, label: it.label, ...(it.sub ? { group: it.sub } : {}), ...(it.hint ? { state: it.hint } : {}) }));
        },
    });

    reg.add({
        name: 'run_action', title: 'Run app action', tier: 'write',
        description: 'Run one command from list_actions by id (same as choosing it in Ctrl K). Some open a dialog the person answers.',
        input: { required: ['id'], properties: { id: str('Id from list_actions') } },
        run: (a) => {
            const item = app.actions().find((it) => it.id === a.id);
            if (!item) throw new Error(`No such action now: ${a.id}. Call list_actions.`);
            // Never let a model wipe the session through the palette.
            if (/new-session|reset-layout/.test(a.id)) throw new Error('This action is only available to the person in the app.');
            app.runAction(a.id);
            return `ran: ${item.label}`;
        },
    });

    return reg;
}
