/**
 * Annota-JSON (Xeno-canto annotation set format, version Fv0) — payload builder + local validation.
 *
 * Pure functions: no DOM, no fetch. The XC panel resolves set/profile/labels and calls
 * buildAnnotaPayload(); the result can be exported as a file or POSTed to XC.
 *
 * Fv0 rules mirrored here:
 * - recording metadata (location, date, device) comes from XC via xc_nr — no recording context;
 * - errors (upload blocked): xc_nr, start_time, end_time, scientific_name;
 * - warnings: set_name, set_creator, set_owner, set_license, annotator, frequency_low/high,
 *   sound_type, sex, life_stage, annotation_remarks;
 * - scope = [{ taxon_coverage, completeness: 'all' | 'part' }].
 */

export const ANNOTA_SET_FIELDS = [
    'set_source', 'set_uri', 'set_name', 'annotation_software_name_and_version',
    'set_creator', 'set_creator_id', 'set_owner', 'set_license',
    'project_uri', 'project_name', 'funding', 'set_remarks', 'scope', 'annotations',
] as const;

export const ANNOTA_ANNOTATION_FIELDS = [
    'annotation_source_id', 'xc_nr', 'sound_file', 'annotator', 'annotator_xc_id',
    'start_time', 'end_time', 'frequency_low', 'frequency_high', 'scientific_name',
    'sound_type', 'date_identified', 'sex', 'life_stage', 'animal_seen', 'playback_used',
    'collection_date', 'collection_specimen', 'temperature', 'annotation_remarks', 'overlap',
] as const;

export const ANNOTA_REQUIRED_ANNOTATION_FIELDS = ['xc_nr', 'start_time', 'end_time', 'scientific_name'] as const;
export const ANNOTA_WARN_SET_FIELDS = ['set_name', 'set_creator', 'set_owner', 'set_license'] as const;
export const ANNOTA_WARN_ANNOTATION_FIELDS = [
    'annotator', 'frequency_low', 'frequency_high', 'sound_type', 'sex', 'life_stage', 'annotation_remarks',
] as const;


const str = (v: any) => (v == null ? '' : String(v).trim());

/** 'XC12345' / 'xc 12345' / 12345 → '12345' */
export function normalizeXcNr(v: any) {
    return str(v).replace(/^xc\s*/i, '');
}

/** Yes/no-ish values → 'y' | 'n' | '' (unknown). */
export function toYesNo(v: any): 'y' | 'n' | '' {
    if (v === true) return 'y';
    if (v === false) return 'n';
    const s = str(v).toLowerCase();
    if (['y', 'yes', 'true', '1', 'ja', 'j'].includes(s)) return 'y';
    if (['n', 'no', 'false', '0', 'nein'].includes(s)) return 'n';
    return '';
}

/** 'all' | 'part' | '' — accepts legacy free-text values ('complete', 'partial', …). */
export function normalizeCompleteness(v: any): 'all' | 'part' | '' {
    const s = str(v).toLowerCase();
    if (!s) return '';
    if (['all', 'complete', 'completely', 'full', 'all sounds'].includes(s)) return 'all';
    if (['part', 'partial', 'partly', 'incomplete', 'some'].includes(s)) return 'part';
    return '';
}

