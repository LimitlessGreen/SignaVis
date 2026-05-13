// ═══════════════════════════════════════════════════════════════════════
// ui/services/WaveformThumbnailService.ts
//
// Rendert Mini-Waveform-Thumbnails für Recording-Karten.
// - Lädt Audio via fetch (Tauri asset-Protokoll oder http://localhost)
// - Dekodiert mit Web Audio API
// - Rendert normalisierte Peaks auf ein OffscreenCanvas (oder fallback Canvas)
// - Cached Data-URL in-memory, limitiert auf MAX_CACHE Einträge (LRU-lite)
// ═══════════════════════════════════════════════════════════════════════

const MAX_CACHE = 500;
const THUMB_W   = 160;
const THUMB_H   = 36;
const BAR_W     = 2;
const BAR_GAP   = 1;
const NUM_BARS  = Math.floor(THUMB_W / (BAR_W + BAR_GAP));

// LRU-lite: insertion-order Map, wir trimmen von vorne.
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

    // URL für Tauri-Asset-Protokoll aufbauen
    // Im Tauri-Kontext: convertFileSrc(filepath)
    // Im Browser-Dev: filepath direkt (scheitert bei lokalen Pfaden, ist OK)
    let url: string;
    try {
        // convertFileSrc ist in @tauri-apps/api/core ab v2
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
    // Kanal 0 (Mono oder L)
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

    // Normalisieren
    const maxPeak = Math.max(...peaks, 0.001);
    const normalized = peaks.map((p) => p / maxPeak);

    // Canvas zeichnen
    const canvas = document.createElement('canvas');
    canvas.width  = THUMB_W;
    canvas.height = THUMB_H;
    const ctx = canvas.getContext('2d')!;

    // Hintergrund transparent lassen
    ctx.clearRect(0, 0, THUMB_W, THUMB_H);

    const midY   = THUMB_H / 2;
    const color  = '#4a9eff';
    ctx.fillStyle = color;

    for (let i = 0; i < normalized.length; i++) {
        const h = Math.max(2, normalized[i] * (THUMB_H - 4));
        const x = i * (BAR_W + BAR_GAP);
        ctx.fillRect(x, midY - h / 2, BAR_W, h);
    }

    return canvas.toDataURL('image/png');
}

function storeCache(key: string, value: string): void {
    if (cache.size >= MAX_CACHE) {
        // Ältesten Eintrag entfernen
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, value);
}
