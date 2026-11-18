// Xeno-canto export & upload of the own label set: what goes into the set (selection over
// all recordings), the export modal, upload / download buttons, the "uploaded sets" list and
// the upload assistant (live checklist, XC "Verify" done locally).

import { OWN_SOURCE_ID, ownLayers, layerAnnotatorFields } from '../../label-sources.ts';
import {
    normalizeUploadSelection, uploadCandidates, selectUploadLabels, makeUploadSnapshot, snapshotState,
    type UploadSelection,
} from '../../upload-selection.ts';
import { buildUploadChecklist, type ChecklistResult, type CheckTarget } from '../../upload-checklist.ts';
import { validateAnnotaPayload } from '../../../infrastructure/xeno-canto/annotaPayload.ts';
import { xcUploadTarget } from '../../../ui/panels/xc-panel.ts';
import { UploadSelectionPanel } from '../../../ui/panels/upload-selection-panel.ts';
import { UploadAssistant } from '../../../ui/panels/upload-assistant.ts';
import { createXcExportModal } from '../../../ui/components/xc-export-modal/xc-export-modal.js';
import { showUploadSuccess } from '../../../ui/components/upload-success/upload-success.ts';
import { appAlert, appPrompt } from '../../../ui/components/modal/dialogs.ts';
import { toXcId, xcNumber } from '../../../domain/xc/xcId.ts';
import { dedupeLabels } from '../dedupe-labels.ts';
import type { AppContext, AppLabel } from '../app-context.ts';

interface UploadResult { ok: boolean; message?: string; errors?: string[] }

/** The parts of XenoCantoPanel this module uses. */
export interface XcPanelLike {
    readonly apiKey: string;
    readonly xcId: string | null;
    buildAnnotationSetPayload(labels: AppLabel[], sets: Map<string, unknown>): unknown;
    uploadToXenoCanto(labels: AppLabel[], sets: Map<string, unknown>): Promise<UploadResult>;
    exportAnnotationSetJSON(labels: AppLabel[], sets: Map<string, unknown>): unknown;
    _setStatus(message: string, kind: 'info' | 'success' | 'error'): void;
    _updateUploadState(): void;
}

export interface XcUploadDeps {
    xcPanel: XcPanelLike;
    annotatorProfile: { readonly name?: string; readonly xcUsername?: string };
    /** Save the label sets (project autosave or localStorage). */
    saveSets(): void;
    /** Redraw the recording list. */
    refreshRecordings(): void;
    /** Redraw the label list (upload markers). */
    refreshLabelList(): void;
    activateRecording(entry: unknown): Promise<unknown>;
    selectLabel(id: string, opts: { seekMode: 'start' }): void;
    /** Display name of the project folder root. */
    projectName(): string;
}

export interface XcUpload {
    /** Labels of the next XC set over all recordings, tagged with xc_nr / sound_file. */
    collectSetLabels(): AppLabel[];
    /** Re-run the local check and redraw checklist, selection, summary and buttons. */
    refresh(): void;
    /** First error of the last check ('' when the set can be uploaded). */
    blockReason(): string;
    /** Turn the modal's upload button on or off (API key present). */
    setUploadEnabled(on: boolean): void;
}

