// ═══════════════════════════════════════════════════════════════════════
// xenoCantoApi.js — Xeno-canto API client and payload helpers
// ═══════════════════════════════════════════════════════════════════════

import {
    sleep, safeArray, safeString, safeField,
    parseJsonSafe, resolveFetch,
} from './xcHelpers.js';

export const DEFAULT_XC_ENDPOINT = 'https://xeno-canto.org/api/3/upload/annotation-set';

/**
 * @typedef {Object} XenoCantoClientOptions
 * @property {string} [apiKey]
 * @property {string} [endpoint]
 * @property {number} [timeoutMs]
 * @property {number} [retries]
 * @property {number} [retryDelayMs]
 * @property {string} [keyHeaderName]
 * @property {string} [basicAuthCredential]
 * @property {boolean} [sendBasicAuth]
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * @typedef {Object} XenoCantoUploadResult
 * @property {boolean} ok
 * @property {number} status
 * @property {string} message
 * @property {string[]} warnings
 * @property {string[]} errors
 * @property {any} response
 * @property {string} rawText
 */

/**
 * @typedef {Object} BuildAnnotationSetParams
 * @property {Object} [metadata]
 * @property {Object[]} [annotations]
 * @property {string} [apiVersion]
 */

/**
 * @typedef {Object} BuildAnnotationSetResult
 * @property {boolean} ok
 * @property {Object|null} payload
 * @property {string[]} warnings
 * @property {string[]} errors
 */

function isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function encodeBasicAuth(credential) {
    const raw = String(credential || '');
    if (typeof btoa === 'function') return btoa(raw);
    throw new Error('No base64 encoder available for Basic auth header.');
}

function extractMessage(body, fallback = '') {
    if (!body || typeof body !== 'object') return fallback;
    if (typeof body.message === 'string' && body.message) return body.message;
    if (typeof body.status === 'string' && body.status) return body.status;
    return fallback;
}

function collectWarnings(body) {
    return safeArray(body?.warnings).map((v) => safeString(v)).filter(Boolean);
}

function collectErrors(body) {
    return safeArray(body?.errors).map((v) => safeString(v)).filter(Boolean);
}

function normalizeMetadata(metadata) {
    const m = metadata || {};
    const xcFileNo = safeString(
        m.xcfileno
        ?? m['Xeno-canto file no']
        ?? m['Xeno-canto file no:']
        ?? m['meta-xcfileno'],
    );
    return {
        xcFileNo,
        projectName: safeString(m.project ?? m.Project ?? m['meta-project'] ?? m.project_name),
        annotatorName: safeString(m.annname ?? m['Name of the Annotator'] ?? m['meta-annname'] ?? m.annotator),
        taxonCoverage: safeString(m.taxon_coverage ?? m.taxonCoverage),
        completeness: safeString(m.completeness ?? m.set_completeness),
        setName: safeString(m.setname),
        setCreator: safeString(m.setcreator),
        setLicense: safeString(m.set_license),
    };
}

function mapAnnotationRow(row, normalizedMeta) {
    const r = row || {};
    return {
        annotation_source_id: safeField(r.Selection ?? r.selection ?? r['Selection']),
        sound_file: '',
        xc_nr: safeField(normalizedMeta.xcFileNo),
        annotator: safeField(normalizedMeta.annotatorName),
        annotator_xc_id: '',
        frequency_high: safeField(r.highFreq ?? r.highfreq ?? r['High Freq (Hz)']),
        frequency_low: safeField(r.lowFreq ?? r.lowfreq ?? r['Low Freq (Hz)']),
        start_time: (r.beginTime ?? r['Begin Time (s)']) === 0 ? 0 : safeField(r.beginTime ?? r['Begin Time (s)']),
        end_time: (r.endTime ?? r['End Time (s)']) === 0 ? 0 : safeField(r.endTime ?? r['End Time (s)']),
        scientific_name: safeField(r.scientificName ?? r['Scientific Name']),
        sound_type: safeField(r.soundType ?? r['Sound type(s)']),
        date_identified: '',
        sex: safeField(r.sex ?? r['Sex']),
        life_stage: safeField(r.lifeStage ?? r['Life stage']),
        animal_seen: '',
        playback_used: '',
        collection_date: '',
        collection_specimen: '',
        temperature: '',
        annotation_remarks: safeField(r.notes ?? r['Notes']),
        overlap: '',
    };
}

