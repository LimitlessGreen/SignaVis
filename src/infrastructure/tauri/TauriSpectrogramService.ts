// ═══════════════════════════════════════════════════════════════════════
// TauriSpectrogramService.ts — native spectrogram pyramid (desktop app)
//
// Same surface as WasmSpectrogramService (open → meta, tile, cancel,
// dispose) so WasmTileManager can read either. The pyramid is built by the
// Rust backend (commands/spectrogram.rs) straight from the WAV file on disk
// and cached in the app cache dir across restarts.
// ═══════════════════════════════════════════════════════════════════════

// Type-only: the WASM service module pulls in Vite worker imports.
import type { AnySpecParams, PyramidMeta } from '../wasm-dsp/WasmSpectrogramService.ts';

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function isTauriSpectrogramSource(path: string | null | undefined): path is string {
    return !!path && /\.wav$/i.test(path)
        && typeof (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined';
}

export class TauriSpectrogramService {
    private id: string | null = null;

    private constructor(private readonly invoke: Invoke) {}

    static async create(): Promise<TauriSpectrogramService> {
        const { invoke } = await import('@tauri-apps/api/core');
        return new TauriSpectrogramService(invoke as Invoke);
    }

    async open(path: string, params: AnySpecParams, onProgress?: (fraction: number) => void) {
        const { listen } = await import('@tauri-apps/api/event');
        // Only one build runs per player; the id is not known before open returns.
        const unlisten = await listen<{ id: string; fraction: number }>('spectrogram:progress',
            (e) => onProgress?.(e.payload.fraction));
        try {
            // sampleRate is taken from the file by the backend.
            const args = { path, params: { ...params, sampleRate: 0 } };
            const r = await this.invoke<{ id: string; fromCache: boolean; meta: PyramidMeta }>(
                typeof (params as { winLen?: unknown }).winLen === 'number' ? 'spectrogram_open_v2' : 'spectrogram_open',
                { args });
            this.id = r.id;
            return { meta: r.meta, fromCache: r.fromCache };
        } finally {
            unlisten();
        }
    }

    /** Frames [f0, f1) of `level`, row-major [frame][bin]. */
    async tile(level: number, f0: number, f1: number): Promise<Float32Array> {
        if (!this.id) throw new Error('no spectrogram open');
        const bytes = await this.invoke<ArrayBuffer>('spectrogram_tile', { id: this.id, level, f0, f1 });
        return new Float32Array(bytes);
    }

    cancel(): void {
        if (this.id) void this.invoke('spectrogram_cancel', { id: this.id });
    }

    dispose(): void {
        this.cancel();
        this.id = null;
    }
}
