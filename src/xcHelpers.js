// ═══════════════════════════════════════════════════════════════════════
// xcHelpers.js — Shared utilities for Xeno-canto API modules
// ═══════════════════════════════════════════════════════════════════════

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeArray(value) {
    return Array.isArray(value) ? value : [];
}

export function safeString(value) {
    if (value === 0 || value === false) return String(value);
    return value == null ? '' : String(value).trim();
}

export function safeField(value) {
    if (value === 0 || value === false) return value;
    return value ?? '';
}

export function firstNonEmpty(values) {
    for (const v of values) {
        const s = String(v ?? '').trim();
        if (s) return s;
    }
    return '';
}

export function toFiniteNumber(value) {
    if (value == null) return NaN;
    const n = Number(String(value).replace(',', '.').trim());
    return Number.isFinite(n) ? n : NaN;
}

export function parseJsonSafe(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
}

export function normalizeXcId(raw) {
    const digits = String(raw || '').replace(/\D+/g, '');
    return digits ? String(Number(digits)) : '';
}

export function resolveFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    return null;
}
