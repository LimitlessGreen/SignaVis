// ═══════════════════════════════════════════════════════════════════════
// utils.ts — Shared utility functions
// ═══════════════════════════════════════════════════════════════════════

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

export function getAxisWidth(fallback: number): number {
    return parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--axis-width'),
        10,
    ) || fallback;
}

export function formatTime(seconds: number): string {
    const s = Math.max(0, seconds);
    const mins = Math.floor(s / 60);
    const secs = (s % 60).toFixed(1);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(4, '0')}`;
}

export function formatSecondsShort(seconds: number): string {
    return `${seconds.toFixed(2)}s`;
}

export function isTypingContext(target: EventTarget | null): boolean {
    if (!target || !('tagName' in target)) return false;
    const el = target as HTMLElement;
    return (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
    );
}

export function getTimeGridSteps(pixelsPerSecond: number): { majorStep: number; minorStep: number } {
    const majorStep =
        pixelsPerSecond >= 320 ? 0.5 :
        pixelsPerSecond >= 180 ? 1 :
        pixelsPerSecond >= 90  ? 2 :
        pixelsPerSecond >= 45  ? 5 : 10;
    return { majorStep, minorStep: majorStep / 2 };
}

export function hexToRgb(hex: string): [number, number, number] | null {
    if (!hex) return null;
    let h = String(hex).replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function colorWithAlpha(color: string, alpha = 1): string {
    if (!color) return color;
    const c = color.trim();
    if (c.startsWith('rgba')) {
        const inner = c.slice(5, -1).split(',').map(s => s.trim());
        return `rgba(${inner[0]}, ${inner[1]}, ${inner[2]}, ${alpha})`;
    }
    if (c.startsWith('rgb(')) {
        const inner = c.slice(4, -1).split(',').map(s => s.trim());
        return `rgba(${inner[0]}, ${inner[1]}, ${inner[2]}, ${alpha})`;
    }
    if (c[0] === '#') {
        const rgb = hexToRgb(c);
        if (rgb) return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
    }
    return c;
}

export function parseNativeSampleRate(buf: ArrayBuffer): number {
    if (buf.byteLength < 10) return 0;
    const view = new DataView(buf);

    // WAV: "RIFF" … "WAVE", sample rate at byte 24 (LE uint32)
    if (buf.byteLength >= 28 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57415645) {
        return view.getUint32(24, true);
    }
    // FLAC: "fLaC", STREAMINFO sample rate = 20 bits at byte 18
    if (buf.byteLength >= 21 && view.getUint32(0) === 0x664C6143) {
        return (view.getUint8(18) << 12) | (view.getUint8(19) << 4) | (view.getUint8(20) >> 4);
    }
    // OGG: "OggS"
    if (view.getUint32(0) === 0x4F676753 && buf.byteLength >= 64) {
        const nSegments = view.getUint8(26);
        const dataOffset = 27 + nSegments;
        if (buf.byteLength >= dataOffset + 16) {
            const b0 = view.getUint8(dataOffset);
            if (b0 === 0x01 && view.getUint32(dataOffset + 1) === 0x766F7262)
                return view.getUint32(dataOffset + 12, true);
            if (view.getUint32(dataOffset) === 0x4F707573 && view.getUint32(dataOffset + 4) === 0x48656164)
                return view.getUint32(dataOffset + 12, true);
        }
    }
    // MP3
    {
        const MP3_SAMPLE_RATES: number[][] = [
            [11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000],
        ];
        let scanStart = 0;
        if (view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) {
            const id3Size = ((view.getUint8(6) & 0x7F) << 21) | ((view.getUint8(7) & 0x7F) << 14) |
                            ((view.getUint8(8) & 0x7F) << 7)  |  (view.getUint8(9) & 0x7F);
            scanStart = 10 + id3Size;
        }
        const scanEnd = Math.min(buf.byteLength - 3, scanStart + 4096);
        for (let i = scanStart; i < scanEnd; i++) {
            if (view.getUint8(i) !== 0xFF || (view.getUint8(i + 1) & 0xE0) !== 0xE0) continue;
            const h = view.getUint32(i);
            const version = (h >>> 19) & 0x3;
            const layer   = (h >>> 17) & 0x3;
            const srIndex = (h >>> 10) & 0x3;
            if (version === 0x1 || layer === 0x0 || srIndex === 0x3) continue;
            return MP3_SAMPLE_RATES[version][srIndex];
        }
    }
    return 0;
}

export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .split('&').join('&amp;')
        .split('<').join('&lt;')
        .split('>').join('&gt;')
        .split('"').join('&quot;')
        .split("'").join('&#39;');
}
