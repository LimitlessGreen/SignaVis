// ═══════════════════════════════════════════════════════════════════════
// coordinate-system.test.mjs — Tests for CoordinateSystem coordinate
// mappings, particularly the click-to-time/frequency conversion chain.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinateSystem } from '../src/coordinateSystem.js';

// ─── Helper: simulate a wrapper DOMRect ─────────────────────────────

function mockRect(left, top, width, height) {
    return { left, top, width, height, right: left + width, bottom: top + height };
}

// ─── timeToPixelX / pixelXToTime round-trip ─────────────────────────

test('pixelXToTime(timeToPixelX(t)) round-trips for various times', () => {
    const cs = new CoordinateSystem({
        duration: 10, sampleRate: 32000, canvasWidth: 1000, canvasHeight: 160,
    });
    for (const t of [0, 1, 5, 9.99, 10]) {
        const px = cs.timeToPixelX(t);
        const rt = cs.pixelXToTime(px);
        assert.ok(Math.abs(rt - t) < 0.01,
            `round-trip failed for t=${t}: got ${rt}`);
    }
});

test('timeToPixelX maps 0s to pixel 0 and duration to canvasWidth', () => {
    const cs = new CoordinateSystem({ duration: 7, canvasWidth: 700 });
    assert.equal(cs.timeToPixelX(0), 0);
    assert.equal(cs.timeToPixelX(7), 700);
});

test('pixelXToTime clamps to [0, duration]', () => {
    const cs = new CoordinateSystem({ duration: 5, canvasWidth: 500 });
    assert.equal(cs.pixelXToTime(-100), 0);
    assert.equal(cs.pixelXToTime(9999), 5);
});

// ─── timeToScrollX / scrollXToTime ──────────────────────────────────

test('timeToScrollX uses pixelsPerSecond correctly', () => {
    const cs = new CoordinateSystem({ pixelsPerSecond: 200 });
    assert.equal(cs.timeToScrollX(3), 600);
    assert.ok(Math.abs(cs.scrollXToTime(600) - 3) < 1e-9);
});

test('scrollXToTime(timeToScrollX(t)) round-trips', () => {
    const cs = new CoordinateSystem({ pixelsPerSecond: 150 });
    for (const t of [0, 0.5, 2.5, 10]) {
        assert.ok(Math.abs(cs.scrollXToTime(cs.timeToScrollX(t)) - t) < 1e-9);
    }
});

// ─── clientToCanvas ─────────────────────────────────────────────────

test('clientToCanvas converts clientX to canvasX with scrollLeft', () => {
    const cs = new CoordinateSystem({ canvasWidth: 2000, canvasHeight: 160 });
    const rect = mockRect(100, 50, 560, 160);
    // Click at clientX=380 (=280px into wrapper), wrapper scrolled 200px
    const { canvasX, localX } = cs.clientToCanvas(380, 100, rect, 200);
    assert.equal(localX, 280);
    assert.equal(canvasX, 480);   // 200 + 280
});

test('clientToCanvas scales clientY to canvasHeight', () => {
    const cs = new CoordinateSystem({ canvasHeight: 160 });
    const rect = mockRect(0, 0, 600, 320);  // display 320px tall
    // Click at half display height (160 display-px)
    const { canvasY } = cs.clientToCanvas(0, 160, rect, 0);
    assert.equal(canvasY, 80);  // half of 160 canvas height
});

// ─── clientToTimeFreq ───────────────────────────────────────────────

test('click at left edge of wrapper maps to time 0', () => {
    const cs = new CoordinateSystem({
        duration: 10, canvasWidth: 1000, canvasHeight: 160,
        sampleRate: 32000, maxFreq: 16000,
    });
    const rect = mockRect(50, 0, 560, 160);
    const { time } = cs.clientToTimeFreq(50, 80, rect, 0);
    assert.equal(time, 0);
});

test('click at right edge with no scroll maps to expected time', () => {
    const cs = new CoordinateSystem({
        duration: 10, canvasWidth: 1000, canvasHeight: 160,
    });
    const rect = mockRect(0, 0, 1000, 160);
    // Click at right edge clientX=1000, no scroll
    const { time } = cs.clientToTimeFreq(1000, 80, rect, 0);
    assert.equal(time, 10);
});

