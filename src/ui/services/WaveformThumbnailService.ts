// ═══════════════════════════════════════════════════════════════════════
// ui/services/WaveformThumbnailService.ts
//
// Renders waveform thumbnails for recording cards.
// - Loads audio via fetch (Tauri asset protocol or http://localhost)
// - Decodes with Web Audio API
// - Renders normalised peaks on a Canvas element
// - Caches data-URLs in-memory, capped at MAX_CACHE entries (LRU-lite)
// ═══════════════════════════════════════════════════════════════════════

const MAX_CACHE = 500;
const THUMB_W   = 240;
const THUMB_H   = 52;
const BAR_W     = 2;
const BAR_GAP   = 1;
const NUM_BARS  = Math.floor(THUMB_W / (BAR_W + BAR_GAP));

// LRU-lite: insertion-order Map, trimmed from the front.
const cache = new Map<string, string>(); // filepath → data-URL

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext();
    }
    return audioCtx;
}

/**
 * Gibt eine Data-URL (PNG) zurück, die die Waveform der Datei zeigt.
 * Bei Fehler oder laufendem Load: undefined (Aufrufer zeigt Placeholder).
 */
export async function getWaveformThumbnail(filepath: string): Promise<string | undefined> {
    if (cache.has(filepath)) return cache.get(filepath)!;

    // Build URL for Tauri asset protocol.
    // In Tauri context: convertFileSrc(filepath)
    // In browser dev: use filepath directly (fails for local paths, acceptable)
    let url: string;
    try {
        // convertFileSrc available in @tauri-apps/api/core from v2
        const core = await import('@tauri-apps/api/core') as unknown as { convertFileSrc?: (p: string) => string };
        url = core.convertFileSrc ? core.convertFileSrc(filepath) : filepath;
    } catch {
        url = filepath;
    }

    try {
        const resp = await fetch(url);
        if (!resp.ok) return undefined;
        const arrayBuffer = await resp.arrayBuffer();
        const ctx = getAudioContext();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const dataUrl = renderPeaks(audioBuffer);
        storeCache(filepath, dataUrl);
        return dataUrl;
    } catch {
        return undefined;
    }
}

function renderPeaks(audioBuffer: AudioBuffer): string {
    // Channel 0 (mono or left)
    const raw = audioBuffer.getChannelData(0);
    const blockSize = Math.floor(raw.length / NUM_BARS);
    const peaks: number[] = [];

    for (let i = 0; i < NUM_BARS; i++) {
        let max = 0;
        const start = i * blockSize;
        for (let j = 0; j < blockSize; j++) {
            const abs = Math.abs(raw[start + j] ?? 0);
            if (abs > max) max = abs;
        }
        peaks.push(max);
    }

    // Normalise
    const maxPeak = Math.max(...peaks, 0.001);
    const normalized = peaks.map((p) => p / maxPeak);

    const canvas = document.createElement('canvas');
    canvas.width  = THUMB_W;
    canvas.height = THUMB_H;
    const ctx = canvas.getContext('2d')!;

    // Semi-transparent dark background so the card colour shows through
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);

    const midY = THUMB_H / 2;

    // Gradient: bright centre fades to dim at the edges
    const grad = ctx.createLinearGradient(0, 0, 0, THUMB_H);
    grad.addColorStop(0,   'rgba(56,189,248,0.35)');
    grad.addColorStop(0.5, 'rgba(56,189,248,0.90)');
    grad.addColorStop(1,   'rgba(56,189,248,0.35)');
    ctx.fillStyle = grad;

    for (let i = 0; i < normalized.length; i++) {
        const h = Math.max(2, normalized[i] * (THUMB_H - 6));
        const x = i * (BAR_W + BAR_GAP);
        ctx.fillRect(x, midY - h / 2, BAR_W, h);
    }

    // Subtle centre baseline
    ctx.fillStyle = 'rgba(56,189,248,0.20)';
    ctx.fillRect(0, midY - 1, THUMB_W, 1);

    return canvas.toDataURL('image/png');
}

function storeCache(key: string, value: string): void {
    if (cache.size >= MAX_CACHE) {
        // Evict oldest entry
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, value);
}
