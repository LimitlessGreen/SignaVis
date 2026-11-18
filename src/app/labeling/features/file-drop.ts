// Drag & drop of audio files anywhere on the page: an overlay while dragging, the first
// audio file of the drop is opened like a picked file.

export interface FileDropDeps {
    /** Open a local audio file (same path as the file picker). */
    openFile(file: File): Promise<unknown>;
    /** Show an error dialog. */
    showError(message: string, title: string): void;
}

const AUDIO_EXT = /\.(wav|mp3|flac|ogg|oga|opus|m4a|aac|webm|aif|aiff)$/i;

/** True for an audio file by MIME type or file name. */
export function isAudioFile(file: { type: string; name: string }): boolean {
    return file.type.startsWith('audio/') || AUDIO_EXT.test(file.name);
}

export function installFileDrop(deps: FileDropDeps): void {
    const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const overlay = document.createElement('div');
    overlay.className = 'file-drop-overlay';
    overlay.innerHTML = '<div class="file-drop-card"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg><div class="file-drop-title">Drop audio file to open</div><div class="file-drop-hint">WAV, MP3, FLAC, OGG, M4A …</div></div>';
    // Popover = browser top layer, so it also covers open <dialog> modals.
    overlay.popover = 'manual';
    document.body.appendChild(overlay);

    let depth = 0;
    const show = () => { try { if (!overlay.matches(':popover-open')) overlay.showPopover(); } catch { /* not supported */ } };
    const hide = () => { depth = 0; try { overlay.hidePopover(); } catch { /* not open */ } };

    window.addEventListener('dragenter', (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        depth++;
        show();
    });
    window.addEventListener('dragover', (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault(); // otherwise the browser opens the file itself
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
        if (!isFileDrag(e)) return;
        if (--depth <= 0) hide();
    });
    window.addEventListener('drop', async (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        hide();
        const files = Array.from(e.dataTransfer?.files || []);
        const file = files.find(isAudioFile);
        if (!file) {
            deps.showError(files.length ? `"${files[0].name}" is not an audio file` : 'no file', 'Cannot open');
            return;
        }
        await deps.openFile(file);
    });
}
