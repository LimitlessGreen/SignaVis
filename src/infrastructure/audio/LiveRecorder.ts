// ═══════════════════════════════════════════════════════════════════════
// LiveRecorder.ts — records the microphone as mono PCM
//
// The samples are kept as they arrive (AudioWorklet, ScriptProcessor as a
// fallback); an AnalyserNode on the same source feeds the live spectrogram.
// stop() returns a 16-bit WAV whose INFO chunk carries the start time with
// the device's UTC offset (ICRD), so readRecordingStart() finds it again
// after export or reload.
//
// Events:
//   'start'  { sampleRate }
//   'stop'   { reason: 'user' | 'limit' | 'ended' }  (the track ended, e.g. the device was unplugged)
// ═══════════════════════════════════════════════════════════════════════

import { isoClockTime, localRecordingStart } from '../../domain/recordingTime.ts';

export interface LiveRecorderOptions {
    /** Recording stops by itself after this many seconds (default 300). */
    maxSeconds?: number;
    /** Specific input device (MediaDeviceInfo.deviceId). */
    deviceId?: string;
}

export interface LiveRecording {
    file: File;
    startedAt: Date;
    duration: number;
    sampleRate: number;
}

const WORKLET = `
class SvCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('sv-capture', SvCapture);
`;

const pad = (n: number) => String(n).padStart(2, '0');

/** "Recording_20261115_143012.wav" in the device's local time. */
export function recordingFileName(d: Date): string {
    return `Recording_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.wav`;
}