export class XenoCantoApiError extends Error {
    /**
     * @param {string} message
     * @param {Object} [details]
     */
    constructor(message, details = {}) {
        super(message);
        this.name = 'XenoCantoApiError';
        this.status = Number.isFinite(details.status) ? details.status : 0;
        this.retryable = details.retryable === true;
        this.response = details.response ?? null;
        this.rawText = details.rawText ?? '';
        this.warnings = safeArray(details.warnings);
        this.errors = safeArray(details.errors);
        this.cause = details.cause;
    }
}

export class XenoCantoApiClient {
    /**
     * @param {XenoCantoClientOptions} [options]
     */
    constructor(options = {}) {
        this._apiKey = safeString(options.apiKey);
        this._endpoint = safeString(options.endpoint) || DEFAULT_XC_ENDPOINT;
        this._timeoutMs = Math.max(1000, Number(options.timeoutMs) || 20000);
        this._retries = Math.max(0, Number(options.retries) || 2);
        this._retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 500);
        this._keyHeaderName = safeString(options.keyHeaderName) || 'key';
        this._basicAuthCredential = safeString(options.basicAuthCredential) || 'xc:xc';
        this._sendBasicAuth = options.sendBasicAuth !== false;
        this._fetch = resolveFetch(options.fetchImpl);
        if (!this._fetch) {
            throw new XenoCantoApiError('No fetch implementation available.');
        }
    }

    get endpoint() { return this._endpoint; }
    get timeoutMs() { return this._timeoutMs; }
    get retries() { return this._retries; }

    /**
     * @param {string} apiKey
     */
    setApiKey(apiKey) {
        this._apiKey = safeString(apiKey);
    }

    /**
     * @param {string} endpoint
     */
    setEndpoint(endpoint) {
        this._endpoint = safeString(endpoint) || DEFAULT_XC_ENDPOINT;
    }

    /**
     * @param {number} timeoutMs
     */
    setTimeout(timeoutMs) {
        this._timeoutMs = Math.max(1000, Number(timeoutMs) || this._timeoutMs);
    }

    /**
     * @param {number} retries
     * @param {number} [retryDelayMs]
     */
    setRetryPolicy(retries, retryDelayMs = this._retryDelayMs) {
        this._retries = Math.max(0, Number(retries) || 0);
        this._retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    }

    /**
     * @param {Object} payload
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<XenoCantoUploadResult>}
     */
    async uploadAnnotationSet(payload, options = {}) {
        if (!this._apiKey) {
            throw new XenoCantoApiError('Xeno-canto API key is required.');
        }
        if (!payload || typeof payload !== 'object') {
            throw new XenoCantoApiError('Annotation set payload must be an object.');
        }

        const body = JSON.stringify(payload);
        const maxAttempts = this._retries + 1;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const result = await this._uploadOnce(body, options.signal);
                return result;
            } catch (error) {
                lastError = error;
                const isLastAttempt = attempt >= maxAttempts;
                if (!(error instanceof XenoCantoApiError) || !error.retryable || isLastAttempt) {
                    throw error;
                }
                const backoff = this._retryDelayMs * Math.pow(2, attempt - 1);
                await sleep(backoff);
            }
        }

        throw lastError || new XenoCantoApiError('Xeno-canto upload failed.');
    }

    /**
     * @param {Object} payload
     * @param {{ signal?: AbortSignal }} [options]
     */
    async uploadAnnotationSetSafe(payload, options = {}) {
        try {
            const result = await this.uploadAnnotationSet(payload, options);
            return { ok: true, result, error: null };
        } catch (error) {
            return { ok: false, result: null, error };
        }
    }

    async _uploadOnce(body, externalSignal) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort('timeout'), this._timeoutMs);
        const signal = controller.signal;

        const abortExternal = () => controller.abort('aborted');
        if (externalSignal) {
            if (externalSignal.aborted) controller.abort('aborted');
            else externalSignal.addEventListener('abort', abortExternal, { once: true });
        }

        try {
            const headers = {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                [this._keyHeaderName]: this._apiKey,
            };
            if (this._sendBasicAuth) {
                headers.Authorization = `Basic ${encodeBasicAuth(this._basicAuthCredential)}`;
            }

            const response = await this._fetch(this._endpoint, {
                method: 'POST',
                headers,
                body,
                signal,
            });

            const rawText = await response.text();
            const responseJson = parseJsonSafe(rawText);
            const warnings = collectWarnings(responseJson);
            const errors = collectErrors(responseJson);
            const message = extractMessage(responseJson, response.statusText || '');

            if (!response.ok || errors.length) {
                throw new XenoCantoApiError(
                    message || `Xeno-canto upload failed with status ${response.status}.`,
                    {
                        status: response.status,
                        retryable: isRetryableStatus(response.status),
                        response: responseJson,
                        rawText,
                        warnings,
                        errors: errors.length ? errors : [message || response.statusText || 'Upload failed'],
                    },
                );
            }

            return {
                ok: true,
                status: response.status,
                message,
                warnings,
                errors: [],
                response: responseJson,
                rawText,
            };
        } catch (error) {
            if (error instanceof XenoCantoApiError) throw error;

            const aborted = signal.aborted;
            const timeout = aborted && signal.reason === 'timeout';
            throw new XenoCantoApiError(
                timeout ? 'Xeno-canto upload timed out.' : 'Network error while uploading to Xeno-canto.',
                {
                    status: 0,
                    retryable: true,
                    errors: [error?.message || String(error)],
                    cause: error,
                },
            );
        } finally {
            clearTimeout(timeoutId);
            if (externalSignal) externalSignal.removeEventListener('abort', abortExternal);
        }
    }
}

