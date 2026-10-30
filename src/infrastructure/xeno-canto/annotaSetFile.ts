/**
 * Read an Annota-JSON set file: XC's "Download set" file or our own upload payload.
 *
 * Such files keep the set metadata (set_name, set_license, set_uri, …) once at the top, while the
 * recording API repeats it per annotation as `original_set_metadata`. The annotations are returned
 * in the API shape, grouped by XC number, so the regular XC import can map them.
 */

import { normalizeXcNr, readOriginalSetMetadata } from './annotaPayload.ts';

const SET_KEYS = ['set_name', 'set_creator', 'set_owner', 'set_license', 'set_uri', 'set_creation_date', 'set_remarks'];

export interface AnnotaSetFile {
    /** Top-level set metadata (only the keys present in the file). */
    set: Record<string, any>;
    /** Raw annotations per XC number, each with `original_set_metadata`. */
    byXcNr: Map<string, any[]>;
    /** Annotations without a usable XC number. */
    skipped: number;
}

/** Returns null when the JSON is not an annotation set (no `annotations` array). */
export function readAnnotaSetFile(json: any): AnnotaSetFile | null {
    if (!json || typeof json !== 'object' || !Array.isArray(json.annotations)) return null;
    const set: Record<string, any> = {};
    for (const k of SET_KEYS) if (json[k] != null && json[k] !== '') set[k] = json[k];

    const byXcNr = new Map<string, any[]>();
    let skipped = 0;
    for (const a of json.annotations) {
        const nr = normalizeXcNr(a?.xc_nr);
        if (!nr) { skipped += 1; continue; }
        const ann = readOriginalSetMetadata(a).length || !Object.keys(set).length
            ? a
            : { ...a, original_set_metadata: set };
        if (!byXcNr.has(nr)) byXcNr.set(nr, []);
        byXcNr.get(nr)!.push(ann);
    }
    return { set, byXcNr, skipped };
}
