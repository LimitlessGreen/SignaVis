// ═══════════════════════════════════════════════════════════════════════
// waveform-renderer.test.mjs — Unit tests for WaveformRenderer
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveformRenderer } from '../src/app/player/WaveformRenderer.ts';
import { CoordinateSystem } from '../src/domain/coordinateSystem.ts';

// ── Minimal browser-API stubs ────────────────────────────────────────

if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        createElement: (tag) => ({
            tagName: (tag || '').toUpperCase(),
            width: 0, height: 0,
            style: { setProperty: () => {} },
            getContext: () => null,
            appendChild: () => {},
        }),
        addEventListener:    () => {},
        removeEventListener: () => {},
    };
}

// ── Fake DOM elements ────────────────────────────────────────────────

function makeEl(tag = 'div') {
    return {
        tagName: tag.toUpperCase(),
        innerHTML: '',
        style: { setProperty: () => {} },
        appendChild: () => {},
        setAttribute: () => {},
        textContent: '',
    };
}

function makeCanvas() {
    return {
        tagName: 'CANVAS',
        width: 800,
        height: 200,
        style: {},
        getContext: () => null,
    };
}

function makeCoords() {
    return new CoordinateSystem({ duration: 10, sampleRate: 44100, pixelsPerSecond: 100 });
}

function makeDeps(overrides = {}) {
    let scheduleCount = 0;
    const deps = {
        d: {
            amplitudeCanvas:        makeCanvas(),
            waveformTimelineCanvas: makeCanvas(),
            waveformContent:        makeEl('div'),
            overviewCanvas:         makeCanvas(),
            overviewContainer:      makeEl('div'),
            freqLabels:             makeEl('div'),
            amplitudeLabels:        makeEl('div'),
        },
        getAudioBuffer:         () => null,
        getAmplitudePeakAbs:    () => 1,
        getPixelsPerSecond:     () => 100,
        getShowWaveform:        () => true,
        getShowOverview:        () => true,
        getShowWaveformTimeline:() => true,
        getEffectiveWaveformHeight:    () => 120,
        getEffectiveSpectrogramHeight: () => 200,
        getCoords:              () => makeCoords(),
        scheduleUiUpdate:       () => { scheduleCount++; },
        ...overrides,
    };
    return { deps, getScheduleCount: () => scheduleCount };
}

// ─── 1. Construction ─────────────────────────────────────────────────

test('WaveformRenderer: constructs without error', () => {
    const { deps } = makeDeps();
    const wr = new WaveformRenderer(deps);
    assert.ok(wr);
});

// ─── 2. drawMainWaveform skips when getShowWaveform returns false ─────

test('WaveformRenderer: drawMainWaveform does nothing when show=false', () => {
    const { deps, getScheduleCount } = makeDeps({ getShowWaveform: () => false });
    const wr = new WaveformRenderer(deps);
    wr.drawMainWaveform();
    assert.strictEqual(getScheduleCount(), 0);
});

// ─── 3. drawMainWaveform skips when no audio buffer ───────────────────

test('WaveformRenderer: drawMainWaveform skips with null audioBuffer', () => {
    const { deps, getScheduleCount } = makeDeps({ getAudioBuffer: () => null });
    const wr = new WaveformRenderer(deps);
    wr.drawMainWaveform();
    assert.strictEqual(getScheduleCount(), 0);
});

// ─── 4. drawOverviewWaveform skips when show=false ────────────────────

test('WaveformRenderer: drawOverviewWaveform does nothing when show=false', () => {
    const { deps, getScheduleCount } = makeDeps({ getShowOverview: () => false });
    const wr = new WaveformRenderer(deps);
    wr.drawOverviewWaveform();
    assert.strictEqual(getScheduleCount(), 0);
});

// ─── 5. updateAmplitudeLabels builds label elements ──────────────────

test('WaveformRenderer: updateAmplitudeLabels creates child spans', () => {
    const appended = [];
    const d = {
        amplitudeLabels: {
            innerHTML: '',
            appendChild: (el) => appended.push(el),
            style: {},
        },
    };
    const { deps } = makeDeps({ d: { ...makeDeps().deps.d, ...d } });
    const wr = new WaveformRenderer(deps);
    wr.updateAmplitudeLabels();
    assert.ok(appended.length > 0, 'should have appended label spans');
});

// ─── 6. createFrequencyLabels does not throw when d.freqLabels present ─

test('WaveformRenderer: createFrequencyLabels does not throw', () => {
    const { deps } = makeDeps();
    const wr = new WaveformRenderer(deps);
    assert.doesNotThrow(() => wr.createFrequencyLabels());
});

// ─── 7. createFrequencyLabels does not throw when freqLabels is null ──

test('WaveformRenderer: createFrequencyLabels handles null freqLabels', () => {
    const { deps } = makeDeps({
        d: { ...makeDeps().deps.d, freqLabels: null },
    });
    const wr = new WaveformRenderer(deps);
    assert.doesNotThrow(() => wr.createFrequencyLabels());
});
