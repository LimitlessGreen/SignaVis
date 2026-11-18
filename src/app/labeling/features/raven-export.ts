// Raven selection tables: one per audio file (download for the open recording, or written
// next to every labeled recording of a folder project).
import { buildRavenSelectionTable, ravenTablePath } from '../../../infrastructure/export/ravenSelectionTable.ts';
import { saveFile } from '../../../infrastructure/saveFile.ts';
import type { AppContext, AppLabel } from '../app-context.ts';

export function createRavenExport(ctx: AppContext) {
    /** Set id → set name for the table's "Set" column. */
    const setName = (id: string) => ctx.state.labelSets.get(id)?.name || id;

    /** Labels of a recording: the live ones for the open recording, else the stored ones. */
    const entryLabels = (entry: { id: string; annotations?: AppLabel[] | null }): readonly AppLabel[] =>
        entry.id === ctx.recordingManager.activeId ? ctx.state.labels : (entry.annotations || []);

    function download(): void {
        const entry = ctx.recordingManager.getActive();
        const name: string = entry?.filename || ctx.fileLabel.textContent || 'labels';
        const text = buildRavenSelectionTable([...ctx.state.labels], {
            sampleRate: entry?.sampleRate || ctx.state.sampleRate, setName,
            recordingStart: entry?.recordingStart || ctx.player.recordingStart,
        });
        saveFile(text, ravenTablePath(name.split('/').pop() || name), 'text/plain')
            .catch((e) => { ctx.selectionMeta.textContent = `Export failed: ${e?.message || e}`; });
    }

    /** Folder project: write <audio>.Table.1.selections.txt next to every labeled recording. */
    async function writeToFolder(): Promise<void> {
        const store = ctx.projectStore;
        if (!store) return;
        ctx.saveCurrentAnnotations();
        let written = 0;
        try {
            for (const entry of ctx.recordingManager.getAll()) {
                const labels = entryLabels(entry);
                if (!labels.length) continue;
                const target = entry.path ? ravenTablePath(entry.path) : `exports/raven/${ravenTablePath(entry.filename)}`;
                await store.writeText(target, buildRavenSelectionTable([...labels], {
                    sampleRate: entry.sampleRate, setName, recordingStart: entry.recordingStart || null,
                }));
                written++;
            }
            ctx.selectionMeta.textContent = written
                ? `${written} Raven table${written === 1 ? '' : 's'} written to “${store.label}”`
                : 'No labels to export';
        } catch (e: any) {
            ctx.selectionMeta.textContent = `Raven export failed: ${e?.message || e}`;
        }
    }

    return { download, writeToFolder, setName };
}
