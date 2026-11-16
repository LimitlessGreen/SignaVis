// ═══════════════════════════════════════════════════════════════════════
// ui/panels/birdbox-panel.ts — BirdBox call boxes in the Analyse tab
//
// Runs BirdBox Just-Bird once per recording at the lowest confidence and keeps
// its raw rows. The confidence and phrase-gap sliders re-fuse them instantly
// (domain/detector/fusion.ts), without another run. While detection runs, the
// windows show evenly spaced (domain/detector/pacer.ts) and finished parts of
// the recording are fused once (FusionCache).
//
// Idea and behaviour from the BirdBox tab of the BirdNET website demo
// (https://github.com/birdnet-team/birdnet-website, MIT, BirdNET-Team).
// ═══════════════════════════════════════════════════════════════════════

import { fuseBoxes, type FusedBox, type FusionCache } from '../../domain/detector/fusion.ts';
import { Pacer } from '../../domain/detector/pacer.ts';
import { SAMPLE_RATE } from '../../domain/detector/birdboxStream.ts';
import { BirdBoxDetector, laterOf, type RawRows } from '../../infrastructure/detector/birdboxDetector.ts';
import { resampleTo } from '../../infrastructure/birdnetInference.ts';

export const BIRDBOX_ORIGIN = 'BirdBox';
const MODEL_TAG = 'BirdBox Just-Bird FP16 (24632a5)';
const PREFS_KEY = 'signavis.birdbox.v1';
const BOX_COLOR = '#2fb8a8';

export interface BirdBoxPanelOptions {
    confInput: HTMLInputElement;
    confVal: HTMLElement;
    gapInput: HTMLInputElement;
    gapVal: HTMLElement;
    runBtn: HTMLButtonElement;
    progressWrap: HTMLElement;
    progressBar: HTMLElement;
    statusEl: HTMLElement;
    getAudioBuffer: () => AudioBuffer | null | undefined;
    getRecordingId: () => string | null;
    getAuthor?: () => string;
    /** Replace this recording's BirdBox labels; `running` while detection is in progress. */
    onBoxes: (recordingId: string | null, labels: object[], info: { running: boolean }) => void;
    detector?: BirdBoxDetector;
}

interface Result { raw: RawRows; cache: FusionCache }

export class BirdBoxPanel {
    private readonly o: BirdBoxPanelOptions;
    private readonly detector: BirdBoxDetector;
    private readonly results = new Map<string, Result>();
    private abort: AbortController | null = null;
    private pacer: Pacer<RawRows> | null = null;
    private runningId: string | null = null;

    constructor(opts: BirdBoxPanelOptions) {
        this.o = opts;
        this.detector = opts.detector ?? new BirdBoxDetector();
        this.restorePrefs();
        this.showValues();
        const onSlider = () => { this.showValues(); this.savePrefs(); this.refuse(); };
        opts.confInput.addEventListener('input', onSlider);
        opts.gapInput.addEventListener('input', onSlider);
        opts.runBtn.addEventListener('click', () => (this.abort ? this.stop() : this.run()));
    }

    get conf(): number { return parseFloat(this.o.confInput.value) || 0.15; }
    get gap(): number { return Math.max(0, parseFloat(this.o.gapInput.value) || 0); }
    get running(): boolean { return !!this.abort; }

    /** Detection results of a recording (e.g. after switching back to it). */
    hasResult(recordingId: string | null): boolean { return this.results.has(key(recordingId)); }

    /** Fuse the active recording's rows again with the slider settings. */
    refuse(): void {
        const id = this.o.getRecordingId(), res = this.results.get(key(id));
        if (res) this.emit(id, res, !res.raw.done);
    }

