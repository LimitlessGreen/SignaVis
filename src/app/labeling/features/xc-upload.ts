// Xeno-canto export & upload of the own label set: what goes into the set (selection over
// all recordings), the export modal, upload / download buttons, the "uploaded sets" list and
// the upload assistant (live checklist, XC "Verify" done locally).

import { OWN_SOURCE_ID, ownLayers, layerAnnotatorFields } from '../../label-sources.ts';
import {
    normalizeUploadSelection, uploadCandidates, selectUploadLabels, makeUploadSnapshot, snapshotState,
    type UploadSelection,
} from '../../upload-selection.ts';
import { buildUploadChecklist, type ChecklistResult, type CheckTarget } from '../../upload-checklist.ts';
import { validateAnnotaPayload, isAnnotaLabel } from '../../../infrastructure/xeno-canto/annotaPayload.ts';
import { xcUploadTarget } from '../../../ui/panels/xc-panel.ts';
import { UploadSelectionPanel } from '../../../ui/panels/upload-selection-panel.ts';
import { UploadAssistant } from '../../../ui/panels/upload-assistant.ts';
import { createXcExportModal } from '../../../ui/components/xc-export-modal/xc-export-modal.js';
import { showUploadSuccess } from '../../../ui/components/upload-success/upload-success.ts';
import { appAlert, appPrompt } from '../../../ui/components/modal/dialogs.ts';
import { toXcId, xcNumber } from '../../../domain/xc/xcId.ts';
import { dedupeBy } from '../dedupe-labels.ts';
import type { AppContext, AppLabel } from '../app-context.ts';

