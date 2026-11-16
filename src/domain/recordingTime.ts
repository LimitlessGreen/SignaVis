// ═══════════════════════════════════════════════════════════════════════
// domain/recordingTime.ts — when a recording started, from its metadata
//
// Adapted from recording-time.js in the BirdNET website demo
// (https://github.com/birdnet-team/birdnet-website, MIT License,
// Copyright (c) 2025 BirdNET-Team).
//
// Read in this order:
//   - AudioMoth comment in the WAV INFO chunk ("Recorded at 19:00:00
//     12/05/2023 (UTC+1) by AudioMoth …"), also when it survived conversion
//     to FLAC or another format (searched in the file's first bytes)
//   - GUANO "Timestamp" (Wildlife Acoustics, Titley, Pettersson and others)
//   - BWF bext origination date and time (Zoom, Tascam, Sound Devices, …)
//   - WAV INFO creation date, when it includes a time of day
//   - a date and time in the file name ("20230512_190000.WAV",
//     "SMA01234_20230512_190000.wav", "2023-05-12 19-00-00.flac")
//
// `ms` is the recorder's wall-clock time written as if it were UTC, so
// formatting never shifts it into the viewer's time zone; `tz` is the offset
// from UTC in minutes, or null when the metadata does not say.
// ═══════════════════════════════════════════════════════════════════════

export type RecordingStartSource = 'AudioMoth' | 'GUANO' | 'BWF' | 'WAV INFO' | 'fileName' | 'device';

export interface RecordingStart {
    ms: number;
    tz: number | null;
    source: RecordingStartSource;
}

const MAX_CHUNK = 1 << 16;
const HEAD_BYTES = 1 << 18;

const ascii = (b: Uint8Array, p: number, n: number) => String.fromCharCode(...b.subarray(p, p + n));
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const utf8 = (b: Uint8Array) => new TextDecoder('utf-8').decode(b).replace(/\0+$/, '');

type Num = string | number | undefined | null;

function make(y: Num, mo: Num, d: Num, h: Num, mi: Num, s: Num, frac: Num, tz: number | null, source: RecordingStartSource): RecordingStart | null {
    const [Y, MO, D, H, MI, S] = [y, mo, d, h, mi, s].map(Number);
    if (!(Y >= 1990 && Y <= 2100 && MO >= 1 && MO <= 12 && D >= 1 && D <= 31 && H <= 23 && MI <= 59 && S <= 60)) return null;
    const ms = Date.UTC(Y, MO - 1, D, H, MI, S) + (frac ? Math.round(Number(`0.${frac}`) * 1000) : 0);
    // Date.UTC rolls 31 April into May; such dates are no dates.
    if (new Date(ms).getUTCDate() !== D) return null;
    return { ms, tz, source };
}

/** "+1", "-5", "+5:30", "+0530" → minutes; null when absent. */
function tzMinutes(sign: string | undefined, hours: Num, minutes: Num): number | null {
    if (sign == null) return null;
    return (sign === '-' ? -1 : 1) * (Number(hours || 0) * 60 + Number(minutes || 0));
}

const AUDIOMOTH = /Recorded at (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? (\d{2})\/(\d{2})\/(\d{4}) \(UTC(?:([+-])(\d{1,2})(?::(\d{2}))?)?\)/;

function fromAudioMoth(text: string): RecordingStart | null {
    const m = text.match(AUDIOMOTH);
    return m ? make(m[7], m[6], m[5], m[1], m[2], m[3], m[4], tzMinutes(m[8] || '+', m[9], m[10]), 'AudioMoth') : null;
}

const ISO = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*(?:(Z)|([+-])(\d{2}):?(\d{2})?)?/;

function fromIso(text: string, source: RecordingStartSource): RecordingStart | null {
    const m = text.match(ISO);
    if (!m) return null;
    const tz = m[8] ? 0 : tzMinutes(m[9], m[10], m[11]);
    return make(m[1], m[2], m[3], m[4], m[5], m[6], m[7], tz, source);
}

function fromGuano(text: string): RecordingStart | null {
    const line = text.split(/\r?\n/).find((l) => /^Timestamp\s*:/.test(l));
    return line ? fromIso(line.replace(/^Timestamp\s*:\s*/, ''), 'GUANO') : null;
}

/** bext: OriginationDate at 320 ("yyyy-mm-dd") and OriginationTime at 330 ("hh:mm:ss"), local time. */
function fromBext(b: Uint8Array): RecordingStart | null {
    if (b.length < 338) return null;
    const d = ascii(b, 320, 10).match(/^(\d{4})\D(\d{2})\D(\d{2})$/);
    const t = ascii(b, 330, 8).match(/^(\d{2})\D(\d{2})\D(\d{2})$/);
    return d && t ? make(d[1], d[2], d[3], t[1], t[2], t[3], null, null, 'BWF') : null;
}

/** Date and time in a file name, e.g. "SMA01234_20230512_190000.wav". */
export function recordingStartFromFileName(name: string): RecordingStart | null {
    const base = (name.split(/[\\/]/).pop() || '').replace(/\.[^.]+$/, '');
    const m = base.match(/(?<!\d)(\d{4})-?(\d{2})-?(\d{2})[T_ -](\d{2})[-_:.]?(\d{2})[-_:.]?(\d{2})(?!\d)/)
        || base.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?!\d)/);
    return m ? make(m[1], m[2], m[3], m[4], m[5], m[6], null, null, 'fileName') : null;
}

