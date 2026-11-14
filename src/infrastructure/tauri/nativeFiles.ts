// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/nativeFiles.ts — local audio files in SignaVis Lite
//
// The native open dialog returns a real path. Lite remembers it on the
// recording (`filePath`) and re-reads the file from there after a restart,
// instead of copying it anywhere (see read_audio_file in project_fs.rs).
// ═══════════════════════════════════════════════════════════════════════

import { AUDIO_EXTENSIONS } from '../../domain/project/IProjectStore.ts';
import { folderName } from '../project/NativeProjectStore.ts';

const MIME: Record<string, string> = {
    wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm',
};

/** File object for an absolute path, or null when the file is gone. */
export async function readAudioPath(path: string): Promise<File | null> {
    const { invoke } = await import('@tauri-apps/api/core');
    let bytes: ArrayBuffer;
    try {
        bytes = await invoke<ArrayBuffer>('read_audio_file', { path });
    } catch (e) {
        if (String(e) === 'not-found') return null;
        throw new Error(String(e));
    }
    const name = folderName(path);
    const ext = name.split('.').pop()?.toLowerCase() || '';
    return new File([bytes], name, { type: MIME[ext] || '' });
}

/** Native "open audio file" dialog. Null when cancelled. */
export async function pickAudioFile(): Promise<{ file: File; path: string } | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
        multiple: false,
        directory: false,
        title: 'Open audio file',
        filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (typeof path !== 'string' || !path) return null;
    const file = await readAudioPath(path);
    return file ? { file, path } : null;
}
