import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveformRenderer } from '../src/app/player/WaveformRenderer.ts';

// Band-filtered waveform state in the renderer (CodeRabbit review of PR #188).
const SR = 48_000;
function buf(seed) {
    const data = Float32Array.from({ length: SR }, (_, i) => Math.sin(i * (0.1 + seed * 0.01)));
    return { sampleRate: SR, length: data.length, duration: 1, numberOfChannels: 1, getChannelData: () => data };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function renderer(state) {
    return new WaveformRenderer({
        d: { amplitudeCanvas: null, waveformTimelineCanvas: null, waveformContent: null, overviewCanvas: null, overviewContainer: null, freqLabels: null, amplitudeLabels: null },
        getAudioBuffer: () => state.buffer,
        getAmplitudePeakAbs: () => 1,
        getPixelsPerSecond: () => 100,
        getShowWaveform: () => false,
        getShowOverview: () => false,
        getShowWaveformTimeline: () => false,
        getEffectiveWaveformHeight: () => 100,
        getEffectiveSpectrogramHeight: () => 200,
        getCoords: () => ({ freqViewMin: 2000, freqViewMax: 8000, boundedMaxFreq: 10_000 }),
        scheduleUiUpdate: () => {},
        getWaveformDisplay: () => ({ scale: 'linear', reference: 'peak', dbRange: 60, rms: true, band: 'visible' }),
    });
}

/** The filter module is imported on first use; give it time to load. */
async function loaded(wr) { wr.inspectBand(); await wait(300); }

test('a pending band is shown as pending from the start, before any band is ready', async () => {
    const state = { buffer: buf(1) };
    const wr = renderer(state);
    const first = wr.inspectBand();
    assert.equal(first.source, null, 'nothing filtered yet: raw signal drawn');
    assert.match(first.pendingLabel, /2\.0.8\.0 kHz/, 'badge announces the band while the filter loads');
    await loaded(wr);
    assert.match(wr.inspectBand().pendingLabel, /2\.0.8\.0 kHz/, '… and while it computes');
});

test('switching recordings while a band is pending computes the band of the new samples right away', async () => {
    const a = buf(1), b = buf(2);
    const state = { buffer: a };
    const wr = renderer(state);
    await loaded(wr);
    wr.inspectBand();                 // band requested for A
    state.buffer = b;
    wr.inspectBand();                 // same band, new samples: must replace A's request
    await wait(700);
    const now = wr.inspectBand();
    assert.ok(now.source && !now.source.pending, 'band of B ready');
    assert.ok(now.readySamples === b.getChannelData(0));
});

test('the ready band of a replaced recording is released', async () => {
    const a = buf(3), b = buf(4);
    const state = { buffer: a };
    const wr = renderer(state);
    await loaded(wr);
    wr.inspectBand();
    await wait(700);
    assert.ok(wr.inspectBand().readySamples === a.getChannelData(0));
    state.buffer = b;
    assert.ok(wr.inspectBand().readySamples === null, 'A no longer held once B is shown');
    // A new file starting to load (resetOverview) also lets go of the ready band.
    state.buffer = a;
    wr.inspectBand();
    assert.ok(wr.inspectBand().readySamples === a.getChannelData(0), 'A cached again');
    wr.resetOverview();
    state.buffer = null;
    assert.ok(wr.inspectBand().readySamples === null);
});
