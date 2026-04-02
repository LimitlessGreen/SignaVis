// ═══════════════════════════════════════════════════════════════════════
// xenoCantoRecordingsApi.js — Xeno-canto recordings API helpers
// ═══════════════════════════════════════════════════════════════════════

export const DEFAULT_XC_RECORDINGS_ENDPOINT = 'https://xeno-canto.org/api/3/recordings';

function firstNonEmpty(values) {
    for (const v of values) {
        const s = String(v ?? '').trim();
        if (s) return s;
    }
    return '';
}

function toFiniteNumber(value) {
    if (value == null) return NaN;
    const n = Number(String(value).replace(',', '.').trim());
    return Number.isFinite(n) ? n : NaN;
}

function resolveFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    throw new Error('No fetch implementation available.');
}

export function normalizeXcId(raw) {
    const digits = String(raw || '').replace(/\D+/g, '');
    return digits ? String(Number(digits)) : '';
}

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
    const endpoint = String(options.endpoint || DEFAULT_XC_RECORDINGS_ENDPOINT).trim();
    const url = `${endpoint}?query=nr:${clean}`;
    const apiKey = String(options.apiKey || '').trim();
    const keyHeaderName = String(options.keyHeaderName || 'key').trim() || 'key';
    /** @type {Array<Record<string,string>|undefined>} */
    const headerVariants = !apiKey
        ? [undefined]
        : [
            { [keyHeaderName]: apiKey },
            { Authorization: `Bearer ${apiKey}` },
            { 'x-api-key': apiKey },
            undefined,
        ];

    let res = null;
    let lastStatus = 0;
    for (const headers of headerVariants) {
        const candidate = await fetchFn(url, {
            headers,
        });
        res = candidate;
        lastStatus = Number(candidate?.status || 0);
        if (candidate.ok) break;
        // Try the next auth variant only for auth-related responses.
        if (lastStatus !== 401 && lastStatus !== 403) break;
    }

    if (!res || !res.ok) throw new Error(`XC API HTTP ${lastStatus || 0}`);

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
    const sampleRate = Number(options.sampleRate);
    const nyquist = Math.max(1000, Math.floor((Number.isFinite(sampleRate) ? sampleRate : 32000) / 2));
    const idPrefix = String(options.idPrefix || 'xc').trim() || 'xc';
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
            src.label,
            src.name,
            src.value,
            src.sound_type,
            src.soundType,
            src.type,
            src.event,
            src.comment,
            src.description,
            'XC label',
        ]);

        labels.push({
            id: `${idPrefix}${xcId}_lbl_${i + 1}`,
            start,
            end,
            freqMin,
            freqMax,
            label,
            scientificName,
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
