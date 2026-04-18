// ═══════════════════════════════════════════════════════════════════════
// utils.js — Shared utility functions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Clamp `value` to the range [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Parse `value` as a finite number, clamp to [min, max], or return `fallback`.
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

export function getAxisWidth(fallback) {
    return parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--axis-width'),
        10,
    ) || fallback;
}

export function formatTime(seconds) {
    const s = Math.max(0, seconds);
    const mins = Math.floor(s / 60);
    const secs = (s % 60).toFixed(1);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(4, '0')}`;
}

export function formatSecondsShort(seconds) {
    return `${seconds.toFixed(2)}s`;
}

export function isTypingContext(target) {
    if (!target || !target.tagName) return false;
    return (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
    );
}

export function getTimeGridSteps(pixelsPerSecond) {
    const majorStep =
        pixelsPerSecond >= 320 ? 0.5 :
        pixelsPerSecond >= 180 ? 1 :
        pixelsPerSecond >= 90  ? 2 :
        pixelsPerSecond >= 45  ? 5 : 10;
    return { majorStep, minorStep: majorStep / 2 };
}

/**
 * Parse a hex color string (#rgb or #rrggbb) to an [r, g, b] array, or null on failure.
 * @param {string} hex
 * @returns {[number, number, number] | null}
 */
export function hexToRgb(hex) {
    if (!hex) return null;
    let h = String(hex).replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Return a CSS `rgba(...)` string from any CSS color value, overriding alpha.
 * Unknown formats are returned as-is (alpha ignored).
 * @param {string} color
 * @param {number} [alpha=1]
 * @returns {string}
 */
export function colorWithAlpha(color, alpha = 1) {
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

/**
 * Parse the native sample rate from an audio file header (WAV, FLAC, OGG Vorbis/Opus, MP3).
 * Returns 0 if the format is unrecognised or the buffer is too short.
 * @param {ArrayBuffer} buf
 * @returns {number}
 */
export function parseNativeSampleRate(buf) {
    if (buf.byteLength < 10) return 0;
    const view = new DataView(buf);

    // ── WAV: "RIFF" … "WAVE", sample rate at byte 24 (LE uint32) ──
    if (buf.byteLength >= 28 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57415645) {
        return view.getUint32(24, true);
    }

    // ── FLAC: "fLaC", STREAMINFO sample rate = 20 bits at byte 18 ──
    if (buf.byteLength >= 21 && view.getUint32(0) === 0x664C6143) {
        return (view.getUint8(18) << 12) | (view.getUint8(19) << 4) | (view.getUint8(20) >> 4);
    }

    // ── OGG: "OggS", then Vorbis or Opus inside first page ──
    if (view.getUint32(0) === 0x4F676753 && buf.byteLength >= 64) {
        const nSegments = view.getUint8(26);
        const dataOffset = 27 + nSegments;
        if (buf.byteLength >= dataOffset + 16) {
            const b0 = view.getUint8(dataOffset);
            // Vorbis identification header: type 0x01, then "vorbis"
            if (b0 === 0x01 && view.getUint32(dataOffset + 1) === 0x766F7262 /* "vorb" */) {
                return view.getUint32(dataOffset + 12, true);
            }
            // OpusHead: "OpusHead", sample rate at byte 12 of header
            if (view.getUint32(dataOffset) === 0x4F707573 /* "Opus" */ &&
                view.getUint32(dataOffset + 4) === 0x48656164 /* "Head" */) {
                return view.getUint32(dataOffset + 12, true);
            }
        }
    }

    // ── MP3: optional ID3v2 tag, then first MPEG frame sync ──
    // Sample rate is encoded in bits 11-10 of the 4-byte frame header.
    {
        const MP3_SAMPLE_RATES = [
            [11025, 12000, 8000],   // MPEG 2.5 (version bits = 00)
            [0, 0, 0],              // reserved  (version bits = 01)
            [22050, 24000, 16000],  // MPEG 2    (version bits = 10)
            [44100, 48000, 32000],  // MPEG 1    (version bits = 11)
        ];
        let scanStart = 0;
        // Skip ID3v2 tag ("ID3" + syncsafe 4-byte size at offset 6)
        if (view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) {
            const id3Size = ((view.getUint8(6) & 0x7F) << 21) |
                            ((view.getUint8(7) & 0x7F) << 14) |
                            ((view.getUint8(8) & 0x7F) << 7)  |
                             (view.getUint8(9) & 0x7F);
            scanStart = 10 + id3Size;
        }
        const scanEnd = Math.min(buf.byteLength - 3, scanStart + 4096);
        for (let i = scanStart; i < scanEnd; i++) {
            if (view.getUint8(i) !== 0xFF || (view.getUint8(i + 1) & 0xE0) !== 0xE0) continue;
            const h = view.getUint32(i);
            const version = (h >>> 19) & 0x3;
            const layer   = (h >>> 17) & 0x3;
            const srIndex = (h >>> 10) & 0x3;
            if (version === 0x1 || layer === 0x0 || srIndex === 0x3) continue; // reserved
            return MP3_SAMPLE_RATES[version][srIndex];
        }
    }

    return 0;
}

export function escapeHtml(value) {
    return String(value ?? '')
        .split('&').join('&amp;')
        .split('<').join('&lt;')
        .split('>').join('&gt;')
        .split('"').join('&quot;')
        .split("'").join('&#39;');
}
