// ═══════════════════════════════════════════════════════════════════════
// domain/labelFields.ts — per-label fields beyond box, species and the tag presets
//
// One list for every place that keeps, shows, edits or exports them: the label
// normalizers (layers + player), label table, properties panel, label list,
// JSON / Raven exports, XC import and the Annota upload payload. A new field is
// one entry here; tests/label-fields.test.mjs checks every consumer follows.
//
// Two kinds of fields:
//   - tag fields (ANNOTA_FIELDS): value in label.tags[key], free text / y-n / date,
//     edited by the user, uploaded to Xeno-canto Annota;
//   - property fields (PROP_FIELDS): value directly on the label (label[key]),
//     set by the app (e.g. channel), cleaned by normalize().
// Annotator is not in this list: it is label.author (+ label.annotatorXcId).
// ═══════════════════════════════════════════════════════════════════════

import { validLabelChannel } from '../shared/channels.ts';

export type AnnotaFieldKind = 'text' | 'yn' | 'date';

/** A field kept in label.tags (Annota). */
export interface AnnotaField {
    /** Key in label.tags */
    key: string;
    /** Field name in the Annota JSON */
    annota: string;
    label: string;
    /** Short column title for the table */
    short: string;
    kind: AnnotaFieldKind;
    hint: string;
    /** Shown in the table without opting in */
    visibleByDefault?: boolean;
    /** More names the value may have in imported annotations (besides `annota` and `key`). */
    importAliases?: string[];
}

export const ANNOTA_FIELDS: AnnotaField[] = [
    { key: 'remarks', annota: 'annotation_remarks', label: 'Remarks', short: 'Remarks', kind: 'text',
      hint: 'Free-text remarks on this annotation', visibleByDefault: true, importAliases: ['notes'] },
    { key: 'animalSeen', annota: 'animal_seen', label: 'Animal seen', short: 'Seen', kind: 'yn',
      hint: 'Was the individual in the annotation positively identified (seen)?' },
    { key: 'playbackUsed', annota: 'playback_used', label: 'Playback used', short: 'Playback', kind: 'yn',
      hint: 'Was playback used to lure the annotated individual?' },
    { key: 'overlap', annota: 'overlap', label: 'Overlap', short: 'Overlap', kind: 'yn',
      hint: 'Does the annotation overlap with a sound that is not annotated?' },
    { key: 'collectionDate', annota: 'collection_date', label: 'Collection date', short: 'Coll. date', kind: 'date',
      hint: 'Collection date of the annotated individual (studio recordings only)' },
    { key: 'collectionSpecimen', annota: 'collection_specimen', label: 'Collection specimen', short: 'Specimen', kind: 'text',
      hint: 'Registration number of the collected and annotated individual' },
    { key: 'temperature', annota: 'temperature', label: 'Temperature', short: 'Temp.', kind: 'text',
      hint: 'Temperature at the time of the recording (e.g. 12 °C)' },
];

export const ANNOTA_FIELD_KEYS = new Set(ANNOTA_FIELDS.map((f) => f.key));

/** Normalise a y/n value: true/yes/ja/1 → 'y', false/no/nein/0 → 'n', anything else → ''. */
export function toYN(v: unknown): 'y' | 'n' | '' {
    if (v === true) return 'y';
    if (v === false) return 'n';
    const s = String(v ?? '').trim().toLowerCase();
    if (['y', 'yes', 'true', '1', 'ja', 'j'].includes(s)) return 'y';
    if (['n', 'no', 'false', '0', 'nein'].includes(s)) return 'n';
    return '';
}

/** Checkbox toggle: checked ('y') ↔ unchecked ('n'); an unset value becomes 'y'. */
export function cycleYN(v: unknown): 'y' | 'n' {
    return toYN(v) === 'y' ? 'n' : 'y';
}

/** Display text for a field value. */
export function formatAnnotaValue(f: AnnotaField, v: unknown): string {
    if (f.kind === 'yn') {
        const c = toYN(v);
        return c === 'y' ? 'yes' : c === 'n' ? 'no' : '';  // text form (CSV, read-only views)
    }
    return String(v ?? '');
}

