import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseWav, decodeWavMono, readWavBlobLayout, decodeWavMonoFromBlob } from '../src/infrastructure/audio/wavDecode.ts';
import { parseFlacStreamInfo, flacBlockStarts, isFrameHeader, nextFrame, nextFrameIn, blobSource, bufferSource, readFlacHead, decodeFlacChunked } from '../src/infrastructure/audio/chunkedFlacDecode.ts';

/** Minimal AudioContext stand-in: createBuffer only. */
const fakeCtx = { createBuffer: (_c, len, sampleRate) => { const d = new Float32Array(len); return { length: len, sampleRate, getChannelData: () => d }; } };

/** Build a WAV. `samples[ch][i]` in [-1, 1). */
function makeWav({ samples, sampleRate = 48000, format = 'pcm', bytesPerSample = 2, extensible = false, rf64 = false, dataSizeOverride, oddChunk = false, trailing = null }) {
  const ch = samples.length, n = samples[0].length, block = ch * bytesPerSample;
  const dataBytes = n * block;
  const parts = [];
  const chunk = (id, body) => {
    const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32LE(body.length, 4);
    parts.push(h, body); if (body.length & 1) parts.push(Buffer.alloc(1));
  };
  if (rf64) { const b = Buffer.alloc(28); b.writeUInt32LE(dataBytes, 8); chunk('ds64', b); }
  const fmt = Buffer.alloc(extensible ? 40 : 16);
  const tag = format === 'pcm' ? 1 : 3;
  fmt.writeUInt16LE(extensible ? 0xfffe : tag, 0); fmt.writeUInt16LE(ch, 2); fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * block, 8); fmt.writeUInt16LE(block, 12); fmt.writeUInt16LE(bytesPerSample * 8, 14);
  if (extensible) { fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(bytesPerSample * 8, 18); fmt.writeUInt16LE(tag, 24); }
  chunk('fmt ', fmt);
  if (oddChunk) chunk('LIST', Buffer.from('abc'));
  const data = Buffer.alloc(dataBytes);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const at = (i * ch + c) * bytesPerSample, v = samples[c][i];
    if (format === 'float') bytesPerSample === 4 ? data.writeFloatLE(v, at) : data.writeDoubleLE(v, at);
    else if (bytesPerSample === 1) data.writeUInt8(Math.round(v * 128) + 128, at);
    else if (bytesPerSample === 2) data.writeInt16LE(Math.round(v * 32768), at);
    else if (bytesPerSample === 3) data.writeIntLE(Math.round(v * 8388608), at, 3);
    else data.writeInt32LE(Math.round(v * 2147483648), at);
  }
  const dh = Buffer.alloc(8); dh.write('data', 0, 'latin1');
  dh.writeUInt32LE(dataSizeOverride ?? (rf64 ? 0xffffffff : dataBytes), 4);
  parts.push(dh, data);
  if (trailing) chunk(trailing[0], Buffer.from(trailing[1], 'utf8'));
  const body = Buffer.concat(parts);
  const riff = Buffer.alloc(12); riff.write(rf64 ? 'RF64' : 'RIFF', 0, 'latin1'); riff.writeUInt32LE(rf64 ? 0xffffffff : body.length + 4, 4); riff.write('WAVE', 8, 'latin1');
  const all = Buffer.concat([riff, body]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

const ramp = (n, k = 1) => Float32Array.from({ length: n }, (_, i) => k * (((i * 37) % 200) / 100 - 1) * 0.9);

for (const [format, bps] of [['pcm', 1], ['pcm', 2], ['pcm', 3], ['pcm', 4], ['float', 4], ['float', 8]]) {
  test(`WAV ${format} ${bps * 8} bit stereo → mono mean`, async () => {
    const L = ramp(5000), R = ramp(5000, -0.5);
    const buf = makeWav({ samples: [L, R], format, bytesPerSample: bps, sampleRate: 22050 });
    const out = await decodeWavMono(buf, fakeCtx);
    assert.equal(out.sampleRate, 22050);
    assert.equal(out.length, 5000);
    const d = out.getChannelData(0), tol = bps === 1 ? 0.01 : 1e-4;
    for (let i = 0; i < 5000; i++) assert.ok(Math.abs(d[i] - (L[i] + R[i]) / 2) < tol, `sample ${i}: ${d[i]}`);
  });
}

test('WAV extensible, RF64, odd chunk padding, unaligned data', async () => {
  const L = ramp(3000);
  for (const opts of [{ extensible: true }, { rf64: true }, { oddChunk: true }, { oddChunk: true, extensible: true, format: 'float', bytesPerSample: 4 }]) {
    const buf = makeWav({ samples: [L], bytesPerSample: 2, ...opts });
    const out = await decodeWavMono(buf, fakeCtx);
    assert.equal(out.length, 3000, JSON.stringify(opts));
    const d = out.getChannelData(0);
    for (let i = 0; i < 3000; i += 7) assert.ok(Math.abs(d[i] - L[i]) < 1e-4, `${JSON.stringify(opts)} sample ${i}`);
  }
});

test('WAV with unfinished header (data size 0 or too large) reads to the end of the file', async () => {
  for (const size of [0, 0xffffffff, 10_000_000]) {
    const buf = makeWav({ samples: [ramp(1234)], dataSizeOverride: size });
    assert.equal(parseWav(buf).frames, 1234, `size ${size}`);
  }
});

test('WAV longer than one conversion block is complete and in order', async () => {
  const n = (1 << 20) + 4321;
  const L = ramp(n);
  const out = await decodeWavMono(makeWav({ samples: [L], sampleRate: 8000 }), fakeCtx);
  const d = out.getChannelData(0);
  for (const i of [0, 1, (1 << 20) - 1, 1 << 20, n - 1]) assert.ok(Math.abs(d[i] - L[i]) < 1e-4, `sample ${i}`);
});

test('compressed WAV (µ-law) is left to the browser decoder', () => {
  const buf = makeWav({ samples: [ramp(100)] });
  new DataView(buf).setUint16(20, 7, true); // fmt tag → µ-law
  assert.equal(parseWav(buf), null);
});

const flacFile = new URL('./fixtures/flac/short-stereo-8k.flac', import.meta.url);
const flacFrames = JSON.parse(fs.readFileSync(new URL('./fixtures/flac/short-stereo-8k.frames.json', import.meta.url)));

test('FLAC STREAMINFO and first frame', () => {
  const b = fs.readFileSync(flacFile);
  const info = parseFlacStreamInfo(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  assert.equal(info.sampleRate, 8000);
  assert.equal(info.channels, 2);
  assert.equal(info.totalSamples, 64000);
  assert.equal(info.firstFrame, flacFrames[0]);
});

test('FLAC block starts are real frame boundaries (ffprobe packet positions)', () => {
  const b = new Uint8Array(fs.readFileSync(flacFile));
  const frames = new Set(flacFrames);
  for (const blockBytes of [500, 4096, 20000, 1e9]) {
    const starts = flacBlockStarts(b, flacFrames[0], blockBytes);
    assert.equal(starts[0], flacFrames[0]);
    for (const s of starts) assert.ok(frames.has(s), `blockBytes ${blockBytes}: ${s} is not a frame start`);
    for (let k = 1; k < starts.length; k++) assert.ok(starts[k] > starts[k - 1]);
    if (blockBytes === 500) assert.ok(starts.length > 20);
  }
  // Every frame start passes the header check; no other byte in the stream does.
  let hits = 0;
  for (let i = flacFrames[0]; i < b.length; i++) if (isFrameHeader(b, i)) { hits++; assert.ok(frames.has(i), `false header at ${i}`); }
  assert.equal(hits, flacFrames.length);
});

test('FLAC frame search through small Blob windows finds the same frames as in memory', async () => {
  const b = new Uint8Array(fs.readFileSync(flacFile));
  const src = blobSource(new Blob([b]));
  for (let from = flacFrames[0]; from < b.length; from += 997) {
    assert.equal(await nextFrameIn(src, from, 40), nextFrame(b, from), `from ${from}`);
  }
  assert.equal(await nextFrameIn(src, b.length - 3, 40), b.length);
});

test('FLAC decoded from a Blob: same head and same block files as from an ArrayBuffer', async () => {
  const b = new Uint8Array(fs.readFileSync(flacFile));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  const head = await readFlacHead(blobSource(new Blob([b])));
  const ref = parseFlacStreamInfo(ab);
  assert.deepEqual(head.info, ref);
  assert.deepEqual(head, await readFlacHead(bufferSource(ab)));
  const run = async (input) => {
    const blocks = [];
    const ctx = {
      createBuffer: (ch, n, sr) => { const d = new Float32Array(n); return { length: n, sampleRate: sr, getChannelData: () => d }; },
      decodeAudioData: async (buf) => { blocks.push(new Uint8Array(buf)); return { numberOfChannels: 1, length: 100, getChannelData: () => new Float32Array(100).fill(blocks.length) }; },
    };
    // 0.1 s blocks → the 64 kB minimum: several blocks over the 138 kB fixture.
    await decodeFlacChunked(input, ctx, undefined, 0.1);
    return blocks;
  };
  const fromBlob = await run(new Blob([b]));
  const fromBuf = await run(ab.slice(0));
  assert.ok(fromBlob.length >= 2, `${fromBlob.length} blocks`);
  assert.deepEqual(fromBlob, fromBuf);
  // Block files hold the frames between flacBlockStarts boundaries.
  const starts = flacBlockStarts(b, ref.firstFrame, 1 << 16);
  assert.equal(fromBlob.length, starts.length);
  starts.forEach((s, k) => {
    const to = k + 1 < starts.length ? starts[k + 1] : b.length;
    assert.deepEqual(fromBlob[k].subarray(42), b.subarray(s, to), `block ${k}`);
  });
});

const { parseGuano } = await import('../src/domain/ultrasound.ts');
const { readRecordingStart } = await import('../src/domain/recordingTime.ts');
const { readFileMetadata } = await import('../src/domain/fileMetadata.ts');

test('WAV from a Blob: same layout, metadata and samples as reading the whole file', async () => {
  const guano = 'GUANO|Version: 1.0\nTimestamp: 2026-05-01T21:30:00+02:00\nSpecies Auto ID: Myodau\n';
  const L = ramp(300_000), R = ramp(300_000, 0.3);
  const cases = [
    { samples: [L, R], trailing: ['guan', guano] },
    { samples: [L], oddChunk: true, trailing: ['guan', guano + 'x'] },
    { samples: [L], rf64: true },
    { samples: [L], dataSizeOverride: 0 },
    { samples: [L, R], extensible: true, format: 'float', bytesPerSample: 4 },
  ];
  for (const opts of cases) {
    const buf = makeWav(opts);
    const blob = new Blob([buf]);
    const layout = await readWavBlobLayout(blob);
    const name = JSON.stringify(Object.keys(opts));
    assert.ok(layout, name);
    assert.deepEqual(layout.info, parseWav(buf), name);
    assert.ok(layout.skeleton.byteLength < 4096, `${name}: skeleton has no audio`);
    assert.deepEqual(parseGuano(layout.skeleton), parseGuano(buf), name);
    assert.deepEqual(readRecordingStart(layout.skeleton, 'x.wav'), readRecordingStart(buf, 'x.wav'), name);
    assert.deepEqual(readFileMetadata(layout.skeleton), readFileMetadata(buf), name);
    const a = await decodeWavMono(buf, fakeCtx), b = await decodeWavMonoFromBlob(blob, layout.info, fakeCtx);
    assert.deepEqual(b.getChannelData(0), a.getChannelData(0), name);
  }
  assert.ok(parseGuano(makeWav(cases[0])), 'fixture has GUANO after the data chunk');
});

test('readWavBlobLayout: not a WAV → null', async () => {
  assert.equal(await readWavBlobLayout(new Blob([new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0])])), null);
});
