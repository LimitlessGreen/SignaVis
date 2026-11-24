import test from 'node:test';
import assert from 'node:assert/strict';
import {
    amplitudeMap, amplitudeTicks, normalizeWaveformDisplay, formatAmplitude, formatDb, isClipped, peakBadge,
    DEFAULT_WAVEFORM_DISPLAY,
} from '../src/domain/waveformScale.ts';

const disp = (o) => normalizeWaveformDisplay(o);

test('linear, fit to peak: the peak reaches the edge, values scale', () => {
    const m = amplitudeMap(disp({ scale: 'linear', reference: 'peak' }), 0.012);
    assert.equal(m.map(0.012), 1);
    assert.equal(m.map(-0.012), -1);
    assert.ok(Math.abs(m.map(0.006) - 0.5) < 1e-9);
    assert.equal(m.map(0.5), 1, 'clamped');
    assert.equal(m.map(NaN), 0);
});

test('linear, full scale: ±1 at the edge regardless of the peak', () => {
    const m = amplitudeMap(disp({ reference: 'full' }), 0.012);
    assert.ok(Math.abs(m.map(0.012) - 0.012) < 1e-9);
    assert.equal(m.map(1), 1);
});

test('dB, full scale: 0 dBFS at the edge, the range floor on the centre line, mirrored', () => {
    const m = amplitudeMap(disp({ scale: 'db', reference: 'full', dbRange: 60 }), 0.01);
    assert.equal(m.top, 0);
    assert.equal(m.floor, -60);
    assert.ok(Math.abs(m.map(1) - 1) < 1e-9);
    assert.ok(Math.abs(m.map(10 ** (-30 / 20)) - 0.5) < 1e-9, '−30 dBFS → half');
    assert.equal(m.map(1e-4), 0, 'below the floor');
    assert.equal(m.map(0), 0);
    assert.ok(Math.abs(m.map(-0.1) + 2 / 3) < 1e-9, '−20 dB → −(40/60)');
});

test('dB, fit to peak: the peak sits at the edge, quiet signal well above the centre', () => {
    const m = amplitudeMap(disp({ scale: 'db', reference: 'peak', dbRange: 60 }), 0.01); // −40 dBFS
    assert.ok(Math.abs(m.top + 40) < 1e-9);
    assert.ok(Math.abs(m.map(0.01) - 1) < 1e-9);
    // Noise 20 dB under the peak: 2/3 of the height (linear would show 0.1).
    assert.ok(Math.abs(m.map(0.001) - 2 / 3) < 1e-9);
});

test('maps are monotonic (min/max columns keep their order)', () => {
    for (const d of [{ scale: 'linear' }, { scale: 'db' }, { scale: 'db', reference: 'full', dbRange: 36 }]) {
        const m = amplitudeMap(disp(d), 0.3);
        let prev = -Infinity;
        for (let v = -1.2; v <= 1.2; v += 0.0007) {
            const f = m.map(v);
            assert.ok(f >= prev - 1e-12, `${JSON.stringify(d)} at ${v}`);
            prev = f;
        }
    }
});

test('axis ticks: round values at their true positions (the old axis printed 0.01 over 0.006)', () => {
    const lin = amplitudeTicks(amplitudeMap(DEFAULT_WAVEFORM_DISPLAY, 0.0115), 78);
    assert.deepEqual(lin.map((t) => t.text), ['+0.01', '+0.005', '0', '\u22120.005', '\u22120.01']);
    const top = lin[0];
    assert.ok(Math.abs(top.frac - (1 - 0.01 / 0.0115) / 2) < 1e-9, '0.01 sits below the edge');
    const full = amplitudeTicks(amplitudeMap(normalizeWaveformDisplay({ reference: 'full' }), 0.3), 78).map((t) => t.text);
    assert.deepEqual(full, ['+1', '+0.5', '0', '\u22120.5', '\u22121']);
    const db = amplitudeTicks(amplitudeMap(normalizeWaveformDisplay({ scale: 'db', reference: 'full', dbRange: 60 }), 0.5), 78);
    assert.deepEqual(db.map((t) => t.text), ['0', '\u221220', '\u221240', '\u221240', '\u221220', '0']);
    [0, 1 / 6, 1 / 3, 2 / 3, 5 / 6, 1].forEach((f, i) => assert.ok(Math.abs(db[i].frac - f) < 1e-9, `tick ${i}`));
    const dbPeak = amplitudeTicks(amplitudeMap(normalizeWaveformDisplay({ scale: 'db' }), 0.0115), 78).map((t) => t.text);
    assert.deepEqual(dbPeak.slice(0, 3), ['\u221240', '\u221260', '\u221280']);
});

test('axis ticks: more labels on a taller view, never closer than the spacing', () => {
    for (const h of [40, 78, 160, 400]) {
        for (const d of [{}, { scale: 'db' }, { scale: 'db', reference: 'full', dbRange: 96 }]) {
            const t = amplitudeTicks(amplitudeMap(normalizeWaveformDisplay(d), 0.37), h);
            assert.ok(t.length >= 2, `${h} ${JSON.stringify(d)}`);
            const ys = t.map((x) => x.frac * h).sort((a, b) => a - b);
            for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 12.9, `${h} ${JSON.stringify(d)}: ${ys}`);
        }
    }
    const tall = amplitudeTicks(amplitudeMap(DEFAULT_WAVEFORM_DISPLAY, 1), 400);
    assert.ok(tall.length > 5);
});

test('number formatting', () => {
    assert.equal(formatAmplitude(1), '+1');
    assert.equal(formatAmplitude(0.5), '+0.5');
    assert.equal(formatAmplitude(-0.25), '−0.25');
    assert.equal(formatAmplitude(0.00012), '+0.00012');
    assert.equal(formatDb(-38.44, 1), '−38.4');
    assert.equal(formatDb(-Infinity), '−∞');
    assert.equal(formatDb(-0.04), '0');
    assert.equal(peakBadge(0.012), 'Peak −38.4 dBFS');
});

test('clipping at the full-scale edge, either polarity', () => {
    assert.ok(isClipped(-0.2, 0.99997));
    assert.ok(isClipped(-1, 0.1));
    assert.ok(!isClipped(-0.9, 0.95));
});

test('normalizeWaveformDisplay keeps valid fields and falls back for the rest', () => {
    assert.deepEqual(normalizeWaveformDisplay({ scale: 'db', reference: 'x', dbRange: '48', rms: false }),
        { scale: 'db', reference: 'peak', dbRange: 48, rms: false, band: 'full' });
    assert.deepEqual(normalizeWaveformDisplay(null), DEFAULT_WAVEFORM_DISPLAY);
    assert.equal(normalizeWaveformDisplay({ dbRange: 5 }).dbRange, 60);
});

test('axis ticks: a peak-relative dB range that is 60 only up to rounding keeps the 20 dB step', () => {
    // top − floor = 60.000000000000004 for this peak; the 20 dB step was dropped for 30 dB.
    const t = amplitudeTicks(amplitudeMap(normalizeWaveformDisplay({ scale: 'db' }), 0.0115356), 78).map((x) => x.text);
    assert.deepEqual(t, ['−40', '−60', '−80', '−80', '−60', '−40']);
});
