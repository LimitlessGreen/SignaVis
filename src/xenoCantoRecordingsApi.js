// ═══════════════════════════════════════════════════════════════════════
// xenoCantoRecordingsApi.js — Xeno-canto recordings API helpers
// ═══════════════════════════════════════════════════════════════════════

import {
    firstNonEmpty, toFiniteNumber, normalizeXcId, resolveFetch,
} from './xcHelpers.js';
import { DEFAULT_SAMPLE_RATE } from './constants.js';

export { normalizeXcId } from './xcHelpers.js';

export const DEFAULT_XC_RECORDINGS_ENDPOINT = 'https://xeno-canto.org/api/3/recordings';

export function getRecordingScientificName(rec) {
    if (!rec || typeof rec !== 'object') return '';
    const sci = firstNonEmpty([
        rec.scientific_name,
        rec.scientificName,
        rec.sci,
        rec.species,
    ]);
    if (sci) return sci;
    const gen = firstNonEmpty([rec.gen, rec.genus]);
    const sp = firstNonEmpty([rec.sp, rec.species_epithet]);
    return (gen && sp) ? `${gen} ${sp}` : '';
}

export async function fetchXenoCantoRecording(xcId, options = {}) {
    const clean = normalizeXcId(xcId);
    if (!clean) throw new Error('Invalid Xeno-canto ID.');

    const fetchFn = resolveFetch(options.fetchImpl);
    if (!fetchFn) throw new Error('No fetch implementation available.');
    const endpoint = String(options.endpoint || DEFAULT_XC_RECORDINGS_ENDPOINT).trim();
    const url = `${endpoint}?query=nr:${clean}`;
    const apiKey = String(options.apiKey || '').trim();
    if (!apiKey) throw new Error('XC API key missing. Open "XC API" and paste your key.');
    const requestUrl = `${url}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetchFn(requestUrl);
    if (!res.ok) {
        let msg = '';
        try {
            const body = await res.json();
            msg = firstNonEmpty([body?.message, body?.error]);
        } catch {}
        throw new Error(msg || `XC API HTTP ${Number(res.status) || 0}`);
    }

    const data = await res.json();
    const recording =
        (Array.isArray(data?.recordings) ? data.recordings[0] : null)
        || (Array.isArray(data?.results) ? data.results[0] : null)
        || (Array.isArray(data) ? data[0] : null)
        || null;

    if (!recording) throw new Error(`No XC recording found for ${clean}.`);
    return { xcId: clean, recording, raw: data };
}

export function extractXenoCantoRawLabels(recording) {
    if (!recording || typeof recording !== 'object') return [];
    const annotationSet = recording['annotation-set'] ?? recording.annotationSet ?? null;
    if (annotationSet && Array.isArray(annotationSet.annotations)) return annotationSet.annotations;

    const candidate = recording.labels
        ?? recording.label_annotations
        ?? recording.labelAnnotations
        ?? recording.annotations
        ?? recording.annotation
        ?? recording.sound_labels
        ?? recording.soundLabels
        ?? null;

    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
        if (Array.isArray(candidate.items)) return candidate.items;
        if (Array.isArray(candidate.labels)) return candidate.labels;
        if (Array.isArray(candidate.annotations)) return candidate.annotations;
    }
    return [];
}

export function mapXenoCantoLabelsToSpectrogram(rawLabels, options = {}) {
    const arr = Array.isArray(rawLabels) ? rawLabels : [];
    const xcId = normalizeXcId(options.xcId || '');
    const scientificName = getRecordingScientificName(options.recording || {});
    const recordingCommonName = firstNonEmpty([
        options?.recording?.en,
        options?.recording?.common_name,
        options?.recording?.commonName,
    ]);
    const recordist = firstNonEmpty([
        options?.recording?.rec,
        options?.recording?.recorder,
        options?.recording?.recordist,
    ]);
    const sampleRate = Number(options.sampleRate);
    const nyquist = Math.max(1000, Math.floor((Number.isFinite(sampleRate) ? sampleRate : DEFAULT_SAMPLE_RATE) / 2));
    const idPrefix = String(options.idPrefix || 'xc').trim() || 'xc';

    // Recording-level tags from XC metadata
    const rec = options.recording || {};
    const recSex = firstNonEmpty([rec.sex, rec.Sex]) || '';
    const recType = firstNonEmpty([rec.type, rec.sound_type, rec.soundType]) || '';
    const recStage = firstNonEmpty([rec.stage, rec.life_stage, rec.lifeStage, rec.age]) || '';

    const labels = [];

    for (let i = 0; i < arr.length; i += 1) {
        const src = arr[i] || {};
        const start = toFiniteNumber(src.start ?? src.begin ?? src.from ?? src.t0 ?? src.start_time ?? src.startTime);
        const end = toFiniteNumber(src.end ?? src.stop ?? src.to ?? src.t1 ?? src.end_time ?? src.endTime);
        if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) continue;

        const freqMinRaw = toFiniteNumber(src.freq_min ?? src.low_freq ?? src.f_low ?? src.min_freq ?? src.frequency_low);
        const freqMaxRaw = toFiniteNumber(src.freq_max ?? src.high_freq ?? src.f_high ?? src.max_freq ?? src.frequency_high);
        const freqMin = Number.isFinite(freqMinRaw) ? Math.max(0, freqMinRaw) : 0;
        const freqMax = Number.isFinite(freqMaxRaw) ? Math.min(nyquist, freqMaxRaw) : nyquist;
        if (!(freqMax > freqMin)) continue;

        const label = firstNonEmpty([
            src.sound_type,
            src.soundType,
            recordingCommonName,
            src.scientific_name,
            src.scientificName,
            src.label,
            src.name,
            src.value,
            src.type,
            src.event,
            src.comment,
            src.description,
            'XC label',
        ]);
        const annotationId = firstNonEmpty([src.annotation_xc_id, src.id, i + 1]);

        // Build tags: per-annotation values override recording-level values
        const tags = {};
        const sex = firstNonEmpty([src.sex, src.Sex, recSex]);
        const soundType = firstNonEmpty([src.sound_type, src.soundType, src.type, recType]);
        const lifeStage = firstNonEmpty([src.stage, src.life_stage, src.lifeStage, src.age, recStage]);
        if (sex) tags.sex = sex;
        if (soundType) tags.soundType = soundType;
        if (lifeStage) tags.lifeStage = lifeStage;

        labels.push({
            id: `${idPrefix}${xcId}_lbl_${annotationId}`,
            start,
            end,
            freqMin,
            freqMax,
            label,
            scientificName,
            commonName: recordingCommonName,
            origin: 'xeno-canto',
            author: recordist || '',
            tags,
        });
    }

    return labels;
}

export async function importXenoCantoSpectrogramLabels(xcId, options = {}) {
    const { recording, xcId: clean } = await fetchXenoCantoRecording(xcId, options);
    const rawLabels = extractXenoCantoRawLabels(recording);
    const labels = mapXenoCantoLabelsToSpectrogram(rawLabels, {
        xcId: clean,
        recording,
        sampleRate: options.sampleRate,
        idPrefix: options.idPrefix,
    });
    return { xcId: clean, recording, rawLabels, labels };
}
