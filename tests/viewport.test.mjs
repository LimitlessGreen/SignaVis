// ═══════════════════════════════════════════════════════════════════════
// viewport.test.mjs — Characterization tests for viewport-related logic
//
// Scope: DOM-free units only.
//   - FrequencyViewport  (vertical frequency zoom/pan)
//   - sanitizePlaybackViewportConfig  (follow-mode config clamping)
//
// What is NOT covered here (requires DOM / ViewportManager extraction):
//   - pixelsPerSecond zoom clamping against slider min/max
//   - windowStartNorm / windowEndNorm scroll sync
//   - Follow-mode RAF animation timing
//   - _syncOverviewWindowToViewport
//
// Those contracts will be added in tests/viewport-manager.test.mjs
// after ViewportManager is extracted from PlayerState (Phase 2).
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { FrequencyViewport } from '../src/app/FrequencyViewport.ts';
import { sanitizePlaybackViewportConfig } from '../src/app/PlayerState.ts';

// ─── FrequencyViewport ───────────────────────────────────────────────

test('FrequencyViewport: initial state is unzoomed', () => {
    const vp = new FrequencyViewport();
    assert.equal(vp.min, null);
    assert.equal(vp.max, null);
    assert.equal(vp.isZoomed, false);
});

test('FrequencyViewport: set() stores values and marks as zoomed', () => {
    const vp = new FrequencyViewport();
    vp.set(500, 8000);
    assert.equal(vp.min, 500);
    assert.equal(vp.max, 8000);
    assert.equal(vp.isZoomed, true);
});

test('FrequencyViewport: set() fires change event', () => {
    const vp = new FrequencyViewport();
    let fired = 0;
    vp.addEventListener('change', () => fired++);
    vp.set(200, 4000);
    assert.equal(fired, 1);
});

test('FrequencyViewport: reset() clears to null and fires change', () => {
    const vp = new FrequencyViewport();
    vp.set(500, 8000);
    let fired = 0;
    vp.addEventListener('change', () => fired++);
    vp.reset();
    assert.equal(vp.min, null);
    assert.equal(vp.max, null);
    assert.equal(vp.isZoomed, false);
    assert.equal(fired, 1);
});

test('FrequencyViewport: reset() is no-op (no event) when already unzoomed', () => {
    const vp = new FrequencyViewport();
    let fired = 0;
    vp.addEventListener('change', () => fired++);
    vp.reset();
    assert.equal(fired, 0);
});

test('FrequencyViewport: resetSilent() clears without firing change', () => {
    const vp = new FrequencyViewport();
    vp.set(500, 8000);
    let fired = 0;
    vp.addEventListener('change', () => fired++);
    vp.resetSilent();
    assert.equal(vp.min, null);
    assert.equal(vp.max, null);
    assert.equal(fired, 0);
});

test('FrequencyViewport: zoom in (factor > 1) reduces visible range', () => {
    const vp = new FrequencyViewport();
    vp.zoom(2, 5000, 10000);
    assert.ok(vp.min !== null && vp.max !== null, 'should be zoomed');
    const range = vp.max - vp.min;
    assert.ok(range < 10000, `range ${range} should be less than full 10000 Hz`);
});

test('FrequencyViewport: zoom anchor point stays fixed during zoom in', () => {
    const vp = new FrequencyViewport();
    const anchorFreq = 4000;
    const boundedMax = 10000;
    vp.zoom(2, anchorFreq, boundedMax);
    // Anchor should be inside the new range
    assert.ok(vp.min <= anchorFreq, `min=${vp.min} should be ≤ anchor ${anchorFreq}`);
    assert.ok(vp.max >= anchorFreq, `max=${vp.max} should be ≥ anchor ${anchorFreq}`);
});

test('FrequencyViewport: zoom out to full range resets to null', () => {
    const vp = new FrequencyViewport();
    vp.set(4500, 5500);
    // zoom out far beyond full range
    vp.zoom(0.001, 5000, 10000);
    assert.equal(vp.min, null);
    assert.equal(vp.max, null);
});