/** Mono 16-bit PCM WAV with a LIST/INFO chunk (ICRD start time, ISFT software). */
export function encodeWav(chunks: Float32Array[], sampleRate: number, info: Record<string, string> = {}): Blob {
    const n = chunks.reduce((s, c) => s + c.length, 0);
    const enc = new TextEncoder();
    const subs = Object.entries(info).map(([id, value]) => {
        const v = enc.encode(value + '\0');
        const b = new Uint8Array(8 + v.length + (v.length & 1));
        for (let i = 0; i < 4; i++) b[i] = id.charCodeAt(i);
        new DataView(b.buffer).setUint32(4, v.length, true);
        b.set(v, 8);
        return b;
    });
    const infoBytes = subs.length ? 4 + subs.reduce((s, b) => s + b.length, 0) : 0;
    const listBytes = infoBytes ? 8 + infoBytes : 0;
    const dataBytes = n * 2;
    const head = new DataView(new ArrayBuffer(36 + listBytes + 8));
    const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) head.setUint8(at + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); head.setUint32(4, 36 + listBytes + 8 + dataBytes - 8, true); tag(8, 'WAVE');
    tag(12, 'fmt '); head.setUint32(16, 16, true);
    head.setUint16(20, 1, true);            // PCM
    head.setUint16(22, 1, true);            // mono
    head.setUint32(24, sampleRate, true);
    head.setUint32(28, sampleRate * 2, true);
    head.setUint16(32, 2, true);
    head.setUint16(34, 16, true);
    let o = 36;
    if (listBytes) {
        tag(o, 'LIST'); head.setUint32(o + 4, infoBytes, true); tag(o + 8, 'INFO');
        o += 12;
        for (const b of subs) { for (let i = 0; i < b.length; i++) head.setUint8(o + i, b[i]); o += b.length; }
    }
    tag(o, 'data'); head.setUint32(o + 4, dataBytes, true);
    const pcm = new Int16Array(n);
    let k = 0;
    for (const c of chunks) {
        for (let i = 0; i < c.length; i++) {
            const v = Math.max(-1, Math.min(1, c[i]));
            pcm[k++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
    }
    return new Blob([head.buffer, pcm.buffer], { type: 'audio/wav' });
}

export class LiveRecorder extends EventTarget {
    readonly maxSeconds: number;
    private readonly deviceId: string | undefined;
    private ctx: AudioContext | null = null;
    private stream: MediaStream | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private capture: AudioWorkletNode | ScriptProcessorNode | null = null;
    private mute: GainNode | null = null;
    private chunks: Float32Array[] = [];
    private samples = 0;
    private startedAt: Date | null = null;
    private stopping: Promise<LiveRecording | null> | null = null;
    analyser: AnalyserNode | null = null;
    /** Called with each block of samples as it is kept (e.g. for live detection). */
    ondata: ((chunk: Float32Array) => void) | null = null;
    sampleRate = 0;

    constructor(opts: LiveRecorderOptions = {}) {
        super();
        this.maxSeconds = opts.maxSeconds && opts.maxSeconds > 0 ? opts.maxSeconds : 300;
        this.deviceId = opts.deviceId;
    }

    static get supported(): boolean {
        return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
            && typeof AudioContext !== 'undefined';
    }

    get recording(): boolean { return !!this.startedAt && !this.stopping; }

    /** Seconds recorded so far. */
    get elapsed(): number { return this.sampleRate ? this.samples / this.sampleRate : 0; }

    get startTime(): Date | null { return this.startedAt; }

    /** Asks for the microphone and starts recording. Rejects when access is denied. */
    async start(): Promise<void> {
        if (this.startedAt) throw new Error('Already recording');
        if (!LiveRecorder.supported) throw new Error('Recording is not supported in this browser');
        if (this.stopping) throw new Error('Recording was cancelled');
        // stop()/cancel() while waiting (e.g. for microphone permission) cancels the start.
        const cancelled = () => !!this.stopping;
        // Raw signal: the browser's voice processing would remove quiet calls.
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
                echoCancellation: false, noiseSuppression: false, autoGainControl: false,
                channelCount: 1,
            },
        });
        if (cancelled()) {
            stream.getTracks().forEach((t) => t.stop());
            throw new Error('Recording was cancelled');
        }
        this.stream = stream;
        try {
            const ctx = new AudioContext();
            this.ctx = ctx;
            if (ctx.state === 'suspended') await ctx.resume();
            if (cancelled()) throw new Error('Recording was cancelled');
            this.sampleRate = ctx.sampleRate;
            this.source = ctx.createMediaStreamSource(this.stream);
            this.analyser = ctx.createAnalyser();
            this.analyser.fftSize = 2048;
            this.analyser.smoothingTimeConstant = 0;
            this.source.connect(this.analyser);
            // The capture node must reach the destination to run; silence it.
            this.mute = ctx.createGain();
            this.mute.gain.value = 0;
            this.mute.connect(ctx.destination);
            this.capture = await this.createCapture(ctx);
            if (cancelled()) throw new Error('Recording was cancelled');
            this.source.connect(this.capture);
            this.capture.connect(this.mute);
            this.stream.getAudioTracks()[0]?.addEventListener('ended', () => { void this.stop('ended'); });
            this.startedAt = new Date();
            this.dispatchEvent(new CustomEvent('start', { detail: { sampleRate: this.sampleRate } }));
        } catch (err) {
            this.release();
            throw err;
        }
    }

    private async createCapture(ctx: AudioContext): Promise<AudioWorkletNode | ScriptProcessorNode> {
        if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
            const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
            try {
                await ctx.audioWorklet.addModule(url);
                const node = new AudioWorkletNode(ctx, 'sv-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
                node.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data);
                return node;
            } catch (err) {
                console.warn('AudioWorklet unavailable, using ScriptProcessor:', err);
            } finally {
                URL.revokeObjectURL(url);
            }
        }
        const node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => this.push(e.inputBuffer.getChannelData(0).slice(0));
        return node;
    }

    private push(chunk: Float32Array): void {
        if (!this.startedAt || this.stopping) return;
        const limit = Math.round(this.maxSeconds * this.sampleRate);
        const room = limit - this.samples;
        if (room > 0) {
            const c = chunk.length > room ? chunk.subarray(0, room) : chunk;
            this.chunks.push(c);
            this.samples += c.length;
            this.ondata?.(c);
        }
        if (this.samples >= limit) void this.stop('limit');
    }

    /** Stops and returns the recording (null when nothing was recorded). */
    stop(reason: 'user' | 'limit' | 'ended' = 'user'): Promise<LiveRecording | null> {
        if (this.stopping) return this.stopping;
        let resolve!: (r: LiveRecording | null) => void;
        this.stopping = new Promise((r) => { resolve = r; });
        const startedAt = this.startedAt;
        const sampleRate = this.sampleRate;
        const chunks = this.chunks;
        const samples = this.samples;
        this.release();
        let result: LiveRecording | null = null;
        if (startedAt && samples > 0) {
            const start = localRecordingStart(startedAt);
            const blob = encodeWav(chunks, sampleRate, {
                ICRD: isoClockTime(start).replace(/\.\d{3}/, ''),
                ISFT: 'SignaVis',
            });
            const file = new File([blob], recordingFileName(startedAt), { type: 'audio/wav', lastModified: Date.now() });
            result = { file, startedAt, duration: samples / sampleRate, sampleRate };
        }
        resolve(result);
        // After `stopping` is set: listeners may call stop() again and get the same result.
        this.dispatchEvent(new CustomEvent('stop', { detail: { reason } }));
        return this.stopping;
    }

    /** Stops without keeping anything. */
    cancel(): void {
        this.chunks = [];
        this.samples = 0;
        void this.stop('user');
    }

    private release(): void {
        try { this.capture?.disconnect(); } catch { /* already gone */ }
        try { this.source?.disconnect(); } catch { /* already gone */ }
        if (this.capture && 'port' in this.capture) this.capture.port.onmessage = null;
        this.stream?.getTracks().forEach((t) => t.stop());
        void this.ctx?.close().catch(() => {});
        this.capture = null;
        this.source = null;
        this.mute = null;
        this.stream = null;
        this.ctx = null;
        this.chunks = [];
        this.samples = 0;
        // The analyser stays readable (silent) until the view lets go of it.
    }
}