interface UploadResult { ok: boolean; message?: string; errors?: string[]; /** set_name as sent */ setName?: string }

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
/** Upload button tooltip when nothing blocks it (as in XenoCantoPanel._updateUploadState). */
const UPLOAD_TITLE = 'Upload the annotation set to your Xeno-canto account for verification';
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

    /**
     * The set as it goes out: one label per id over the upload selection, each tagged with its
     * recording's xc_nr / sound_file, and the recording it came from (for the upload snapshot).
     */
    function prepareSet(): { label: AppLabel; entry: any }[] {
        // Persist in-memory labels first so per-entry `annotations` include the active recording.
        ctx.saveCurrentAnnotations();
        const { items } = selectUploadLabels(entries(), getSelection(), sets());
        return dedupeBy(items, (x) => x.label).map(({ label, entry }) => {
            // Labels on a layer with its own annotator are uploaded under that name (else: profile)
            const copy = { ...label, ...(layerAnnotatorFields(sets(), label) || {}) };
            if (!copy.xc_nr) copy.xc_nr = xcNumber(entry.xcId);
            if (entry.filename && !copy.sound_file) copy.sound_file = entry.filename;
            return { label: copy, entry };
        });
    }

    function collectSetLabels(): AppLabel[] {
        return prepareSet().map((x) => x.label);
    }

    function allRecordingLabels() {
        ctx.saveCurrentAnnotations();
        return entries().flatMap((e: any) => e.annotations || []);
    }

    // One upload at a time, from the panel button or the export modal. While it runs,
    // blockReason() says so, which keeps the panel button disabled on every state update.
    let uploading = false;

    interface UploadRun { result: UploadResult; sent: AppLabel[]; recordingCount: number; setName: string; localError: string }

    /** Redraw for the upload path: never throws, returns the error ('' when fine). */
    function safeRefresh(): string {
        const error = redraw();
        if (error) console.warn('[xc-upload] redraw:', error);
        return error;
    }

    /**
     * Send the current set. The "uploaded" snapshot holds exactly what goes out (the selection
     * can change while the request runs) and is kept only when Xeno-canto accepts the set and
     * the own set is still the one that sent it. Once accepted, errors while saving or
     * redrawing locally do not turn the upload into a failure: they come back as `localError`.
     * Returns null while another upload is running.
     */
    async function runUpload(): Promise<UploadRun | null> {
        if (uploading) return null;
        uploading = true;
        let run: UploadRun | null = null;
        try {
            safeRefresh();   // disables the button while the request runs; re-checks the set
            if (checkError) {   // the set could not be checked: send nothing
                run = { result: { ok: false, message: `The set could not be checked: ${checkError}` },
                    sent: [], recordingCount: 0, setName: '', localError: '' };
                return run;
            }
            const own = ownSet();
            const setName: string = own?.name || '';
            const prepared = prepareSet();
            const sent = prepared.map((x) => x.label);
            const going = prepared.filter((x) => isAnnotaLabel(x.label));   // what the payload carries
            const snap = own ? makeUploadSnapshot(going.map((x) => x.label), going.map((x) => x.entry),
                { name: own.name, license: own.license, env: xcUploadTarget().env }) : null;
            const result = await xcPanel.uploadToXenoCanto(sent, sets());
            run = {
                result, sent: going.map((x) => x.label), localError: '',
                // The name that was sent (dated default when empty), even if renamed or replaced meanwhile
                setName: result?.setName || setName,
                recordingCount: new Set(going.map((x) => x.label.xc_nr || x.label.sound_file || '')).size,
            };
            if (result?.ok) {
                try {
                    // A new session may have replaced the own set meanwhile: the snapshot is not its upload.
                    if (own && snap && ownSet() === own) {
                        if (result.setName) snap.name = result.setName;   // as sent (dated default when empty)
                        own.uploads = [...(own.uploads || []), snap];
                    }
                    deps.saveSets();
                    deps.refreshRecordings();
                    deps.refreshLabelList();
                } catch (e: any) {
                    run.localError = `Uploaded, but saving that locally failed: ${e?.message || e}`;
                    console.warn('[xc-upload]', e);
                }
            }
        } finally {
            uploading = false;
            const refreshError = safeRefresh();
            if (refreshError && run?.result?.ok && !run.localError) run.localError = `Uploaded, but updating the panel failed: ${refreshError}`;
        }
        return run;
    }

    // ── Export modal, upload and download buttons ──
    const exportModal = createXcExportModal({
        buildPayload: () => xcPanel.buildAnnotationSetPayload(collectSetLabels(), sets()),
        upload: async () => {
            const run = await runUpload();
            if (!run) return { ok: false, message: 'An upload is already running' };
            if (run.localError) return { ...run.result, message: `${run.result.message || 'Upload successful'} (${run.localError})` };
            return run.result;
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
        if (uploading) return;
        xcPanel._setStatus('Uploading…', 'info');
        let run: UploadRun | null = null;
        try {
            run = await runUpload();
        } catch (err: any) {
            xcPanel._setStatus(err?.message || 'Upload failed', 'error');
            return;
        }
        if (!run) return;
        const { result, sent, recordingCount, setName, localError } = run;
        if (!result.ok) {
            xcPanel._setStatus([result.message, ...(result.errors || [])].filter(Boolean).join('; '), 'error');
            return;
        }
        xcPanel._setStatus([result.message, localError].filter(Boolean).join(' — '), localError ? 'error' : 'success');
        const t = xcUploadTarget();
        void showUploadSuccess({
            labelCount: sent.length,
            recordingCount,
            setName,
            message: result.message || '',
            endpoint: t.endpoint,
            testServer: t.env !== 'live' ? `${t.env.toUpperCase()} test server` : '',
        });
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
    // Shown above the checklist while the last check failed (a sibling: render() replaces the list)
    const staleNote = document.createElement('p');
    staleNote.className = 'ua-stale-note';
    staleNote.setAttribute('role', 'status');
    staleNote.hidden = true;
    el('xcChecklist').before(staleNote);
    let lastChecklist: ChecklistResult | null = null;
    let checkError = '';   // the last check failed: no upload until one succeeds

    function blockReason(): string {
        if (uploading) return 'An upload is running.';
        if (checkError) return `Fix first: the set could not be checked (${checkError})`;
        if (!lastChecklist || lastChecklist.ready) return '';
        const first = lastChecklist.steps.flatMap((st) => st.issues).find((i) => i.level === 'error');
        return first ? `Fix first: ${first.message}` : '';
    }

    function refresh(): void { redraw(); }

    /**
     * Check the set, then draw selection, uploaded sets, checklist and summary, then update the
     * button. Never throws; returns the first error ('' when fine). A failed check drops the
     * previous result, so the button stays blocked until a check succeeds again.
     */
    function redraw(): string {
        if (!OWN_SOURCE_ID) return '';
        let error = '';
        const note = (e: any) => { error ||= String(e?.message || e || '') || 'unknown error'; };
        // 1. Check (what blockReason() relies on)
        try {
            const set = ownSet();
            const sel = getSelection();
            const payload = xcPanel.buildAnnotationSetPayload(collectSetLabels(), sets());
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
            lastChecklist = buildUploadChecklist({
                apiKey: xcPanel.apiKey,
                profile: { name: deps.annotatorProfile.name, xcUsername: deps.annotatorProfile.xcUsername },
                set, recordings, payload, validation: validateAnnotaPayload(payload as any),
            });
            checkError = '';
        } catch (e: any) {   // also while the app is still starting
            lastChecklist = null;
            checkError = String(e?.message || e || '') || 'unknown error';   // never empty: it is the block flag
            note(e);
        }
        // 2. Check result: summary, or a readable "outdated" note when the check failed. Kept apart
        // from drawing the selection, so a drawing error cannot hide a failed check. The last
        // checklist stays mounted (its key/profile controls must stay usable).
        try {
            const c = lastChecklist;
            staleNote.hidden = !!c;
            if (c) {
                assistant.render(c);
                el('xcUploadSummary').textContent = [
                    `Set "${ownSet()?.name || 'Unnamed'}"`, plural(c.recordingCount, 'recording'), plural(c.labelCount, 'label'),
                    c.errorCount ? `${c.errorCount} to do` : '', c.warningCount ? plural(c.warningCount, 'warning') : '',
                ].filter(Boolean).join(' · ');
            } else {
                staleNote.textContent = `Checklist outdated: the set could not be checked (${checkError}).`;
                el('xcUploadSummary').textContent = `The set could not be checked: ${checkError}`;
            }
        } catch (e) { note(e); }
        // 3. Draw selection and uploaded sets
        try {
            const set = ownSet();
            const sel = getSelection();
            const all = entries();
            const allLabels = allRecordingLabels();
            selectionPanel.render(
                uploadCandidates(all, sel, sets()),
                sel,
                (set?.uploads || []).map((snap: any) => ({ snap, ...snapshotState(snap, allLabels) })),
            );
        } catch (e) { note(e); }
        // 4. Button: the panel asks blockReason() (disabled while an upload runs). If that update
        // fails, set the button here so it does not stay stuck from the last upload.
        try {
            xcPanel._updateUploadState();
        } catch (e) {
            note(e);
            const reason = !xcPanel.apiKey ? 'Add your Xeno-canto API key first.' : blockReason();
            uploadBtn.disabled = !!reason;
            uploadBtn.title = reason || UPLOAD_TITLE;
        }
        return error;
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