test('FrequencyViewport: zoom enforces minimum range (100 Hz)', () => {
    const vp = new FrequencyViewport();
    // extreme zoom in
    vp.zoom(100, 5000, 10000);
    const range = (vp.max ?? 10000) - (vp.min ?? 0);
    assert.ok(range >= 100, `range ${range} Hz should be ≥ 100 Hz minimum`);
});

test('FrequencyViewport: pan shifts range without changing width', () => {
    const vp = new FrequencyViewport();
    vp.set(1000, 5000);
    const width = vp.max - vp.min;
    vp.pan(500, 10000);
    assert.ok(Math.abs((vp.max - vp.min) - width) < 0.01, 'range width should not change during pan');
});

test('FrequencyViewport: pan is clamped at lower bound (0 Hz)', () => {
    const vp = new FrequencyViewport();
    vp.set(200, 3000);
    vp.pan(-5000, 10000);
    assert.ok(vp.min >= 0, `min ${vp.min} should be ≥ 0`);
});

test('FrequencyViewport: pan is clamped at upper bound (boundedMax)', () => {
    const vp = new FrequencyViewport();
    vp.set(7000, 9500);
    vp.pan(5000, 10000);
    assert.ok(vp.max <= 10000, `max ${vp.max} should be ≤ boundedMax 10000`);
});

test('FrequencyViewport: pan does nothing when not zoomed', () => {
    const vp = new FrequencyViewport();
    let fired = 0;
    vp.addEventListener('change', () => fired++);
    vp.pan(1000, 10000);
    assert.equal(fired, 0, 'should not fire change when not zoomed');
});

test('FrequencyViewport: setFromSlider(0) resets to full range', () => {
    const vp = new FrequencyViewport();
    vp.set(2000, 6000);
    vp.setFromSlider(0, 10000);
    assert.equal(vp.min, null);
    assert.equal(vp.max, null);
});

test('FrequencyViewport: setFromSlider(100) zooms in to ~5% of full range', () => {
    const vp = new FrequencyViewport();
    const boundedMax = 10000;
    vp.setFromSlider(100, boundedMax);
    const range = (vp.max ?? boundedMax) - (vp.min ?? 0);
    const minExpectedRange = boundedMax * 0.05;
    assert.ok(range <= minExpectedRange + 1, `range ${range} should be ≤ ${minExpectedRange} at max zoom`);
});

test('FrequencyViewport: setFromSlider(50) produces a range between full and max-zoom', () => {
    const vp = new FrequencyViewport();
    const boundedMax = 10000;
    vp.setFromSlider(50, boundedMax);
    const range = (vp.max ?? boundedMax) - (vp.min ?? 0);
    assert.ok(range > boundedMax * 0.05, 'range at 50% should be > max-zoom range');
    assert.ok(range < boundedMax, 'range at 50% should be < full range');
});

// ─── sanitizePlaybackViewportConfig ─────────────────────────────────

test('sanitizePlaybackViewportConfig: returns all default values for empty input', () => {
    const cfg = sanitizePlaybackViewportConfig({});
    assert.equal(cfg.followGuardLeftRatio, 0.35);
    assert.equal(cfg.followGuardRightRatio, 0.65);
    assert.equal(cfg.followTargetRatio, 0.5);
    assert.equal(cfg.followCatchupDurationMs, 240);
    assert.equal(cfg.followCatchupSeekDurationMs, 360);
    assert.equal(cfg.smoothLerp, 0.18);
    assert.equal(cfg.smoothSeekLerp, 0.08);
    assert.equal(cfg.smoothMinStepRatio, 0.03);
    assert.equal(cfg.smoothSeekMinStepRatio, 0.008);
    assert.equal(cfg.smoothSeekFocusMs, 1400);
});

