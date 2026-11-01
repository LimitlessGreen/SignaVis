/**
 * Upload checklist — local equivalent of Xeno-canto's "Verify" step.
 *
 * Pure function: takes the session state relevant for an Annota-JSON upload and returns
 * one checklist step per prerequisite (API key, profile, set, recordings, labels), each with
 * issues that point at the place to fix them (set / recording / label).
 */

import { toXcId } from '../domain/xc/xcId.ts';

export type CheckStatus = 'ok' | 'warn' | 'error';
export type CheckStepId = 'key' | 'profile' | 'set' | 'recordings' | 'labels';

export interface CheckTarget { kind: 'set' | 'recording' | 'label' | 'profile' | 'key'; id?: string }

export interface CheckIssue {
    level: 'error' | 'warning';
    message: string;
    /** Places to jump to (e.g. every label missing a species). */
    targets?: CheckTarget[];
}

export interface CheckStep { id: CheckStepId; title: string; status: CheckStatus; summary: string; issues: CheckIssue[] }

export interface ChecklistRecording {
    id: string;
    name: string;
    xcNr?: string | null;
    /** Recordist from XC metadata, when known. */
    recordist?: string;
    labelCount: number;
}

export interface ChecklistInput {
    /** 'upload' checks key and ownership; 'export' (file download) skips them. */
    mode?: 'upload' | 'export';
    apiKey?: string;
    profile?: { name?: string; xcUsername?: string } | null;
    set?: { name?: string; license?: string; taxonCoverage?: string; completeness?: string } | null;
    /** Recordings that contribute labels to the set. */
    recordings: ChecklistRecording[];
    /** Result of validateAnnotaPayload() for the built payload. */
    validation: { errors: any[]; warnings: any[] };
    /** The built payload (annotation_source_id → label id for jumps). */
    payload: any;
}

export interface ChecklistResult {
    steps: CheckStep[];
    errorCount: number;
    warningCount: number;
    labelCount: number;
    recordingCount: number;
    /** No errors in any step that applies to the mode. */
    ready: boolean;
}

const str = (v: any) => String(v ?? '').trim();

/** Human-readable field names for grouped label issues. */
const LABEL_FIELD_TEXT: Record<string, string> = {
    xc_nr: 'without XC number',
    start_time: 'without start time',
    end_time: 'with invalid end time',
    scientific_name: 'without species',
    sound_type: 'without sound type',
    sex: 'without sex',
    life_stage: 'without life stage',
    frequency_low: 'without frequency range',
    frequency_high: 'without frequency range',
    annotator: 'without annotator',
};

const SET_FIELD_TEXT: Record<string, string> = {
    set_name: 'Name', set_creator: 'Creator', set_owner: 'Owner', set_license: 'License',
};

function stepStatus(issues: CheckIssue[]): CheckStatus {
    if (issues.some((i) => i.level === 'error')) return 'error';
    if (issues.length) return 'warn';
    return 'ok';
}

/** Same person? Compares names loosely (case, whitespace, punctuation). */
export function sameName(a: any, b: any) {
    const n = (v: any) => str(v).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
    return !!n(a) && n(a) === n(b);
}

