// ═══════════════════════════════════════════════════════════════════════
// channels.ts — which channel(s) of a multichannel recording are shown and analysed
//
// One selection drives every display and analysis path (spectrogram,
// waveform, detectors, snap, ...), so what the user sees is what the models
// hear. Playback is not affected.
// ═══════════════════════════════════════════════════════════════════════

import { channelData } from './utils.ts';
import { prefs } from '../infrastructure/storage/prefs.ts';

export type ChannelSelection = { mode: 'mix' } | { mode: 'single'; channel: number };

export const DEFAULT_CHANNEL_SELECTION: ChannelSelection = { mode: 'mix' };
const STORAGE_KEY = 'sv-channel-selection';

/** Stable string form, also used as cache key: "mix" or "ch:<n>". */
export function channelSelectionKey(sel: ChannelSelection): string {
    return sel.mode === 'mix' ? 'mix' : `ch:${sel.channel}`;
}

export function parseChannelSelection(raw: string | null | undefined): ChannelSelection {
    if (raw === 'mix') return { mode: 'mix' };
    const m = /^ch:(\d{1,3})$/.exec(raw ?? '');
    return m ? { mode: 'single', channel: Number(m[1]) } : DEFAULT_CHANNEL_SELECTION;
}

/** The selection actually applied to a buffer with `n` channels (out-of-range → mix). */
export function effectiveSelection(sel: ChannelSelection, n: number): ChannelSelection {
    if (n <= 1) return { mode: 'single', channel: 0 };
    if (sel.mode === 'single' && sel.channel >= n) return { mode: 'mix' };
    return sel;
}

/** Arithmetic mean of the channels. */
export function mixChannels(channels: ArrayLike<number>[], length: number): Float32Array {
    const out = new Float32Array(length);
    if (!channels.length) return out;
    for (const ch of channels) for (let i = 0; i < length; i++) out[i] += ch[i];
    const k = 1 / channels.length;
    for (let i = 0; i < length; i++) out[i] *= k;
    return out;
}

// ── Global selection ────────────────────────────────────────────────────

let current: ChannelSelection = load();
const listeners = new Set<(sel: ChannelSelection) => void>();

function load(): ChannelSelection {
    try { return parseChannelSelection(prefs.get(STORAGE_KEY)); }
    catch { return DEFAULT_CHANNEL_SELECTION; }
}

export function getChannelSelection(): ChannelSelection { return current; }

export function setChannelSelection(sel: ChannelSelection): void {
    if (channelSelectionKey(sel) === channelSelectionKey(current)) return;
    current = sel;
    prefs.set(STORAGE_KEY, channelSelectionKey(sel));
    for (const fn of listeners) fn(sel);
}

export function onChannelSelectionChange(fn: (sel: ChannelSelection) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// ── Samples ─────────────────────────────────────────────────────────────

const mixCache = new WeakMap<AudioBuffer, Float32Array>();

/**
 * Samples of `buf` for the given (default: current) selection. Mono buffers and
 * single-channel picks return the cached channel array; the mix is computed once
 * per buffer. Read-only use.
 */
export function selectedSamples(buf: AudioBuffer, sel: ChannelSelection = current): Float32Array {
    const eff = effectiveSelection(sel, buf.numberOfChannels);
    if (eff.mode === 'single') return channelData(buf, eff.channel);
    let mix = mixCache.get(buf);
    if (!mix) {
        const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => channelData(buf, c));
        mix = mixChannels(chans, buf.length);
        mixCache.set(buf, mix);
    }
    return mix;
}

/** True when `buf` with this selection is exactly channel 0 (the native fast paths read only that). */
export function isChannelZero(buf: AudioBuffer, sel: ChannelSelection = current): boolean {
    const eff = effectiveSelection(sel, buf.numberOfChannels);
    return eff.mode === 'single' && eff.channel === 0;
}

/**
 * Cache-key parameters for data derived from the selected samples: a sample fingerprint
 * alone may not tell channels apart, so multichannel files add the effective selection.
 */
export function withChannelKey<T extends object>(params: T, nChannels: number, sel: ChannelSelection = current): T | (T & { channels: string }) {
    if (nChannels <= 1) return params;
    return { ...params, channels: channelSelectionKey(effectiveSelection(sel, nChannels)) };
}

/** Public form of a selection: 'mix', 'left' (= 0), 'right' (= 1) or a 0-based channel index. */
export type ChannelOption = 'mix' | 'left' | 'right' | number;

/** ChannelOption → ChannelSelection; null for anything invalid. */
export function toChannelSelection(v: unknown): ChannelSelection | null {
    if (v === 'mix') return { mode: 'mix' };
    if (v === 'left') return { mode: 'single', channel: 0 };
    if (v === 'right') return { mode: 'single', channel: 1 };
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000) return { mode: 'single', channel: v };
    return null;
}

/** ChannelSelection → ChannelOption ('mix' or a 0-based index). */
export function toChannelOption(sel: ChannelSelection): 'mix' | number {
    return sel.mode === 'mix' ? 'mix' : sel.channel;
}

/** Short label for UI: "Mix", "L", "R", or "Ch 3". */
export function channelLabel(sel: ChannelSelection, n: number): string {
    if (sel.mode === 'mix') return 'Mix';
    if (n === 2) return sel.channel === 0 ? 'L' : 'R';
    return `Ch ${sel.channel + 1}`;
}