    async run(): Promise<void> {
        const audioBuffer = this.o.getAudioBuffer();
        if (!audioBuffer) { this.status('No audio loaded.'); return; }
        const id = this.o.getRecordingId();
        const abort = this.abort = new AbortController();
        this.runningId = id;
        this.o.runBtn.textContent = '■ Stop';
        this.o.progressWrap.style.display = '';
        this.progress(0);
        try {
            this.status('Loading BirdBox model…');
            await this.detector.load();
            this.status('Preparing audio (32 kHz)…');
            const pcm = await resampleTo(mono(audioBuffer), audioBuffer.sampleRate, SAMPLE_RATE);
            if (abort.signal.aborted) return;
            const duration = pcm.length / SAMPLE_RATE;
            const res: Result = { raw: { data: new Float32Array(0), rows: 0, next: 0, analyzedTo: 0, done: false }, cache: {} };
            this.results.set(key(id), res);
            this.status('Detecting calls…');
            const pacer = this.pacer = new Pacer<RawRows>(raw => {
                res.raw = raw;
                this.progress(Math.min(100, (raw.analyzedTo / duration) * 100));
                this.emit(id, res, true);
            });
            const t0 = performance.now();
            const final = await this.detector.detect(pcm, {
                signal: abort.signal,
                // The rows view grows in place: hand the pacer a copy of the snapshot's bounds
                onRows: raw => pacer.push({ ...raw }),
            });
            await pacer.finish();
            res.raw = final;
            this.progress(100);
            const boxes = this.emit(id, res, false);
            const secs = ((performance.now() - t0) / 1000).toFixed(1);
            this.status(`Done — ${boxes} call box${boxes === 1 ? '' : 'es'} (${secs} s). Sliders update without a new run.`);
        } catch (err) {
            if ((err as Error)?.name === 'AbortError') {
                const res = this.results.get(key(id));
                if (res) { res.raw = { ...res.raw, done: true }; this.emit(id, res, false); }
                this.status('Stopped — boxes so far are kept.');
            } else {
                this.status(`Error: ${(err as Error)?.message || String(err)}`);
                this.detector.dispose();
            }
        } finally {
            this.pacer?.stop();
            this.pacer = null;
            this.abort = null;
            this.runningId = null;
            this.o.runBtn.textContent = '▶ Detect calls';
            setTimeout(() => { if (!this.abort) this.o.progressWrap.style.display = 'none'; }, 600);
        }
    }

    stop(): void { this.abort?.abort(); }

    /** Forget a recording's rows (its labels were removed). */
    forget(recordingId: string | null): void {
        if (this.runningId === recordingId) this.stop();
        this.results.delete(key(recordingId));
    }

    dispose(): void { this.stop(); this.detector.dispose(); }

    // ── internals ─────────────────────────────────────────────────────

    private emit(id: string | null, res: Result, running: boolean): number {
        const { raw } = res;
        const boxes = fuseBoxes(raw.data, raw.rows, this.conf, this.gap, res.cache, laterOf(raw));
        this.o.onBoxes(id, boxes.map((b, i) => this.toLabel(id, b, i)), { running });
        return boxes.length;
    }

    private toLabel(id: string | null, b: FusedBox, i: number) {
        const author = String(this.o.getAuthor?.() ?? '').trim();
        return {
            id: `bb_${key(id)}_${i}`,
            start: b.t0,
            end: b.t1,
            freqMin: b.flo,
            freqMax: b.fhi,
            label: 'Bird',
            color: BOX_COLOR,
            confidence: b.max,
            origin: BIRDBOX_ORIGIN,
            author,
            aiSuggested: { model: 'BirdBox', version: MODEL_TAG, confidence: b.max, avgConfidence: b.avg, rawBoxes: b.n },
        };
    }

    private showValues(): void {
        this.o.confVal.textContent = this.conf.toFixed(2);
        this.o.gapVal.textContent = this.gap === 0 ? 'calls' : `${this.gap.toFixed(2)} s`;
    }

    private status(msg: string): void { this.o.statusEl.textContent = msg; }
    private progress(pct: number): void { this.o.progressBar.style.width = `${pct}%`; }

    private restorePrefs(): void {
        try {
            const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
            if (Number.isFinite(p?.conf)) this.o.confInput.value = String(p.conf);
            if (Number.isFinite(p?.gap)) this.o.gapInput.value = String(p.gap);
        } catch { /* defaults */ }
    }

    private savePrefs(): void {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify({ conf: this.conf, gap: this.gap })); } catch { /* not persisted */ }
    }
}

const key = (id: string | null) => id ?? '_';

/** Mean of all channels. */
function mono(buf: AudioBuffer): Float32Array {
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < out.length; i++) out[i] += ch[i];
    }
    for (let i = 0; i < out.length; i++) out[i] /= buf.numberOfChannels;
    return out;
}
