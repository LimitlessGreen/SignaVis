// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/TauriXcImportBridge.ts
// IPC bridge for the xc_download_recording Tauri command (Phase 7)
// ═══════════════════════════════════════════════════════════════════════

import type { GeoLocation } from '../../domain/corpus/types.ts';

type InvokeArgs = Record<string, unknown>;

async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke<T>(command, args);
}

// ── Arg / result types (mirror Rust structs in xc_import.rs) ─────────

export interface XcDownloadArgs {
    datasetId: string;
    xcId: string;
    audioUrl: string;
    filename: string;
    /** Unix milliseconds, or null if unknown. */
    recordedAtMs: number | null;
    /** Geographic coordinates, or null. */
    location: GeoLocation | null;
    /** Flat metadata to store in recording.fields. */
    fields: Record<string, string>;
}

export interface XcDownloadResult {
    recordingId: string;
    filepath: string;
}

// ── Command bridge ────────────────────────────────────────────────────

/**
 * Downloads a Xeno-canto audio file and imports it as a Recording
 * in the given dataset.
 */
export function xcDownloadRecording(args: XcDownloadArgs): Promise<XcDownloadResult> {
    return invoke<XcDownloadResult>('xc_download_recording', { args });
}
