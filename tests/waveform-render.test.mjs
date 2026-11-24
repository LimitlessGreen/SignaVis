import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal canvas/DOM stand-ins: Path2D records its segments, stroke() records the path and colour.
class FakePath { constructor() { this.seg = []; } moveTo(x, y) { this.seg.push(['M', x, y]); } lineTo(x, y) { this.seg.push(['L', x, y]); } }
globalThis.Path2D = FakePath;
globalThis.document = { documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => ({ '--color-accent': '#0284c7', '--color-danger': '#dc2626' })[n] ?? '' });
globalThis.MutationObserver = class { observe() {} };
globalThis.requestAnimationFrame = () => 0;

function fakeCanvas() {
    const strokes = [];
    const ctx = {
        strokeStyle: '', fillStyle: '', lineWidth: 1, font: '', textBaseline: '', textAlign: '',
        clearRect() {}, fillRect() {}, fillText() {}, measureText: () => ({ width: 50 }),
        beginPath() {}, moveTo() {}, lineTo() {}, rect() {}, clip() {}, save() {}, restore() {},
        stroke(p) { if (p) strokes.push({ color: this.strokeStyle, seg: p.seg }); },
    };
    return { width: 0, height: 0, style: {}, dataset: {}, getContext: () => ctx, strokes };
}

function buffer(samples, sampleRate = 1000) {
    const data = Float32Array.from(samples);
    return { duration: data.length / sampleRate, sampleRate, length: data.length, numberOfChannels: 1, getChannelData: () => data };
}

async function draw(samples, display, { sampleRate = 1000, pixelsPerSecond = 100 } = {}) {
    const { renderMainWaveform } = await import('../src/ui/components/waveform/waveform.ts');
    const amp = fakeCanvas(), tl = fakeCanvas();
    renderMainWaveform({
        audioBuffer: buffer(samples, sampleRate), amplitudeCanvas: amp, waveformTimelineCanvas: tl, waveformContent: { style: {} },
        pixelsPerSecond, waveformHeight: 100, amplitudePeakAbs: samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0), showTimeline: false, display,
    });
    return amp;
}

test('positive samples are drawn above the centre line (they were drawn below)', async () => {
    const amp = await draw(Array.from({ length: 1000 }, () => 0.5), { scale: 'linear', reference: 'full', dbRange: 60, rms: false });
    const mid = amp.height / 2;
    const peak = amp.strokes.find((s) => s.color === '#0284c7' && s.seg.length > 2);
    assert.ok(peak, 'waveform path drawn');
    const ys = peak.seg.map((s) => s[2]);
    assert.ok(Math.max(...ys) < mid, `all of a positive signal above the centre (${Math.min(...ys)}..${Math.max(...ys)}, mid ${mid})`);
    // Full scale: +0.5 sits halfway between the centre and the top edge.
    assert.ok(Math.abs(Math.min(...ys) - (mid / 2 - 0.5)) < 1.01);
});

test('clipped columns get their own red path; a clean signal none', async () => {
    const clean = await draw(Array.from({ length: 1000 }, (_, i) => 0.5 * Math.sin(i / 3)), undefined);
    const red = (c) => c.strokes.filter((s) => /220, 38, 38/.test(s.color) || s.color === '#dc2626').flatMap((s) => s.seg);
    assert.equal(red(clean).length, 0);
    const clipped = await draw(Array.from({ length: 1000 }, (_, i) => (i > 400 && i < 420 ? 1 : 0.3 * Math.sin(i / 3))), undefined);
    const xs = new Set(red(clipped).map((s) => Math.floor(s[1])));
    assert.ok(xs.size >= 1 && [...xs].every((x) => x >= 39 && x <= 42), `clip marks at the clipped columns: ${[...xs]}`);
});

test('RMS body lies inside the min/max outline', async () => {
    const amp = await draw(Array.from({ length: 1000 }, (_, i) => 0.8 * Math.sin(i / 2)), { scale: 'linear', reference: 'peak', dbRange: 60, rms: true });
    const paths = amp.strokes.filter((s) => s.seg.length > 50);
    assert.equal(paths.length, 2, 'outline + RMS');
    const [outline, rms] = paths;
    const span = (p) => { const ys = p.seg.map((s) => s[2]); return Math.max(...ys) - Math.min(...ys); };
    assert.ok(span(rms) < span(outline));
});

// Square waves have RMS = amplitude, so in a full-scale view every RMS column must reach exactly
// ±amplitude: a wrong block range or a wrong denominator (e.g. the partial last block counted as
// full) shows up as a shorter column.
for (const [level, sampleRate, pixelsPerSecond] of [['fine', 12_800, 98], ['coarse', 409_600, 97]]) {
    test(`RMS from the ${level} block level, partial last block included`, async () => {
        // ~4 blocks per column (just above the level's threshold) and a loud end, so a partial last
        // block counted as a full one shortens the last column by well over the tolerance.
        const n = sampleRate * 2 + 17;
        const samples = Array.from({ length: n }, (_, i) => (i % 2 ? -1 : 1) * (i < n / 2 ? 0.2 : 0.8));
        const amp = await draw(samples, { scale: 'linear', reference: 'full', dbRange: 60, rms: true }, { sampleRate, pixelsPerSecond });
        const spp = n / amp.width;
        assert.ok(level === 'fine' ? spp >= 128 && spp < 4096 : spp >= 4096, `spp ${spp} uses the ${level} level`);
        const rms = amp.strokes.find((st) => st.color === '#0284c7' && st.seg.length > 50);
        assert.ok(rms, 'RMS path drawn');
        const cols = new Map();
        for (const [, x, y] of rms.seg) { const c = cols.get(x) ?? []; c.push(y); cols.set(x, c); }
        const mid = amp.height / 2, w = amp.width;
        for (const [x, ys] of cols) {
            const col = Math.floor(x);
            const a = col < w * 0.45 ? 0.2 : col > w * 0.55 ? 0.8 : null;   // skip the columns around the step
            if (a === null) continue;
            assert.ok(Math.abs(Math.min(...ys) - (1 - a) * mid) < 0.1 && Math.abs(Math.max(...ys) - (1 + a) * mid) < 0.1,
                `column ${col}: RMS ${ys} should span ±${a}`);
        }
        assert.ok(cols.has(w - 0.5), 'last column (partial block) drawn');
    });
}