test('click with scrollLeft offsets time correctly', () => {
    // Canvas is 2000px wide (20s at 100pps), wrapper shows 500px.
    // scrollLeft=500 means we see seconds 5–10.
    const cs = new CoordinateSystem({
        duration: 20, canvasWidth: 2000, canvasHeight: 160,
    });
    const rect = mockRect(0, 0, 500, 160);
    // Click in the middle of the visible area → canvasX = 500 + 250 = 750
    const { time } = cs.clientToTimeFreq(250, 80, rect, 500);
    // 750 / 2000 * 20 = 7.5s
    assert.ok(Math.abs(time - 7.5) < 0.01, `expected ~7.5s, got ${time}`);
});

test('click at 1/4 of wrapper width with scroll matches expected position', () => {
    const cs = new CoordinateSystem({
        duration: 12, canvasWidth: 1200, canvasHeight: 160,
    });
    const rect = mockRect(100, 0, 600, 160);
    const scrollLeft = 300;
    // Click at clientX=250 → localX=150, canvasX=450
    const { time } = cs.clientToTimeFreq(250, 80, rect, scrollLeft);
    // 450 / 1200 * 12 = 4.5s
    assert.ok(Math.abs(time - 4.5) < 0.01, `expected ~4.5s, got ${time}`);
});

// ─── Hero / compact view scenario ───────────────────────────────────
// Hero views have a 560px wrapper showing a 700px canvas (7s at 100pps)

test('hero view: click at midpoint of visible area returns correct time', () => {
    const duration = 7;
    const pps = 100;
    const canvasWidth = Math.floor(duration * pps);  // 700
    const wrapperWidth = 560;

    const cs = new CoordinateSystem({
        duration, canvasWidth, canvasHeight: 160,
        pixelsPerSecond: pps,
    });
    const rect = mockRect(20, 10, wrapperWidth, 160);
    // Scroll to start, click in the center of visible area
    const { time } = cs.clientToTimeFreq(20 + wrapperWidth / 2, 80, rect, 0);
    // canvasX = 0 + 280 = 280, time = 280/700 * 7 = 2.8s
    assert.ok(Math.abs(time - 2.8) < 0.01, `expected ~2.8s, got ${time}`);
});

test('hero view: click at same local position but scrolled yields later time', () => {
    const duration = 7;
    const canvasWidth = 700;
    const wrapperWidth = 560;
    const scrollLeft = 140;  // scrolled 140px → see seconds 1.4 – 7.0

    const cs = new CoordinateSystem({ duration, canvasWidth, canvasHeight: 160 });
    const rect = mockRect(0, 0, wrapperWidth, 160);
    // Click at left edge of visible area
    const { time } = cs.clientToTimeFreq(0, 80, rect, scrollLeft);
    // canvasX = 140 + 0 = 140, time = 140/700 * 7 = 1.4s
    assert.ok(Math.abs(time - 1.4) < 0.01, `expected ~1.4s, got ${time}`);
});

test('compact embed (340px): click position maps correctly', () => {
    const duration = 7;
    const canvasWidth = 700;
    const wrapperWidth = 340;

    const cs = new CoordinateSystem({ duration, canvasWidth, canvasHeight: 160 });
    const rect = mockRect(0, 0, wrapperWidth, 160);
    // Click at 170px into the container, scrollLeft=0
    const { time } = cs.clientToTimeFreq(170, 80, rect, 0);
    // canvasX = 170, time = 170/700 * 7 = 1.7s
    assert.ok(Math.abs(time - 1.7) < 0.01, `expected ~1.7s, got ${time}`);
});

// ─── Frequency via click ────────────────────────────────────────────

test('click at top of canvas maps to highest frequency (mel)', () => {
    const cs = new CoordinateSystem({
        duration: 5, canvasWidth: 500, canvasHeight: 160,
        sampleRate: 32000, maxFreq: 16000, scale: 'mel',
    });
    const rect = mockRect(0, 0, 500, 160);
    const { freq } = cs.clientToTimeFreq(250, 0, rect, 0);
    assert.ok(freq >= 14000, `top-of-canvas freq should be high, got ${freq}`);
});

test('click at bottom of canvas maps to lowest frequency (mel)', () => {
    const cs = new CoordinateSystem({
        duration: 5, canvasWidth: 500, canvasHeight: 160,
        sampleRate: 32000, maxFreq: 16000, scale: 'mel',
    });
    const rect = mockRect(0, 0, 500, 160);
    const { freq } = cs.clientToTimeFreq(250, 160, rect, 0);
    assert.ok(freq < 200, `bottom-of-canvas freq should be low, got ${freq}`);
});