test('sanitizePlaybackViewportConfig: valid values are passed through unchanged', () => {
    const cfg = sanitizePlaybackViewportConfig({
        followGuardLeftRatio: 0.2,
        followGuardRightRatio: 0.8,
        followTargetRatio: 0.6,
        smoothLerp: 0.5,
    });
    assert.equal(cfg.followGuardLeftRatio, 0.2);
    assert.equal(cfg.followGuardRightRatio, 0.8);
    assert.equal(cfg.followTargetRatio, 0.6);
    assert.equal(cfg.smoothLerp, 0.5);
});

test('sanitizePlaybackViewportConfig: clamps followGuardLeftRatio to [0.05, 0.95]', () => {
    assert.equal(sanitizePlaybackViewportConfig({ followGuardLeftRatio: -1 }).followGuardLeftRatio, 0.05);
    assert.equal(sanitizePlaybackViewportConfig({ followGuardLeftRatio: 2  }).followGuardLeftRatio, 0.95);
});

test('sanitizePlaybackViewportConfig: clamps followGuardRightRatio to [0.05, 0.95]', () => {
    assert.equal(sanitizePlaybackViewportConfig({ followGuardRightRatio: 0 }).followGuardRightRatio, 0.05);
    assert.equal(sanitizePlaybackViewportConfig({ followGuardRightRatio: 1.5 }).followGuardRightRatio, 0.95);
});

test('sanitizePlaybackViewportConfig: clamps smoothLerp to [0.02, 0.95]', () => {
    assert.equal(sanitizePlaybackViewportConfig({ smoothLerp: 0 }).smoothLerp, 0.02);
    assert.equal(sanitizePlaybackViewportConfig({ smoothLerp: 1 }).smoothLerp, 0.95);
});

test('sanitizePlaybackViewportConfig: clamps followCatchupDurationMs to [80, 2500]', () => {
    assert.equal(sanitizePlaybackViewportConfig({ followCatchupDurationMs: 0 }).followCatchupDurationMs, 80);
    assert.equal(sanitizePlaybackViewportConfig({ followCatchupDurationMs: 9999 }).followCatchupDurationMs, 2500);
});

test('sanitizePlaybackViewportConfig: non-numeric string and undefined fall back to defaults', () => {
    const cfg = sanitizePlaybackViewportConfig({
        followGuardLeftRatio: 'bad',
        followCatchupDurationMs: undefined,
    });
    assert.equal(cfg.followGuardLeftRatio, 0.35, 'string "bad" → Number("bad") = NaN → fallback');
    assert.equal(cfg.followCatchupDurationMs, 240, 'undefined → NaN → fallback');
});

test('sanitizePlaybackViewportConfig: null is coerced to 0 and clamped to minimum', () => {
    // Number(null) === 0, which is finite, so it gets clamped to the minimum (not the default)
    const cfg = sanitizePlaybackViewportConfig({ smoothLerp: null });
    assert.equal(cfg.smoothLerp, 0.02, 'null → Number(null)=0 → clamped to min 0.02, NOT the default 0.18');
});

test('sanitizePlaybackViewportConfig: current values are preserved as fallback', () => {
    const current = { followGuardLeftRatio: 0.25, smoothLerp: 0.4 };
    const cfg = sanitizePlaybackViewportConfig({}, current);
    assert.equal(cfg.followGuardLeftRatio, 0.25);
    assert.equal(cfg.smoothLerp, 0.4);
    // Keys not in current fall back to built-in defaults
    assert.equal(cfg.followTargetRatio, 0.5);
});

test('sanitizePlaybackViewportConfig: NaN falls back to default', () => {
    const cfg = sanitizePlaybackViewportConfig({ smoothSeekFocusMs: NaN });
    assert.equal(cfg.smoothSeekFocusMs, 1400);
});

test('sanitizePlaybackViewportConfig: Infinity is not finite and falls back to default', () => {
    // Number.isFinite(Infinity) === false → clampNumber returns the fallback, NOT clamps to max
    const cfg = sanitizePlaybackViewportConfig({ smoothSeekFocusMs: Infinity });
    assert.equal(cfg.smoothSeekFocusMs, 1400, 'Infinity → not finite → fallback to default 1400');
});