/**
 * Build and validate a Xeno-canto annotation-set payload.
 * @param {BuildAnnotationSetParams} params
 * @returns {BuildAnnotationSetResult}
 */
export function buildXenoCantoAnnotationSet(params = {}) {
    const metadata = params.metadata || {};
    const annotations = safeArray(params.annotations);
    const warnings = [];
    const errors = [];

    const meta = normalizeMetadata(metadata);
    if (!meta.xcFileNo) errors.push("Missing metadata field 'xcfileno' (Xeno-canto file number).");
    if (!annotations.length) errors.push('No annotations provided.');

    if (errors.length) {
        return { ok: false, payload: null, warnings, errors };
    }

    const mappedAnnotations = annotations.map((row) => mapAnnotationRow(row, meta));
    const missingTimeRows = mappedAnnotations.filter((a) => a.start_time === '' || a.end_time === '');
    if (missingTimeRows.length) warnings.push(`${missingTimeRows.length} annotation(s) have missing start/end times.`);

    const payload = {
        set_source: '',
        set_uri: '',
        set_name: meta.setName,
        annotation_software_name_and_version: params.apiVersion || 'Audio Workbench',
        set_creator: meta.setCreator,
        set_creator_id: '',
        set_owner: '',
        set_license: meta.setLicense,
        project_uri: '',
        project_name: meta.projectName,
        funding: '',
        scope: [
            {
                taxon_coverage: meta.taxonCoverage,
                completeness: meta.completeness,
            },
        ],
        annotations: mappedAnnotations,
    };

    return { ok: true, payload, warnings, errors: [] };
}
