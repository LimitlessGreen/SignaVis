// Microphone recording: the player shows a live spectrogram; the finished recording is
// opened like a local file.

import type { AppContext } from '../app-context.ts';

export interface MicRecordingDeps {
    button: HTMLElement | null;
    /** Whether the browser can record (BirdNETPlayer.recordingSupported). */
    supported: boolean;
    openFile(file: File): Promise<unknown>;
    showError(message: string, title: string): void;
}

export function installMicRecording(ctx: AppContext, deps: MicRecordingDeps): void {
    const button = deps.button;
    if (!button || !deps.supported) return;
    button.hidden = false;
    const text = button.querySelector('.record-btn-text');
    const setRecording = (on: boolean) => {
        button.classList.toggle('is-recording', on);
        if (text) text.textContent = on ? 'Stop' : 'Record';
    };
    button.addEventListener('click', async () => {
        const { player } = ctx;
        if (player.isRecording) { await player.stopRecording(); return; }
        try {
            await player.startRecording({ maxSeconds: 300, loadWhenDone: false });
            setRecording(true);
        } catch (e: any) {
            deps.showError(e?.name === 'NotAllowedError' ? 'Microphone access was denied.' : String(e?.message || e), 'Cannot record');
        }
    });
    ctx.player.on('recordingstop', () => setRecording(false));
    ctx.player.on('recordingcomplete', async (e: CustomEvent<{ file?: File }>) => {
        setRecording(false);
        const file = e.detail?.file;
        if (file) await deps.openFile(file);
    });
}
