import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeSampleRate } from '../src/shared/utils.ts';

function wav(sampleRate: number, extraChunks: Array<[string, number]> = []): ArrayBuffer {
    const parts: number[] = [];
    const str = (s: string) => { for (const c of s) parts.push(c.charCodeAt(0)); };
    const u32 = (v: number) => parts.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
    const u16 = (v: number) => parts.push(v & 255, (v >>> 8) & 255);
    str('RIFF'); u32(0); str('WAVE');
    for (const [id, size] of extraChunks) { str(id); u32(size); for (let i = 0; i < size + (size & 1); i++) parts.push(0x41); }
    str('fmt '); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16);
    str('data'); u32(4); u32(0);
    return new Uint8Array(parts).buffer;
}

test('WAV: fmt chunk directly after header', () => {
    assert.equal(parseNativeSampleRate(wav(48000)), 48000);
});

test('WAV: bext chunk before fmt (field recorders, XC 1197283)', () => {
    assert.equal(parseNativeSampleRate(wav(96000, [['bext', 648]])), 96000);
});

test('WAV: odd-sized chunk is padded', () => {
    assert.equal(parseNativeSampleRate(wav(44100, [['JUNK', 7], ['LIST', 30]])), 44100);
});

test('WAV without fmt chunk yields 0', () => {
    const b = new Uint8Array(wav(48000)); b.set([0x78, 0x78, 0x78, 0x78], 12); // break "fmt "
    assert.equal(parseNativeSampleRate(b.buffer), 0);
});