/** Bare XC contributor ID from an ID or contributor URI. */
export function xcContributorId(v: any) {
    const s = str(v);
    const m = s.match(/xeno-canto\.org\/contributor\/([^/?#\s]+)/i);
    return m ? m[1] : s;
}

/** Comma-/semicolon-separated owner input → normalized list string (format still to be confirmed by XC). */
export function normalizeOwnerList(v: any) {
    const items = Array.isArray(v) ? v : str(v).split(/[;,]/);
    return items.map(str).filter(Boolean).join(', ');
}

function freqValue(v: any) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(1) : null;
}

function isoDate(v: any) {
    if (v == null || v === '') return '';
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Labels whose frequency range was never set explicitly (e.g. full-band) carry `freqUnset`. */
function labelFrequencies(l: any) {
    if (l?.freqUnset || l?.tags?.freqUnset) return { low: null, high: null };
    // AI detections (BirdNET) span 0–Nyquist: a time-only label, not a measured frequency range
    if (l?.aiSuggested && !(Number(l?.freqMin) > 0)) return { low: null, high: null };
    const low = freqValue(l?.freqMin);
    const high = freqValue(l?.freqMax);
    // freqMin = freqMax = 0 means "not set" in older data
    if (low === '0.0' && (high === null || high === '0.0')) return { low: null, high: null };
    return { low, high };
}

export interface AnnotaSetInput {
    name?: string; source?: string; uri?: string; license?: string;
    creator?: string; creatorId?: string; owner?: any;
    projectName?: string; projectUri?: string; funding?: string; remarks?: string;
    taxonCoverage?: string; completeness?: string;
}

export interface AnnotaBuildOptions {
    set: AnnotaSetInput;
    labels: any[];
    /** xc_nr used for labels without their own `xc_nr`/`xcId` */
    defaultXcNr?: any;
    softwareNameAndVersion?: string;
    now?: Date;
}

export function buildAnnotaAnnotation(l: any, ctx: { defaultXcNr?: any; annotator?: string; annotatorXcId?: string; index?: number }) {
    const tags = l?.tags || {};
    const { low, high } = labelFrequencies(l);
    const ann: any = {
        annotation_source_id: str(l?.id) || String((ctx.index ?? 0) + 1),
        xc_nr: normalizeXcNr(l?.xc_nr ?? l?.xcId ?? ctx.defaultXcNr),
        sound_file: str(l?.sound_file ?? l?.soundFile),
        annotator: str(l?.author) || str(ctx.annotator),
        annotator_xc_id: xcContributorId(ctx.annotatorXcId),
        start_time: Number(l.start).toFixed(6),
        end_time: Number(l.end).toFixed(6),
        frequency_low: low,
        frequency_high: high,
        scientific_name: str(l?.scientificName ?? l?.scientific_name),
        sound_type: str(tags.soundType),
        date_identified: isoDate(l?.updatedAt ?? l?.createdAt),
        sex: str(tags.sex),
        life_stage: str(tags.lifeStage),
        animal_seen: toYesNo(tags.animalSeen),
        playback_used: toYesNo(tags.playbackUsed),
        collection_date: '',
        collection_specimen: '',
        temperature: '',
        annotation_remarks: [str(tags.remarks), tags.referenceXc ? `compared with ${str(tags.referenceXc)}` : '']
            .filter(Boolean).join('; '),
        overlap: toYesNo(tags.overlap),
    };
    if (ann.frequency_low === null) delete ann.frequency_low;
    if (ann.frequency_high === null) delete ann.frequency_high;
    return ann;
}

/** Build an Annota-JSON Fv0 set payload. Labels without start/end are skipped. */
export function buildAnnotaPayload(opts: AnnotaBuildOptions) {
    const s = opts.set || {};
    const now = opts.now || new Date();
    const annotator = str(s.creator);
    const annotations = (opts.labels || [])
        .filter((l: any) => l && l.start != null && l.end != null)
        .map((l: any, i: number) => buildAnnotaAnnotation(l, {
            defaultXcNr: opts.defaultXcNr, annotator, annotatorXcId: s.creatorId, index: i,
        }));

    return {
        set_source: str(s.source),
        set_uri: str(s.uri),
        set_name: str(s.name) || `SignaVis annotations ${now.toISOString().slice(0, 16)}`,
        annotation_software_name_and_version: opts.softwareNameAndVersion || 'SignaVis',
        set_creator: annotator,
        set_creator_id: xcContributorId(s.creatorId),  // bare ID; XC flags the URI form as invalid
        set_owner: normalizeOwnerList(s.owner),
        set_license: str(s.license),
        project_uri: str(s.projectUri),
        project_name: str(s.projectName),
        funding: str(s.funding),
        set_remarks: str(s.remarks),
        scope: [{ taxon_coverage: str(s.taxonCoverage), completeness: normalizeCompleteness(s.completeness) }],
        annotations,
    };
}

export interface AnnotaIssue { level: 'error' | 'warning'; field: string; index?: number; message: string }

/** Local equivalent of XC's "Verify": errors block the upload, warnings don't. */
export function validateAnnotaPayload(payload: any) {
    const issues: AnnotaIssue[] = [];
    for (const f of ANNOTA_WARN_SET_FIELDS) {
        if (!str(payload?.[f])) issues.push({ level: 'warning', field: f, message: `Set field "${f}" is empty.` });
    }
    const anns = Array.isArray(payload?.annotations) ? payload.annotations : [];
    if (!anns.length) issues.push({ level: 'error', field: 'annotations', message: 'No annotations.' });
    anns.forEach((a: any, index: number) => {
        for (const f of ANNOTA_REQUIRED_ANNOTATION_FIELDS) {
            const v = str(a?.[f]);
            if (!v || ((f === 'start_time' || f === 'end_time') && !Number.isFinite(Number(v)))) {
                issues.push({ level: 'error', field: f, index, message: `Annotation ${index + 1}: "${f}" is missing.` });
            }
        }
        if (Number(a?.end_time) <= Number(a?.start_time)) {
            issues.push({ level: 'error', field: 'end_time', index, message: `Annotation ${index + 1}: end_time must be after start_time.` });
        }
        for (const f of ANNOTA_WARN_ANNOTATION_FIELDS) {
            if (!str(a?.[f])) issues.push({ level: 'warning', field: f, index, message: `Annotation ${index + 1}: "${f}" is empty.` });
        }
    });
    const errors = issues.filter((i) => i.level === 'error');
    const warnings = issues.filter((i) => i.level === 'warning');
    return { ok: errors.length === 0, errors, warnings };
}

/**
 * `original_set_metadata` from XC exports: Fv0 uses an array; older payloads used a single object.
 * Returns the list of set-metadata objects (possibly empty).
 */
export function readOriginalSetMetadata(src: any): any[] {
    const m = src?.original_set_metadata;
    if (Array.isArray(m)) return m.filter((x) => x && typeof x === 'object');
    if (m && typeof m === 'object') return [m];
    return [];
}
