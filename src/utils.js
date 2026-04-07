// ═══════════════════════════════════════════════════════════════════════
// utils.js — Shared utility functions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Clamp `value` to the range [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Parse `value` as a finite number, clamp to [min, max], or return `fallback`.
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

export function getAxisWidth(fallback) {
    return parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--axis-width'),
        10,
    ) || fallback;
}

export function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(4, '0')}`;
}

export function formatSecondsShort(seconds) {
    return `${seconds.toFixed(2)}s`;
}

export function isTypingContext(target) {
    if (!target || !target.tagName) return false;
    return (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
    );
}

export function getTimeGridSteps(pixelsPerSecond) {
    const majorStep =
        pixelsPerSecond >= 320 ? 0.5 :
        pixelsPerSecond >= 180 ? 1 :
        pixelsPerSecond >= 90  ? 2 :
        pixelsPerSecond >= 45  ? 5 : 10;
    return { majorStep, minorStep: majorStep / 2 };
}

export function escapeHtml(value) {
    return String(value ?? '')
        .split('&').join('&amp;')
        .split('<').join('&lt;')
        .split('>').join('&gt;')
        .split('"').join('&quot;')
        .split("'").join('&#39;');
}
