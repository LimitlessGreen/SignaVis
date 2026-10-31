// ═══════════════════════════════════════════════════════════════════════
// infrastructure/export/ravenSelectionTable.ts — Raven Pro selection tables
//
// One tab-separated table per audio file, named like Raven saves it:
//   <audio file name without extension>.Table.1.selections.txt
// Raven opens it next to the audio file (File → Open Selection Table).
// Frequencies are Hz. Labels without a frequency range span 0 … Nyquist.
// ═══════════════════════════════════════════════════════════════════════

export const RAVEN_COLUMNS = [
    'Selection', 'View', 'Channel', 'Begin Time (s)', 'End Time (s)',
    'Low Freq (Hz)', 'High Freq (Hz)', 'Species', 'Common Name', 'Sound Type',
    'Confidence', 'Annotator', 'Set', 'Label ID',
];

const clean = (v: unknown) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const num = (v: unknown, digits: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n * 10 ** digits) / 10 ** digits) : '';
};

export interface RavenOptions {
    /** Sample rate of the recording — Nyquist for labels without a frequency range. */
    sampleRate?: number | null;
    /** Set id → set name for the "Set" column. */
    setName?: (setId: string) => string;
}

/** Labels → Raven selection table text (header + one row per label, sorted by start). */
export function buildRavenSelectionTable(labels: any[], opts: RavenOptions = {}): string {
    const nyquist = opts.sampleRate ? opts.sampleRate / 2 : null;
    const rows = [...(labels || [])]
        .filter((l) => Number.isFinite(Number(l?.start)) && Number.isFinite(Number(l?.end)))
        .sort((a, b) => Number(a.start) - Number(b.start) || Number(a.end) - Number(b.end))
        .map((l, i) => {
            const hasFreq = Number(l.freqMax) > 0 && !l.freqUnset;
            const low = hasFreq ? num(l.freqMin ?? 0, 1) : '0';
            const high = hasFreq ? num(l.freqMax, 1) : (nyquist != null ? num(nyquist, 1) : '');
            const tags = l.tags || {};
            return [
                String(i + 1), 'Spectrogram 1', '1', num(l.start, 6), num(l.end, 6), low, high,
                clean(l.scientificName || l.label), clean(l.commonName),
                clean(tags.sound_type ?? tags.soundType ?? l.soundType),
                l.confidence != null && l.confidence !== '' ? num(l.confidence, 4) : '',
                clean(l.author || l.annotator), clean(l.setId ? (opts.setName?.(l.setId) || l.setId) : ''),
                clean(l.id),
            ].join('\t');
        });
    return [RAVEN_COLUMNS.join('\t'), ...rows].join('\n') + '\n';
}

/** 'aufnahmen/garten.wav' → 'aufnahmen/garten.Table.1.selections.txt' */
export function ravenTablePath(audioPath: string): string {
    const slash = audioPath.lastIndexOf('/');
    const dir = slash >= 0 ? audioPath.slice(0, slash + 1) : '';
    const name = audioPath.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    return `${dir}${dot > 0 ? name.slice(0, dot) : name}.Table.1.selections.txt`;
}