/** Walk the chunks of a RIFF/WAVE file, including those after the audio data. */
function fromWav(bytes: Uint8Array): RecordingStart | null {
    if (bytes.length < 12 || !['RIFF', 'RF64'].includes(ascii(bytes, 0, 4)) || ascii(bytes, 8, 4) !== 'WAVE') return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const found: Partial<Record<'audiomoth' | 'guano' | 'bext' | 'icrd', RecordingStart | null>> = {};
    for (let p = 12; p + 8 <= bytes.length;) {
        const id = ascii(bytes, p, 4);
        const size = view.getUint32(p + 4, true);
        if (size === 0xffffffff) break; // RF64 audio data: its real size is elsewhere, and nothing we need follows
        if (size <= MAX_CHUNK && ['LIST', 'guan', 'bext'].includes(id)) {
            const b = bytes.subarray(p + 8, Math.min(bytes.length, p + 8 + size));
            if (id === 'guan') found.guano ??= fromGuano(utf8(b));
            else if (id === 'bext') found.bext ??= fromBext(b);
            else if (b.length >= 4 && ascii(b, 0, 4) === 'INFO') {
                const bv = new DataView(b.buffer, b.byteOffset, b.byteLength);
                for (let q = 4; q + 8 <= b.length;) {
                    const sid = ascii(b, q, 4);
                    const n = bv.getUint32(q + 4, true);
                    const value = utf8(b.subarray(q + 8, q + 8 + n));
                    if (sid === 'ICMT') found.audiomoth ??= fromAudioMoth(value);
                    else if (sid === 'ICRD') found.icrd ??= fromIso(value, 'WAV INFO');
                    q += 8 + n + (n & 1);
                }
            }
        }
        p += 8 + size + (size & 1);
    }
    return found.audiomoth || found.guano || found.bext || found.icrd || null;
}

/** Start of the recording in this file (bytes and/or name), or null when nothing says. */
export function readRecordingStart(buffer: ArrayBuffer | Uint8Array | null, name = ''): RecordingStart | null {
    try {
        if (buffer) {
            const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            const start = fromWav(bytes) || fromAudioMoth(latin1(bytes.subarray(0, HEAD_BYTES)));
            if (start) return start;
        }
    } catch (err) {
        console.warn('Could not read the recording start time', err);
    }
    return recordingStartFromFileName(name);
}

/** Start of a recording made on this device, in its local time. */
export function localRecordingStart(date: Date): RecordingStart {
    const tz = -date.getTimezoneOffset();
    return { ms: date.getTime() + tz * 60000, tz, source: 'device' };
}

// ── Formatting ──────────────────────────────────────────────────────

function parts(start: RecordingStart, offsetSec: number) {
    const d = new Date(start.ms + Math.round(offsetSec * 1000));
    return {
        date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`,
    };
}

/** "+01:00", "Z", or "" when the offset is unknown. */
function isoOffset(tz: number | null): string {
    if (tz == null) return '';
    if (tz === 0) return 'Z';
    const a = Math.abs(tz);
    return `${tz < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Raven selection table columns for the recorder's wall-clock time. */
export const RAVEN_CLOCK_COLUMNS = ['Begin Date', 'Begin Clock Time', 'End Clock Time'];

/** Values for RAVEN_CLOCK_COLUMNS: "2023-05-12", "19:00:03.000", "19:00:06.000". */
export function ravenClock(start: RecordingStart, beginSec: number, endSec: number): string[] {
    const b = parts(start, beginSec);
    return [b.date, b.time, parts(start, endSec).time];
}

/** "2023-05-12T19:00:03.000+01:00" (no offset when unknown). */
export function isoClockTime(start: RecordingStart, offsetSec = 0): string {
    const p = parts(start, offsetSec);
    return `${p.date}T${p.time}${isoOffset(start.tz)}`;
}

/** "UTC+1", "UTC+5:30", "UTC", or "" when unknown. */
export function utcLabel(tz: number | null): string {
    if (tz == null) return '';
    if (tz === 0) return 'UTC';
    const a = Math.abs(tz);
    return `UTC${tz < 0 ? '-' : '+'}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ''}`;
}

/** "2023-05-12 19:00:03 UTC+1" for display. */
export function formatRecordingStart(start: RecordingStart, offsetSec = 0): string {
    const p = parts(start, offsetSec);
    return [`${p.date} ${p.time.slice(0, 8)}`, utcLabel(start.tz)].filter(Boolean).join(' ');
}
