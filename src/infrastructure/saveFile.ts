// ═══════════════════════════════════════════════════════════════════════
// infrastructure/saveFile.ts — "save this export" for browser and Lite
//
// Browser: the usual <a download> click.
// SignaVis Lite: native save dialog, the shell writes the file
// (save_user_file in src-tauri-lite/src/project_fs.rs) — WKWebView and
// WebKitGTK do not handle <a download> in a Tauri window.
// ═══════════════════════════════════════════════════════════════════════

import { isLite } from './tauri/runtime.ts';

export interface SaveResult {
    /** File name (browser) or full path (Lite) the data went to. */
    target: string;
}

function browserDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Save `data` under a suggested file name. Resolves null when the user
 * cancels the Lite save dialog (the browser download cannot be cancelled here).
 */
export async function saveFile(data: Blob | string, filename: string, mime = 'application/octet-stream'): Promise<SaveResult | null> {
    const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
    if (!isLite()) {
        browserDownload(blob, filename);
        return { target: filename };
    }
    const { save } = await import('@tauri-apps/plugin-dialog');
    const ext = filename.includes('.') ? filename.split('.').pop()! : '';
    const path = await save({
        defaultPath: filename,
        filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
    });
    if (!path) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_user_file', new Uint8Array(await blob.arrayBuffer()), {
        headers: { 'x-path': encodeURIComponent(path) },
    });
    return { target: path };
}