/** YYYY-MM-DD (or empty) from an ISO / Date-like value or epoch milliseconds. */
export function isoDay(v: unknown): string {
    if (v == null || v === '') return '';
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Annota JSON value of a tag field: y/n fields 'y' | 'n' | '', dates YYYY-MM-DD, text trimmed. */
export function annotaValue(f: AnnotaField, v: unknown): string {
    if (f.kind === 'yn') return toYN(v);
    if (f.kind === 'date') return isoDay(v);
    return v == null ? '' : String(v).trim();
}

/** { annota_name: value } of every tag field (Annota upload). */
export function annotaFieldValues(tags: Record<string, unknown> | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of ANNOTA_FIELDS) out[f.annota] = annotaValue(f, tags?.[f.key]);
    return out;
}

/**
 * Tag values of an imported annotation: per field the first non-empty of
 * src[annota], src[key], src[alias…], then fallback[key] (e.g. the recording's
 * value). Only non-empty values are returned.
 */
export function importAnnotaTags(src: Record<string, unknown> | null | undefined, fallback: Record<string, unknown> = {}): Record<string, string> {
    const out: Record<string, string> = {};
    const first = (vals: unknown[]) => vals.map((v) => (v == null ? '' : String(v).trim())).find((v) => v !== '') ?? '';
    for (const f of ANNOTA_FIELDS) {
        const v = first([src?.[f.annota], src?.[f.key], ...(f.importAliases ?? []).map((a) => src?.[a]), fallback[f.key]]);
        if (v) out[f.key] = v;
    }
    return out;
}

// ── Property fields (value on the label itself) ─────────────────────────

/** A field kept directly on the label (label[key]). */
export interface PropField {
    key: string;
    label: string;
    /** Short column title for the table */
    short: string;
    hint: string;
    /** Clean a raw value: what to keep on the label, or undefined to leave the field off. */
    normalize(v: unknown): string | number | boolean | undefined;
    /** Text for tables and CSV (value already normalized). */
    display(v: unknown): string;
    /** Sort key in the table (missing values sort first). */
    sortValue(v: unknown): number | string;
    /** Column title in CSV exports of the table. */
    csvTitle: string;
    /** Width of the table column (px). */
    width: number;
    align?: 'right';
    /** Shown in the table without opting in */
    visibleByDefault?: boolean;
    /** Raven selection table column it fills, and the value for labels without the field. */
    raven?: { column: string; value(v: unknown): string };
    /** A valid value (tests/label-fields.test.mjs sends it through every consumer). */
    example: string | number | boolean;
}

export const PROP_FIELDS: PropField[] = [
    {
        key: 'channel', label: 'Channel', short: 'Ch', csvTitle: 'Channel', width: 40, align: 'right', example: 1,
        hint: 'Channel the label was made on (1 = left, 2 = right; empty = all channels / mix)',
        normalize: validLabelChannel,
        display: (v) => (validLabelChannel(v) === undefined ? '' : String(validLabelChannel(v)! + 1)),
        sortValue: (v) => validLabelChannel(v) ?? -1,
        // Raven counts channels from 1; labels on all channels (mono, mix) go to channel 1.
        raven: { column: 'Channel', value: (v) => String((validLabelChannel(v) ?? 0) + 1) },
    },
    {
        key: 'polarity', label: 'Presence', short: 'Pres.', csvTitle: 'Presence', width: 56, example: 'absent',
        hint: 'absent = the species is not in this box (e.g. a rejected suggestion); empty = present',
        normalize: (v) => (v === 'absent' ? 'absent' : undefined),
        display: (v) => (v === 'absent' ? 'absent' : ''),
        sortValue: (v) => (v === 'absent' ? 1 : 0),
        // only written when a table has absent labels (see ravenSelectionTable.ts)
        raven: { column: 'Presence', value: (v) => (v === 'absent' ? 'absent' : 'present') },
    },
];

/**
 * The property fields of a raw label, cleaned, for spreading into a normalized
 * label: { ...labelProps(raw) }. Fields without a valid value are left off.
 */
export function labelProps(raw: unknown): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    const src = (raw ?? {}) as Record<string, unknown>;
    for (const f of PROP_FIELDS) {
        const v = f.normalize(src[f.key]);
        if (v !== undefined) out[f.key] = v;
    }
    return out;
}

/** Value for a Raven column from the property fields, or undefined when no field fills it. */
export function ravenFieldValue(column: string, label: unknown): string | undefined {
    const f = PROP_FIELDS.find((p) => p.raven?.column === column);
    return f?.raven ? f.raven.value((label as Record<string, unknown> | null)?.[f.key]) : undefined;
}
