// ═══════════════════════════════════════════════════════════════════════
// domain/fileMetadata.ts — readable metadata chunks of a WAV file, for display
//
//   - GUANO (`guan`): every key (bat detectors, many ARUs)
//   - BWF `bext`: description, originator, reference, date/time, coding history
//   - RIFF `LIST/INFO`: title, artist, comment, date, software, …
//   - AudioMoth: its comment (ICMT, or the first bytes of a converted file)
//   - iXML: the raw block is long XML; only a few common fields are taken
// Nothing here interprets the values (that is recordingTime.ts / recording-context.ts).
// ═══════════════════════════════════════════════════════════════════════

export type MetadataSource = 'GUANO' | 'BWF' | 'WAV INFO' | 'AudioMoth' | 'iXML';

export interface MetadataGroup {
    source: MetadataSource;
    entries: [string, string][];
}

const MAX_CHUNK = 1 << 20;
const HEAD_BYTES = 1 << 18;

const ascii = (b: Uint8Array, p: number, n: number) => String.fromCharCode(...b.subarray(p, p + n));
const text = (b: Uint8Array) => new TextDecoder('utf-8').decode(b).replace(/\0[\s\S]*$/, '').trim();

/** RIFF INFO ids → readable names (EXIF-style list used by most tools). */
export const INFO_NAMES: Record<string, string> = {
    INAM: 'Title', IART: 'Artist', ICMT: 'Comment', ICRD: 'Created', ISFT: 'Software', ICOP: 'Copyright',
    IPRD: 'Product', IGNR: 'Genre', IKEY: 'Keywords', ISBJ: 'Subject', ISRC: 'Source', IENG: 'Engineer',
    ITCH: 'Technician', ICMS: 'Commissioned', ISRF: 'Source form', IMED: 'Medium', ILNG: 'Language', ITRK: 'Track',
};

const AUDIOMOTH = /Recorded at [^\0]*?by AudioMoth[^\0]*/;

function guanoEntries(b: Uint8Array): [string, string][] {
    const out: [string, string][] = [];
    for (const line of new TextDecoder('utf-8').decode(b).split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim().replace(/\0+$/, '');
        if (key && value && key !== 'GUANO|Version') out.push([key, value]);
    }
    return out;
}

function bextEntries(b: Uint8Array): [string, string][] {
    if (b.length < 338) return [];
    const out: [string, string][] = [];
    const add = (k: string, v: string) => { if (v) out.push([k, v]); };
    add('Description', text(b.subarray(0, 256)));
    add('Originator', text(b.subarray(256, 288)));
    add('Reference', text(b.subarray(288, 320)));
    const d = text(b.subarray(320, 330));
    const t = text(b.subarray(330, 338));
    add('Origination', [d, t].filter(Boolean).join(' '));
    if (b.length > 602) add('Coding history', text(b.subarray(602)));
    return out;
}

function iXmlEntries(b: Uint8Array): [string, string][] {
    const xml = text(b);
    const out: [string, string][] = [];
    for (const [tag, name] of [['PROJECT', 'Project'], ['SCENE', 'Scene'], ['TAKE', 'Take'], ['TAPE', 'Tape'], ['NOTE', 'Note']]) {
        const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        if (m && m[1].trim()) out.push([name, m[1].trim()]);
    }
    return out;
}

/** All metadata groups found in the file; [] for files without any (or non-WAV without an AudioMoth comment). */
export function readFileMetadata(buffer: ArrayBuffer | Uint8Array | null): MetadataGroup[] {
    if (!buffer) return [];
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const groups: MetadataGroup[] = [];
    const push = (source: MetadataSource, entries: [string, string][]) => {
        if (!entries.length) return;
        const g = groups.find((x) => x.source === source);
        if (g) g.entries.push(...entries); else groups.push({ source, entries });
    };
    try {
        const isWav = bytes.length >= 12 && ['RIFF', 'RF64'].includes(ascii(bytes, 0, 4)) && ascii(bytes, 8, 4) === 'WAVE';
        if (isWav) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let p = 12; p + 8 <= bytes.length;) {
                const id = ascii(bytes, p, 4);
                const size = view.getUint32(p + 4, true);
                if (size === 0xffffffff) break;
                if (size <= MAX_CHUNK) {
                    const b = bytes.subarray(p + 8, Math.min(bytes.length, p + 8 + size));
                    if (id === 'guan') push('GUANO', guanoEntries(b));
                    else if (id === 'bext') push('BWF', bextEntries(b));
                    else if (id === 'iXML') push('iXML', iXmlEntries(b));
                    else if (id === 'LIST' && b.length >= 4 && ascii(b, 0, 4) === 'INFO') {
                        const bv = new DataView(b.buffer, b.byteOffset, b.byteLength);
                        const info: [string, string][] = [];
                        for (let q = 4; q + 8 <= b.length;) {
                            const sid = ascii(b, q, 4);
                            const n = bv.getUint32(q + 4, true);
                            const value = text(b.subarray(q + 8, q + 8 + n));
                            if (value) {
                                if (sid === 'ICMT' && AUDIOMOTH.test(value)) push('AudioMoth', [['Comment', value]]);
                                else info.push([INFO_NAMES[sid] || sid, value]);
                            }
                            q += 8 + n + (n & 1);
                        }
                        push('WAV INFO', info);
                    }
                }
                p += 8 + size + (size & 1);
            }
        }
        if (!groups.some((g) => g.source === 'AudioMoth')) {
            const m = new TextDecoder('latin1').decode(bytes.subarray(0, HEAD_BYTES)).match(AUDIOMOTH);
            if (m) push('AudioMoth', [['Comment', m[0].trim()]]);
        }
    } catch (err) {
        console.warn('Could not read file metadata', err);
    }
    return groups;
}