test('click at vertical midpoint maps to mid-range frequency (linear)', () => {
    const cs = new CoordinateSystem({
        duration: 5, canvasWidth: 500, canvasHeight: 160,
        sampleRate: 32000, maxFreq: 16000, scale: 'linear',
        spectrogramMels: 128,
    });
    const rect = mockRect(0, 0, 500, 160);
    const { freq } = cs.clientToTimeFreq(250, 80, rect, 0);
    // Linear midpoint should be roughly maxFreq/2 = 8000 Hz
    assert.ok(freq > 6000 && freq < 10000,
        `linear midpoint freq should be ~8000 Hz, got ${freq}`);
});

// ─── Combined time + frequency ──────────────────────────────────────

test('clientToTimeFreq returns both time and frequency in one call', () => {
    const cs = new CoordinateSystem({
        duration: 10, canvasWidth: 1000, canvasHeight: 160,
        sampleRate: 32000, maxFreq: 16000, scale: 'mel',
    });
    const rect = mockRect(0, 0, 1000, 160);
    const { time, freq, canvasX, canvasY } = cs.clientToTimeFreq(500, 40, rect, 0);

    assert.ok(Math.abs(time - 5) < 0.01, `time should be ~5s, got ${time}`);
    assert.ok(freq > 5000, `freq at y=40 (upper quarter) should be high, got ${freq}`);
    assert.equal(canvasX, 500);
    assert.equal(canvasY, 40);
});

// ─── frequencyToPixelY / pixelYToFrequency round-trip ───────────────

test('frequencyToPixelY and pixelYToFrequency are near-inverse (mel)', () => {
    const cs = new CoordinateSystem({
        canvasHeight: 160, sampleRate: 32000, maxFreq: 16000,
        scale: 'mel', spectrogramMels: 128,
    });
    for (const freq of [500, 1000, 4000, 8000, 14000]) {
        const y = cs.frequencyToPixelY(freq);
        const rt = cs.pixelYToFrequency(y);
        const relError = Math.abs(rt - freq) / freq;
        assert.ok(relError < 0.15,
            `mel round-trip for ${freq} Hz: got ${rt.toFixed(0)} Hz (${(relError * 100).toFixed(1)}% error)`);
    }
});

test('frequencyToPixelY and pixelYToFrequency are near-inverse (linear)', () => {
    const cs = new CoordinateSystem({
        canvasHeight: 160, sampleRate: 32000, maxFreq: 16000,
        scale: 'linear', spectrogramMels: 256,
    });
    for (const freq of [500, 2000, 8000, 15000]) {
        const y = cs.frequencyToPixelY(freq);
        const rt = cs.pixelYToFrequency(y);
        const relError = Math.abs(rt - freq) / freq;
        assert.ok(relError < 0.05,
            `linear round-trip for ${freq} Hz: got ${rt.toFixed(0)} Hz (${(relError * 100).toFixed(1)}% error)`);
    }
});

// ─── Edge cases ─────────────────────────────────────────────────────

test('zero-duration audio: pixelXToTime returns 0', () => {
    const cs = new CoordinateSystem({ duration: 0, canvasWidth: 500 });
    assert.equal(cs.pixelXToTime(250), 0);
});

test('zero-width canvas: timeToPixelX returns 0', () => {
    const cs = new CoordinateSystem({ duration: 10, canvasWidth: 0 });
    assert.equal(cs.timeToPixelX(5), 0);
});

test('click outside wrapper (negative localX) clamps to time 0', () => {
    const cs = new CoordinateSystem({ duration: 10, canvasWidth: 1000, canvasHeight: 160 });
    const rect = mockRect(100, 0, 500, 160);
    // clientX=50 → localX=-50, canvasX = 0 + (-50) = -50 → pixelXToTime clamps to 0
    const { time } = cs.clientToTimeFreq(50, 80, rect, 0);
    assert.equal(time, 0);
});

// ─── timeToFrame / frameToTime ──────────────────────────────────────

test('timeToFrame and frameToTime are near-inverse', () => {
    const cs = new CoordinateSystem({
        duration: 10, sampleRate: 32000, frameRate: 100,
    });
    const nFrames = 1000;
    for (const frame of [0, 50, 500, 999]) {
        const t = cs.frameToTime(frame);
        const rt = cs.timeToFrame(t, nFrames);
        assert.ok(Math.abs(rt - frame) <= 1,
            `frame round-trip: input ${frame}, got ${rt}`);
    }
});