const el = (id: string) => document.getElementById(id) as HTMLElement;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function createXcUpload(ctx: AppContext, deps: XcUploadDeps): XcUpload {
    const { xcPanel } = deps;
    const sets = () => ctx.state.labelSets as Map<string, any>;
    const ownSet = () => sets().get(OWN_SOURCE_ID);
    const entries = () => ctx.recordingManager.getAll();

    const getSelection = (): UploadSelection => normalizeUploadSelection(ownSet()?.uploadSelection);

    function setSelection(sel: UploadSelection) {
        const own = ownSet();
        if (!own) return;
        own.uploadSelection = normalizeUploadSelection(sel);
        deps.saveSets();
        refresh();
    }

    function collectSetLabels(): AppLabel[] {
        // Persist in-memory labels first so per-entry `annotations` include the active recording.
        ctx.saveCurrentAnnotations();
        const { items } = selectUploadLabels(entries(), getSelection(), sets());
        return dedupeLabels(items.map(({ label, entry }) => {
            // Labels on a layer with its own annotator are uploaded under that name (else: profile)
            const copy = { ...label, ...(layerAnnotatorFields(sets(), label) || {}) };
            if (!copy.xc_nr) copy.xc_nr = xcNumber(entry.xcId);
            if (entry.filename && !copy.sound_file) copy.sound_file = entry.filename;
            return copy;
        }));
    }

    function allRecordingLabels() {
        ctx.saveCurrentAnnotations();
        return entries().flatMap((e: any) => e.annotations || []);
    }

    /** Remember what went out (labels + content hash) to show "changed since upload" later. */
    function onSetUploaded() {
        const own = ownSet();
        if (own) {
            const { items } = selectUploadLabels(entries(), getSelection(), sets());
            const snap = makeUploadSnapshot(items.map((x) => x.label), items.map((x) => x.entry),
                { name: own.name, license: own.license, env: xcUploadTarget().env });
            own.uploads = [...(own.uploads || []), snap];
        }
        deps.saveSets();
        refresh();
        deps.refreshRecordings();
        deps.refreshLabelList();
    }

    // ── Export modal, upload and download buttons ──
    const exportModal = createXcExportModal({
        buildPayload: () => xcPanel.buildAnnotationSetPayload(collectSetLabels(), sets()),
        upload: async () => {
            const result = await xcPanel.uploadToXenoCanto(collectSetLabels(), sets());
            if (result?.ok) onSetUploaded();
            return result;
        },
        getApiKey: () => xcPanel.apiKey,
        getFilename: () => (toXcId(xcPanel.xcId) ? `${toXcId(xcPanel.xcId)}_annotation_set.json` : 'annotation_set.json'),
        defaultCollapseDepth: 1,
    });
    el('xcExportSetBtn').addEventListener('click', () => { try { exportModal.open(); } catch { /* modal not ready */ } });

    const uploadBtn = el('xcUploadBtn') as HTMLButtonElement;
    // Test server (?xcenv=acc): say so on the button so nobody mistakes it for a real upload
    const target = xcUploadTarget();
    if (target.env !== 'live') {
        const hint = el('xcUploadTargetHint');
        uploadBtn.textContent = `Send to ${target.env.toUpperCase()} test server`;
        hint.textContent = `Uploads go to ${target.label}. Open the app with ?xcenv=live to switch back.`;
        hint.hidden = false;
    }

    uploadBtn.addEventListener('click', async () => {
        uploadBtn.disabled = true;
        xcPanel._setStatus('Uploading…', 'info');
        try {
            const sent = collectSetLabels();
            const result = await xcPanel.uploadToXenoCanto(sent, sets());
            if (result.ok) {
                onSetUploaded();
                xcPanel._setStatus(result.message || '', 'success');
                const t = xcUploadTarget();
                showUploadSuccess({
                    labelCount: sent.length,
                    recordingCount: new Set(sent.map((l: any) => l.xc_nr || l.sound_file || '')).size,
                    setName: ownSet()?.name || '',
                    message: result.message || '',
                    endpoint: t.endpoint,
                    testServer: t.env !== 'live' ? `${t.env.toUpperCase()} test server` : '',
                });
            } else {
                xcPanel._setStatus([result.message, ...(result.errors || [])].filter(Boolean).join('; '), 'error');
            }
        } catch (err: any) {
            xcPanel._setStatus(err?.message || 'Upload failed', 'error');
        } finally {
            refresh();
        }
    });

    el('xcDownloadSetBtn').addEventListener('click', () => {
        xcPanel.exportAnnotationSetJSON(collectSetLabels(), sets());
    });

    // ── Set contents (selection) + uploaded sets ──
    const selectionPanel = new UploadSelectionPanel({
        el: el('xcSelection'),
        uploadsEl: el('xcUploads'),
        onChange: (sel) => setSelection(sel),
        onForgetSnapshot: (id) => {
            const own = ownSet();
            if (!own) return;
            own.uploads = (own.uploads || []).filter((u: any) => u.id !== id);
            deps.saveSets();
            refresh();
        },
        onAssignXc: async (id) => {
            const entry = ctx.recordingManager.getById(id);
            if (!entry) return;
            const val = await appPrompt(`XC number for ${entry.filename} (your own upload):`, entry.xcId || '', { title: 'Assign XC number', placeholder: 'XC123456' });
            if (val == null) return;
            if (!ctx.recordingManager.assignXcId(id, val)) await appAlert('Not a valid XC number.', { title: 'Assign XC number' });
            refresh();
        },
        layerName: (id) => ownLayers(sets()).find((l) => l.id === id)?.name || id,
        localName: () => deps.projectName(),
    });

    // ── Upload assistant (live checklist, XC "Verify" done locally) ──
    const assistant = new UploadAssistant({
        el: el('xcChecklist'),
        keyEl: document.getElementById('xcKeySection'),
        profileEl: document.getElementById('xcAuthorContainer'),
        onJump: (t) => { void jumpTo(t); },
    });
    let lastChecklist: ChecklistResult | null = null;

    function blockReason(): string {
        if (!lastChecklist || lastChecklist.ready) return '';
        const first = lastChecklist.steps.flatMap((st) => st.issues).find((i) => i.level === 'error');
        return first ? `Fix first: ${first.message}` : '';
    }

    function refresh(): void {
        if (!OWN_SOURCE_ID) return;
        try {
            const set = ownSet();
            const sel = getSelection();
            const labels = collectSetLabels();
            const payload = xcPanel.buildAnnotationSetPayload(labels, sets());
            const all = entries();
            const picked = selectUploadLabels(all, sel, sets()).items;
            const recordings = all
                .map((entry: any) => ({
                    id: entry.id,
                    name: entry.filename,
                    xcNr: entry.xcId || '',
                    recordist: entry.xcRecordingMeta?.rec || '',
                    labelCount: picked.filter((x) => x.entry === entry).length,
                }))
                .filter((r) => r.labelCount > 0);
            const allLabels = allRecordingLabels();
            selectionPanel.render(
                uploadCandidates(all, sel, sets()),
                sel,
                (set?.uploads || []).map((snap: any) => ({ snap, ...snapshotState(snap, allLabels) })),
            );
            lastChecklist = buildUploadChecklist({
                apiKey: xcPanel.apiKey,
                profile: { name: deps.annotatorProfile.name, xcUsername: deps.annotatorProfile.xcUsername },
                set, recordings, payload, validation: validateAnnotaPayload(payload as any),
            });
            assistant.render(lastChecklist);
            const c = lastChecklist;
            el('xcUploadSummary').textContent = [
                `Set "${set?.name || 'Unnamed'}"`, plural(c.recordingCount, 'recording'), plural(c.labelCount, 'label'),
                c.errorCount ? `${c.errorCount} to do` : '', c.warningCount ? plural(c.warningCount, 'warning') : '',
            ].filter(Boolean).join(' · ');
        } catch { /* app still initializing */ }
        xcPanel._updateUploadState();
    }

    async function jumpTo(t: CheckTarget): Promise<void> {
        const rm = ctx.recordingManager;
        if (t.kind === 'set') {
            ctx.showSidebarTab('upload');
            document.getElementById('xcSetContainer')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return;
        }
        if (t.kind === 'recording') {
            const entry = rm.getById(t.id);
            if (entry && rm.getActive()?.id !== entry.id) await deps.activateRecording(entry);
            ctx.showSidebarTab('project');
            return;
        }
        if (t.kind === 'label' && t.id) {
            ctx.saveCurrentAnnotations();
            const entry = rm.getAll().find((e: any) => (e.annotations || []).some((a: any) => a.id === t.id));
            if (entry && rm.getActive()?.id !== entry.id) await deps.activateRecording(entry);
            deps.selectLabel(t.id, { seekMode: 'start' });
        }
    }

    return {
        collectSetLabels,
        refresh,
        blockReason,
        setUploadEnabled: (on) => { try { exportModal.setUploadEnabled(on); } catch { /* not ready */ } },
    };
}
