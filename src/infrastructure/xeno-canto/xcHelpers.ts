// ═══════════════════════════════════════════════════════════════════════
// xcHelpers.js — Shared utilities for Xeno-canto API modules
// ═══════════════════════════════════════════════════════════════════════

export function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function safeArray(value: unknown) {
    return Array.isArray(value) ? value : [];
}

export function safeString(value: unknown) {
    if (value === 0 || value === false) return String(value);
    return value == null ? '' : String(value).trim();
}

export function safeField(value: unknown) {
    if (value === 0 || value === false) return value;
    return value ?? '';
}

export function firstNonEmpty(values: any) {
    for (const v of values) {
        const s = String(v ?? '').trim();
        if (s) return s;
    }
    return '';
}

export function toFiniteNumber(value: unknown) {
    if (value == null) return NaN;
    const n = Number(String(value).replace(',', '.').trim());
    return Number.isFinite(n) ? n : NaN;
}

export function parseJsonSafe(text: string | null | undefined) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
}

export function normalizeXcId(raw: unknown) {
    const digits = String(raw || '').replace(/\D+/g, '');
    return digits ? String(Number(digits)) : '';
}

export function resolveFetch(fetchImpl: unknown) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    return null;
}

/** localStorage key under which the XC panel keeps the user's API key. */
export const XC_API_KEY_STORAGE = 'signavis.xc-api-key.v1';

/** The XC API key saved by the XC panel, or '' if none / storage unavailable. */
export function readStoredXcApiKey(): string {
    try { return String(globalThis.localStorage?.getItem(XC_API_KEY_STORAGE) || '').trim(); } catch { return ''; }
}
