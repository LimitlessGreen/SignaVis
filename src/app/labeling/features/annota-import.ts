// Import an Annota-JSON set file (XC "Download set" or an own export). Labels go to the
// recordings with the same XC number, each original set as a locked set; one undo for all.
import { readAnnotaSetFile } from '../../../infrastructure/xeno-canto/annotaSetFile.ts';
import { mapXenoCantoLabelsToSpectrogram } from '../../../infrastructure/xeno-canto/xenoCantoRecordingsApi.ts';
import { saveSessionSets } from '../../session-sets.ts';
import { showUndoToast } from '../../../ui/components/toast/undo-toast.ts';
import type { AppContext, AppLabel } from '../app-context.ts';

export interface AnnotaImportDeps {
    button: HTMLElement;
    input: HTMLInputElement;
    /** Register the XC annotation sets of the imported labels (locked sets). */
    promoteXcSets(labels: AppLabel[], xcNr: string): void;
    /** Re-apply species names in the current taxonomy language. */
    relocalizeLabels(): void;
    /** Redraw the recording list (label counts). */
    refreshRecordings(): void;
}

export function installAnnotaImport(ctx: AppContext, deps: AnnotaImportDeps) {
    deps.button.addEventListener('click', () => deps.input.click());   // opens the file picker
    deps.input.addEventListener('change', async () => {
        const file = deps.input.files?.[0];
        deps.input.value = '';
        if (file) await importFile(file);
    });

    async function importFile(file: File): Promise<void> {
        const { state, labelStore, recordingManager, selectionMeta } = ctx;
        let parsed: ReturnType<typeof readAnnotaSetFile> = null;
        try { parsed = readAnnotaSetFile(JSON.parse(await file.text())); } catch { /* reported below */ }
        if (!parsed) { selectionMeta.textContent = `${file.name}: not an Annota-JSON annotation set`; return; }

        ctx.saveCurrentAnnotations();
        const setsBefore = new Set(state.labelSets.keys());
        const labelsBefore = state.labels;
        let activeEntryId: string | null = null;   // recording whose live labels were changed
        const entriesBefore: [string, AppLabel[]][] = [];
        const missing: string[] = [];
        let imported = 0;
        for (const [nr, raw] of parsed.byXcNr) {
            const entry = recordingManager.findByXcId(nr);
            if (!entry) { missing.push(`XC${nr}`); continue; }
            const isActive = entry.id === recordingManager.activeId;
            const { labels } = mapXenoCantoLabelsToSpectrogram(raw, {
                xcId: nr, recording: entry.xcRecordingMeta || {},
                sampleRate: (isActive ? state.sampleRate : entry.sampleRate) || state.sampleRate,
            }) as { labels: AppLabel[] };
            deps.promoteXcSets(labels, nr);
            const ids = new Set(labels.map((l) => l.id));
            if (isActive) {
                labelStore.claim(entry.id);
                labelStore.replaceAll([...state.labels.filter((l) => !ids.has(l.id)), ...labels]);
                activeEntryId = entry.id;
            } else {
                const anns: AppLabel[] = entry.annotations || [];
                entriesBefore.push([entry.id, anns]);
                recordingManager.update(entry.id, { annotations: [...anns.filter((a) => !ids.has(a.id)), ...labels] });
            }
            imported += labels.length;
        }

        // Undo removes only the sets this import created (later ones, e.g. from BirdNET, stay)
        const setsCreated = [...state.labelSets.keys()].filter((id) => !setsBefore.has(id));
        const refresh = () => {
            deps.relocalizeLabels();
            ctx.syncToPlayer();
            deps.refreshRecordings();
            saveSessionSets(state);
        };
        if (imported) refresh();
        const parts = [`${imported} label${imported === 1 ? '' : 's'} imported from ${file.name}`];
        if (missing.length) parts.push(`no recording for ${missing.join(', ')} — add it under Project → Recordings, then import again`);
        if (parsed.skipped) parts.push(`${parsed.skipped} without XC number skipped`);
        selectionMeta.textContent = parts.join(' · ');
        if (!imported) return;
        showUndoToast(parts[0] + (missing.length ? ` (${missing.length} recording${missing.length === 1 ? '' : 's'} missing)` : ''), () => {
            // Each recording as it was: through the store if it is open now, else its stored labels
            // (the user may have switched recordings since the import)
            const restore = (id: string, anns: readonly AppLabel[]) => {
                if (recordingManager.activeId === id && labelStore.entryId === id) labelStore.replaceAll(anns);
                else recordingManager.update(id, { annotations: [...anns] });
            };
            if (activeEntryId) restore(activeEntryId, labelsBefore);
            for (const [id, anns] of entriesBefore) restore(id, anns);
            for (const id of setsCreated) state.labelSets.delete(id);
            refresh();
            selectionMeta.textContent = `Import of ${file.name} undone`;
        });
        ctx.showSidebarTab('labels');
    }

    return { importFile };
}