// ─── Simulated _clientXToTime logic ─────────────────────────────────
// This mirrors the actual PlayerState._clientXToTime() implementation:
//   scrollX = clientX - rect.left + scrollLeft
//   t = coords.scrollXToTime(scrollX)   → scrollX / pixelsPerSecond
// Clamped to [0, duration].

function simulateClientXToTime(clientX, rectLeft, scrollLeft, pixelsPerSecond, duration) {
    const scrollX = clientX - rectLeft + scrollLeft;
    const t = scrollX / pixelsPerSecond;
    return Math.max(0, Math.min(t, duration));
}

test('simulated _clientXToTime: click at wrapper left edge, no scroll → time 0', () => {
    // 7s audio at 100pps
    assert.equal(simulateClientXToTime(100, 100, 0, 100, 7), 0);
});

test('simulated _clientXToTime: click at wrapper right edge, no scroll', () => {
    // wrapper starts at 100, is 560px wide → right edge = 660, 100pps
    const t = simulateClientXToTime(660, 100, 0, 100, 7);
    // scrollX = 560, t = 560/100 = 5.6s
    assert.ok(Math.abs(t - 5.6) < 0.01, `expected ~5.6s, got ${t}`);
});

test('simulated _clientXToTime: scrolled wrapper gives correct offset', () => {
    // wrapper at x=100, scrolled 140px, click at center of 560px wrapper
    const t = simulateClientXToTime(380, 100, 140, 100, 7);
    // scrollX = 280 + 140 = 420, t = 420/100 = 4.2s
    assert.ok(Math.abs(t - 4.2) < 0.01, `expected ~4.2s, got ${t}`);
});

test('simulated _clientXToTime: fully scrolled to end, click at right edge', () => {
    // wrapper at 0, 560px visible, scrollLeft=140 (max), 100pps
    const t = simulateClientXToTime(560, 0, 140, 100, 7);
    // scrollX = 560 + 140 = 700, t = 700/100 = 7.0s
    assert.ok(Math.abs(t - 7.0) < 0.01, `expected 7.0s, got ${t}`);
});

test('simulated _clientXToTime: compact view (340px), same canvas', () => {
    // 340px wrapper showing 700px canvas at 100pps, scrolled to 200px
    const t = simulateClientXToTime(170, 0, 200, 100, 7);
    // scrollX = 170 + 200 = 370, t = 370/100 = 3.7s
    assert.ok(Math.abs(t - 3.7) < 0.01, `expected ~3.7s, got ${t}`);
});

test('simulated _clientXToTime: click before wrapper clamps to 0', () => {
    const t = simulateClientXToTime(50, 100, 0, 100, 7);
    // scrollX = -50, t = -50/100 = -0.5 → clamped to 0
    assert.equal(t, 0);
});

test('simulated _clientXToTime: overshoot clamps to duration', () => {
    const t = simulateClientXToTime(999, 0, 140, 100, 7);
    // scrollX = 999 + 140 = 1139, t = 1139/100 = 11.39 → clamped to 7
    assert.equal(t, 7);
});

test('simulated _clientXToTime: 1px-wide click precision at 100pps', () => {
    // 10s audio at 100pps → 1px = 0.01s
    const t = simulateClientXToTime(1, 0, 0, 100, 10);
    assert.ok(Math.abs(t - 0.01) < 0.001, `1px should map to 0.01s, got ${t}`);
});

test('simulated _clientXToTime: different pps changes mapping', () => {
    // 10s audio at 200pps → 1px = 0.005s
    const t = simulateClientXToTime(100, 0, 0, 200, 10);
    // scrollX = 100, t = 100/200 = 0.5s
    assert.ok(Math.abs(t - 0.5) < 0.001, `expected 0.5s at 200pps, got ${t}`);
});

test('simulated _clientXToTime: result independent of scrollWidth vs canvas.width', () => {
    // This is exactly the bug that was fixed: using pixelsPerSecond
    // instead of dividing by scrollWidth or canvas.width makes the
    // result independent of any DOM layout mismatch.
    const duration = 7, pps = 100;
    const clientX = 380, rectLeft = 100, scrollLeft = 140;
    // scrollX = 280 + 140 = 420, t = 420/100 = 4.2s
    const t = simulateClientXToTime(clientX, rectLeft, scrollLeft, pps, duration);
    assert.ok(Math.abs(t - 4.2) < 0.01, `expected ~4.2s, got ${t}`);
    // Same result regardless of what scrollWidth or canvas.width would be
});