export function buildUploadChecklist(input: ChecklistInput): ChecklistResult {
    const mode = input.mode ?? 'upload';
    const steps: CheckStep[] = [];
    const profile = input.profile || {};
    const anns: any[] = Array.isArray(input.payload?.annotations) ? input.payload.annotations : [];

    // 1. API key
    if (mode === 'upload') {
        const has = !!str(input.apiKey);
        steps.push({
            id: 'key', title: 'API key', status: has ? 'ok' : 'error',
            summary: has ? 'Saved' : 'Missing',
            issues: has ? [] : [{ level: 'error', message: 'Add your Xeno-canto API key.', targets: [{ kind: 'key' }] }],
        });
    }

    // 2. Profile
    {
        const issues: CheckIssue[] = [];
        if (!str(profile.name)) issues.push({ level: mode === 'upload' ? 'error' : 'warning', message: 'Your name is missing (set creator / annotator).', targets: [{ kind: 'profile' }] });
        // Optional: without it XC leaves Creator ID empty and only records the uploader from the API key (verified on acc)
        if (!str(profile.xcUsername)) issues.push({ level: 'warning', message: 'XC user ID is empty — XC will only record you as uploader, not as creator.', targets: [{ kind: 'profile' }] });
        steps.push({
            id: 'profile', title: 'Profile', status: stepStatus(issues),
            summary: [str(profile.name), str(profile.xcUsername)].filter(Boolean).join(' · ') || 'Not set',
            issues,
        });
    }

    // 3. Set
    {
        const set = input.set || {};
        const issues: CheckIssue[] = [];
        const setFields = new Set(input.validation.warnings.filter((w: any) => w.index == null).map((w: any) => w.field));
        const missing = Object.keys(SET_FIELD_TEXT).filter((f) => setFields.has(f)).map((f) => SET_FIELD_TEXT[f]);
        if (missing.length) issues.push({ level: 'warning', message: `Empty: ${missing.join(', ')}.`, targets: [{ kind: 'set' }] });
        if (!str(set.taxonCoverage)) issues.push({ level: 'warning', message: 'Focal taxon is empty.', targets: [{ kind: 'set' }] });
        if (!str(set.completeness)) issues.push({ level: 'warning', message: 'Completeness (all / part) is not chosen.', targets: [{ kind: 'set' }] });
        steps.push({
            id: 'set', title: 'Set', status: stepStatus(issues),
            summary: [str(set.name) || 'Unnamed', str(set.license), str(set.completeness)].filter(Boolean).join(' · '),
            issues,
        });
    }

    // 4. Recordings
    {
        const issues: CheckIssue[] = [];
        const noNr = input.recordings.filter((r) => !str(r.xcNr));
        if (noNr.length) {
            issues.push({
                level: 'error',
                message: `${noNr.length} recording${noNr.length > 1 ? 's' : ''} without XC number: ${noNr.map((r) => r.name).join(', ')}.`,
                targets: noNr.map((r) => ({ kind: 'recording' as const, id: r.id })),
            });
        }
        if (mode === 'upload' && str(profile.name)) {
            // Name formats differ between XC and the profile → warn instead of blocking.
            const foreign = input.recordings.filter((r) => str(r.xcNr) && str(r.recordist) && !sameName(r.recordist, profile.name));
            for (const r of foreign) {
                issues.push({
                    level: 'warning',
                    message: `${toXcId(r.xcNr)} was recorded by ${r.recordist} — XC only accepts annotations of your own recordings.`,
                    targets: [{ kind: 'recording', id: r.id }],
                });
            }
        }
        if (!input.recordings.length) issues.push({ level: 'error', message: 'No recording has labels in this set.' });
        steps.push({
            id: 'recordings', title: 'Recordings', status: stepStatus(issues),
            summary: input.recordings.map((r) => (toXcId(r.xcNr) || r.name)).join(', ') || 'None',
            issues,
        });
    }

    // 5. Labels — annotation issues grouped by field
    {
        const issues: CheckIssue[] = [];
        const group = (list: any[], level: 'error' | 'warning') => {
            const byText = new Map<string, Set<string>>();
            for (const it of list) {
                if (it.index == null) {
                    if (it.field === 'annotations') issues.push({ level, message: 'No labels in this set.' });
                    continue;
                }
                const text = LABEL_FIELD_TEXT[it.field] || `with empty "${it.field}"`;
                const id = str(anns[it.index]?.annotation_source_id);
                if (!byText.has(text)) byText.set(text, new Set());
                if (id) byText.get(text)!.add(id);
            }
            for (const [text, ids] of byText) {
                const n = ids.size || 1;
                issues.push({
                    level,
                    message: `${n} label${n > 1 ? 's' : ''} ${text}`,
                    targets: [...ids].map((id) => ({ kind: 'label' as const, id })),
                });
            }
        };
        // xc_nr errors are already reported per recording
        group(input.validation.errors.filter((e: any) => e.field !== 'xc_nr'), 'error');
        // Remarks are optional by nature — not worth a warning line
        group(input.validation.warnings.filter((w: any) => w.index != null && w.field !== 'annotation_remarks'), 'warning');
        steps.push({
            id: 'labels', title: 'Labels', status: stepStatus(issues),
            summary: `${anns.length} label${anns.length === 1 ? '' : 's'}`,
            issues,
        });
    }

    const all = steps.flatMap((s) => s.issues);
    const errorCount = all.filter((i) => i.level === 'error').length;
    return {
        steps,
        errorCount,
        warningCount: all.length - errorCount,
        labelCount: anns.length,
        recordingCount: input.recordings.length,
        ready: errorCount === 0,
    };
}
