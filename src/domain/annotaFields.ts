// ═══════════════════════════════════════════════════════════════════════
// domain/annotaFields.ts — per-label Annota fields beyond box, species and the tag presets
//
// One list for every place that shows or edits them: label table, properties panel,
// label list (hidden as tag badges), XC import and the Annota upload payload.
// Values live in `label.tags[key]`; y/n fields store 'y' | 'n' | '' (unknown).
// Annotator is not in this list: it is `label.author` (+ `label.annotatorXcId`).
// ═══════════════════════════════════════════════════════════════════════

export type AnnotaFieldKind = 'text' | 'yn' | 'date';

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
}

export const ANNOTA_FIELDS: AnnotaField[] = [
    { key: 'remarks', annota: 'annotation_remarks', label: 'Remarks', short: 'Remarks', kind: 'text',
      hint: 'Free-text remarks on this annotation', visibleByDefault: true },
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

/** YYYY-MM-DD (or empty) from an ISO / Date-like value. */
export function isoDay(v: unknown): string {
    if (!v) return '';
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
