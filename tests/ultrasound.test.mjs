// ═══════════════════════════════════════════════════════════════════════
// ultrasound.test.mjs — Bat recording detection: GUANO parsing and the
// high-frequency spectrum check on synthetic tone bursts.
// ═══════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeUltrasound, parseGuano } from '../src/domain/ultrasound.ts';

/** Sparse tone bursts (5 ms every 100 ms) over faint noise — like bat calls. */
function bursts(sampleRate, freqHz, seconds = 2) {
  const out = new Float32Array(sampleRate * seconds);
  let seed = 1;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((seed / 0x7fffffff) - 0.5) * 0.002;
    const t = i / sampleRate;
    if (t % 0.1 < 0.005) out[i] += 0.5 * Math.sin(2 * Math.PI * freqHz * t);
  }
  return out;
}

function wavWithChunks(chunks) {
  const parts = chunks.map(([id, text]) => {
    const body = new TextEncoder().encode(text);
    const pad = body.length & 1;
    const buf = new Uint8Array(8 + body.length + pad);
    buf.set(new TextEncoder().encode(id), 0);
    new DataView(buf.buffer).setUint32(4, body.length, true);
    buf.set(body, 8);
    return buf;
  });
  const total = 12 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, total - 8, true);
  out.set(new TextEncoder().encode('WAVE'), 8);
  let pos = 12;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out.buffer;
}

test('detects sparse 45 kHz calls in a 384 kHz recording', () => {
  const info = analyzeUltrasound(bursts(384000, 45000), 384000);
  assert.equal(info.isUltrasonic, true);
  assert.equal(info.source, 'spectrum');
  assert.ok(Math.abs(info.peakHz - 45000) < 1000, `peak ${info.peakHz}`);
  assert.equal(info.suggestedExpansion, 10);
});

test('suggests ×16 for very high calls', () => {
  const info = analyzeUltrasound(bursts(384000, 110000), 384000);
  assert.equal(info.suggestedExpansion, 16);
});

test('audible bird song at 96 kHz is not ultrasonic', () => {
  const info = analyzeUltrasound(bursts(96000, 4000), 96000);
  assert.equal(info.isUltrasonic, false);
  assert.equal(info.suggestedExpansion, 1);
});

test('48 kHz files are never ultrasonic', () => {
  const info = analyzeUltrasound(bursts(48000, 20000), 48000);
  assert.equal(info.isUltrasonic, false);
});

test('parses GUANO and skips files already stored time-expanded', () => {
  const buf = wavWithChunks([
    ['fmt ', 'xxxxxxxxxxxxxxxx'],
    ['guan', 'GUANO|Version: 1.0\nMake: Pettersson\nModel: D500X\nTE: 10\n'],
  ]);
  const guano = parseGuano(buf);
  assert.equal(guano['Make'], 'Pettersson');
  assert.equal(guano['TE'], '10');

  const info = analyzeUltrasound(bursts(384000, 45000), 384000, guano);
  assert.equal(info.storedExpansion, 10);
  assert.equal(info.suggestedExpansion, 1);
  assert.equal(info.device, 'Pettersson D500X');
});

test('files without GUANO chunk return null', () => {
  assert.equal(parseGuano(wavWithChunks([['fmt ', 'xxxxxxxxxxxxxxxx']])), null);
  assert.equal(parseGuano(new ArrayBuffer(4)), null);
});
