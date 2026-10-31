// ═══════════════════════════════════════════════════════════════════════
// Waveform — canvas rendering for waveform, timeline, overview and frequency labels
// ═══════════════════════════════════════════════════════════════════════

import { CQT_FMIN } from '../../../shared/constants.ts';
import { clamp, channelData as cachedChannelData, getTimeGridSteps, formatGridTime, hexToRgb, colorWithAlpha } from '../../../shared/utils.ts';

function getCssVar(name: string, fallback = '') {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    } catch {
        return fallback;
    }
}

// ─── Theme Observer (private helper) ────────────────────────────────

function installThemeObserver(canvas: any, redrawFn: () => void) {
    if (canvas.dataset?.awThemeObserverInstalled) return;
    canvas.dataset.awThemeObserverInstalled = '1';
    const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.attributeName === 'data-theme') { redrawFn(); break; }
        }
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    try {
        const mm = (window as any).matchMedia?.('(prefers-color-scheme: light)') as MediaQueryList | undefined | null;
        if (mm?.addEventListener) mm.addEventListener('change', () => redrawFn());
        else if (mm?.addListener) mm.addListener(() => redrawFn());
    } catch {}
    canvas._aw_themeObserver = mo;
    canvas._aw_themeRedraw = redrawFn;
}

// ─── Waveform Timeline (private helper) ─────────────────────────────

function drawWaveformTimeline({ ctx, width, height, duration, pixelsPerSecond, scrollLeft = 0 }: { ctx: CanvasRenderingContext2D; width: number; height: number; duration: number; pixelsPerSecond: number; scrollLeft?: number }) {
    if (width <= 0) return;
    const css = getComputedStyle(document.documentElement);
    const textColor = css.getPropertyValue('--color-text-secondary').trim() || '#cbd5e1';
    const { majorStep, minorStep } = getTimeGridSteps(pixelsPerSecond);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = css.getPropertyValue('--color-bg-secondary').trim() || '#1e293b';
    ctx.fillRect(0, 0, width, height);
    ctx.font = '11px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor;
    ctx.strokeStyle = colorWithAlpha(textColor, 0.25);

    const ticks = new Path2D();
    const labels: [number, number][] = [];
    const tStart = Math.max(0, Math.floor(scrollLeft / pixelsPerSecond / minorStep)) * minorStep;
    for (let t = tStart; t <= duration; t += minorStep) {
        const x = Math.round(t * pixelsPerSecond) - scrollLeft + 0.5;
        if (x < 0) continue;
        if (x > width) break;
        const isMajor = Math.abs((t / majorStep) - Math.round(t / majorStep)) < 0.0001;
        ticks.moveTo(x, 0);
        ticks.lineTo(x, isMajor ? 14 : 8);
        if (isMajor) labels.push([t, x]);
    }
    ctx.stroke(ticks);
    for (const [t, x] of labels) ctx.fillText(formatGridTime(t, majorStep), x + 3, height / 2);
}

// ─── Peak cache ─────────────────────────────────────────────────────

// Min/max per block of samples, built once per buffer: a fine level (32) for
// medium zoom, a coarse one (1024, from the fine one) for zoomed-out views of
// long recordings. Scrolling then touches a fraction of the samples.
const PEAK_BLOCK_FINE = 32;
const PEAK_BLOCK = 1024;
type Peaks = { block: number; min: Float32Array; max: Float32Array };
const peakCache = new WeakMap<AudioBuffer, { fine: Peaks; coarse: Peaks }>();

function reducePeaks(min: Float32Array, max: Float32Array, factor: number, block: number): Peaks {
    const n = Math.ceil(min.length / factor);
    const outMin = new Float32Array(n);
    const outMax = new Float32Array(n);
    for (let b = 0; b < n; b++) {
        let lo = Infinity, hi = -Infinity;
        const end = Math.min(min.length, (b + 1) * factor);
        for (let i = b * factor; i < end; i++) {
            if (min[i] < lo) lo = min[i];
            if (max[i] > hi) hi = max[i];
        }
        outMin[b] = lo; outMax[b] = hi;
    }
    return { block, min: outMin, max: outMax };
}

function getPeaks(audioBuffer: AudioBuffer) {
    let peaks = peakCache.get(audioBuffer);
    if (peaks) return peaks;
    const data = cachedChannelData(audioBuffer);
    const fine = reducePeaks(data, data, PEAK_BLOCK_FINE, PEAK_BLOCK_FINE);
    const coarse = reducePeaks(fine.min, fine.max, PEAK_BLOCK / PEAK_BLOCK_FINE, PEAK_BLOCK);
    peaks = { fine, coarse };
    peakCache.set(audioBuffer, peaks);
    return peaks;
}

function setCanvasSize(canvas: HTMLCanvasElement, width: number, height: number) {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
}

function setStyle(el: HTMLElement, prop: 'width' | 'display', value: string) {
    if (el.style[prop] !== value) el.style[prop] = value;
}

// ─── Main Waveform ──────────────────────────────────────────────────

// Canvases are viewport-sized and sticky (like the spectrogram canvas);
// waveformContent keeps the full track width so scrolling still works.
export function renderMainWaveform({
    audioBuffer,
    amplitudeCanvas,
    waveformTimelineCanvas,
    waveformContent,
    pixelsPerSecond,
    waveformHeight = 100,
    amplitudePeakAbs,
    showTimeline = true,
    scrollLeft = 0,
    viewportWidth = 0,
}: {
    audioBuffer: AudioBuffer;
    amplitudeCanvas: HTMLCanvasElement;
    waveformTimelineCanvas: HTMLCanvasElement;
    waveformContent: HTMLElement;
    pixelsPerSecond: number;
    waveformHeight?: number;
    amplitudePeakAbs: number;
    showTimeline?: boolean;
    scrollLeft?: number;
    viewportWidth?: number;
}) {
    if (!audioBuffer) return;

    const ampCtx = amplitudeCanvas.getContext('2d');
    const timelineCtx = waveformTimelineCanvas.getContext('2d');
    if (!ampCtx || !timelineCtx) return;

    try {
        (amplitudeCanvas as any)._aw_lastRender = { audioBuffer, amplitudeCanvas, waveformTimelineCanvas, waveformContent, pixelsPerSecond, waveformHeight, amplitudePeakAbs, showTimeline, scrollLeft, viewportWidth };
    } catch (e) {}

    const totalWidth = Math.max(1, Math.floor(audioBuffer.duration * pixelsPerSecond));
    const width = viewportWidth > 0 ? Math.min(viewportWidth, totalWidth) : totalWidth;
    const sl = viewportWidth > 0 ? clamp(scrollLeft, 0, Math.max(0, totalWidth - width)) : 0;
    const clampedWaveformHeight = Math.max(64, Math.floor(waveformHeight));
    const timelineHeight = showTimeline ? clamp(Math.round(clampedWaveformHeight * 0.22), 18, 32) : 0;
    const ampHeight = Math.max(32, clampedWaveformHeight - timelineHeight);

    // Resizing a canvas reallocates it, and style writes invalidate layout:
    // only touch what changed (this runs on every scroll frame).
    setCanvasSize(amplitudeCanvas, width, ampHeight);
    setCanvasSize(waveformTimelineCanvas, width, timelineHeight);
    setStyle(waveformTimelineCanvas, 'display', showTimeline ? 'block' : 'none');
    setStyle(waveformContent, 'width', `${totalWidth}px`);

    const channelData = cachedChannelData(audioBuffer);
    const totalSamples = channelData.length;
    const midY = ampHeight / 2;
    const ampScale = 1 / Math.max(1e-6, amplitudePeakAbs);
    const { majorStep, minorStep } = getTimeGridSteps(pixelsPerSecond);

    const css = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const gridColor = cssVar('--color-text-secondary', '#94a3b8');

    ampCtx.clearRect(0, 0, width, ampHeight);
    ampCtx.fillStyle = cssVar('--color-bg-tertiary', '#0f3460');
    ampCtx.fillRect(0, 0, width, ampHeight);
    // Grid: one path per line style instead of one stroke per line.
    const majorGrid = new Path2D();
    const minorGrid = new Path2D();
    const tStart = Math.max(0, Math.floor(sl / pixelsPerSecond / minorStep)) * minorStep;
    for (let t = tStart; t <= audioBuffer.duration; t += minorStep) {
        const x = Math.round(t * pixelsPerSecond) - sl + 0.5;
        if (x > width) break;
        const isMajor = Math.abs((t / majorStep) - Math.round(t / majorStep)) < 0.0001;
        const path = isMajor ? majorGrid : minorGrid;
        path.moveTo(x, 0);
        path.lineTo(x, ampHeight);
    }
    ampCtx.strokeStyle = colorWithAlpha(gridColor, 0.12);
    ampCtx.stroke(minorGrid);
    ampCtx.strokeStyle = colorWithAlpha(gridColor, 0.22);
    ampCtx.stroke(majorGrid);
    ampCtx.strokeStyle = colorWithAlpha(gridColor, 0.35);
    ampCtx.beginPath();
    ampCtx.moveTo(0, midY + 0.5);
    ampCtx.lineTo(width, midY + 0.5);
    ampCtx.stroke();

    ampCtx.strokeStyle = cssVar('--color-accent', '#60a5fa');
    ampCtx.lineWidth = 1;
    const samplesPerPx = totalSamples / totalWidth;
    // A level only when a column spans several of its blocks (edge blocks may
    // reach slightly past the column).
    const peaks = samplesPerPx >= 4 * PEAK_BLOCK ? getPeaks(audioBuffer).coarse
        : samplesPerPx >= 4 * PEAK_BLOCK_FINE ? getPeaks(audioBuffer).fine
        : null;
    // Raw min/max per column, scaled and clamped once (clamping is monotonic).
    ampCtx.beginPath();
    for (let x = 0; x < width; x++) {
        const start = Math.floor((x + sl) * samplesPerPx);
        const end = Math.min(totalSamples, Math.floor((x + sl + 1) * samplesPerPx));
        let lo = Infinity;
        let hi = -Infinity;
        if (peaks) {
            const b1 = Math.min(peaks.min.length, Math.ceil(end / peaks.block));
            for (let b = Math.floor(start / peaks.block); b < b1; b++) {
                if (peaks.min[b] < lo) lo = peaks.min[b];
                if (peaks.max[b] > hi) hi = peaks.max[b];
            }
        } else {
            for (let i = start; i < end; i++) {
                const v = channelData[i];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
        }
        if (lo > hi) continue;
        const min = clamp(lo * ampScale, -1, 1);
        const max = clamp(hi * ampScale, -1, 1);
        ampCtx.moveTo(x + 0.5, (1 + min) * midY);
        ampCtx.lineTo(x + 0.5, (1 + max) * midY);
    }
    ampCtx.stroke();

    if (showTimeline && timelineHeight > 0) {
        drawWaveformTimeline({
            ctx: timelineCtx,
            width,
            height: timelineHeight,
            duration: audioBuffer.duration,
            pixelsPerSecond,
            scrollLeft: sl,
        });
    }

    installThemeObserver(amplitudeCanvas, () => {
        const s = (amplitudeCanvas as any)._aw_lastRender;
        if (s) requestAnimationFrame(() => { try { renderMainWaveform(s); } catch {} });
    });
}

// ─── Overview Waveform ──────────────────────────────────────────────

export function renderOverviewWaveform({
    audioBuffer,
    overviewCanvas,
    overviewContainer,
    amplitudePeakAbs,
}: {
    audioBuffer: AudioBuffer;
    overviewCanvas: HTMLCanvasElement;
    overviewContainer: HTMLElement;
    amplitudePeakAbs: number;
}) {
    if (!audioBuffer) return;

    const ctx = overviewCanvas.getContext('2d');
    if (!ctx) return;

    try {
        (overviewCanvas as any)._aw_lastRender = { audioBuffer, overviewCanvas, overviewContainer, amplitudePeakAbs };
    } catch (e) {}

    const rect = overviewContainer.getBoundingClientRect();
    overviewCanvas.width = Math.max(1, Math.floor(rect.width));
    overviewCanvas.height = Math.max(1, Math.floor(rect.height));

    ctx.clearRect(0, 0, overviewCanvas.width, overviewCanvas.height);
    ctx.fillStyle = getCssVar('--color-bg-tertiary', '#0f3460');
    ctx.fillRect(0, 0, overviewCanvas.width, overviewCanvas.height);

    const channelData = cachedChannelData(audioBuffer);
    const totalSamples = channelData.length;
    const amp = overviewCanvas.height / 2;
    const ampScale = 1 / Math.max(1e-6, amplitudePeakAbs);

    ctx.strokeStyle = getCssVar('--color-accent', '#60a5fa');
    ctx.lineWidth = 1;

    for (let x = 0; x < overviewCanvas.width; x++) {
        const start = Math.floor(x * totalSamples / overviewCanvas.width);
        const end = Math.min(totalSamples, Math.floor((x + 1) * totalSamples / overviewCanvas.width));
        let min = 1;
        let max = -1;
        for (let i = start; i < end; i++) {
            const v = clamp(channelData[i] * ampScale, -1, 1);
            if (v < min) min = v;
            if (v > max) max = v;
        }
        ctx.beginPath();
        ctx.moveTo(x, (1 + min) * amp);
        ctx.lineTo(x, (1 + max) * amp);
        ctx.stroke();
    }

    installThemeObserver(overviewCanvas, () => {
        const s = (overviewCanvas as any)._aw_lastRender;
        if (s) requestAnimationFrame(() => { try { renderOverviewWaveform(s); } catch {} });
    });
}

// ─── Frequency Labels ───────────────────────────────────────────────

export function renderFrequencyLabels({ labelsElement, coords }: { labelsElement: HTMLElement; coords: any }) {
    labelsElement.innerHTML = '';

    const boundedMaxFreq = coords.freqViewMax ?? Math.min(coords.maxFreq, coords.sampleRate / 2);
    const minFreq = coords.freqViewMin ?? ((coords.freqRange && coords.freqRange[0]) || 0);
    const range = boundedMaxFreq - minFreq;

    const frequencies: number[] = [];
    const isLog = coords.scale === 'cqt' || coords.freqScale === 'log';
    if (isLog) {
        // 1-2-5 per decade; log axes have no 0 Hz, start at the lowest band.
        const lo = Math.max(minFreq, CQT_FMIN);
        for (let dec = 10; dec <= boundedMaxFreq; dec *= 10) {
            for (const m of [1, 2, 5]) {
                const f = dec * m;
                if (f >= lo && f <= boundedMaxFreq + 1) frequencies.push(f);
            }
        }
    } else {
        const niceSteps = [100, 200, 500, 1000, 2000, 2500, 5000, 10000, 20000];
        const targetTicks = 6;
        const rawStep = range / targetTicks;
        const step = niceSteps.reduce((best, s) =>
            Math.abs(s - rawStep) < Math.abs(best - rawStep) ? s : best
        );
        const startFreq = Math.ceil(minFreq / step) * step;
        for (let f = startFreq; f <= boundedMaxFreq + 1; f += step) {
            frequencies.push(f);
        }
        if (minFreq === 0 && (frequencies.length === 0 || frequencies[0] !== 0)) {
            frequencies.unshift(0);
        }
    }

    // Drop labels that would overlap on non-linear axes (mel/log crowd the top or bottom).
    const MIN_GAP = 0.05;
    let lastY = Infinity;
    const visible = frequencies
        .sort((a, b) => a - b)
        .filter((f) => {
            const y = coords.frequencyToYFraction(f);
            if (Math.abs(lastY - y) < MIN_GAP) return false;
            lastY = y;
            return true;
        });

    visible.forEach((freq) => {
        const span = document.createElement('span');
        span.textContent = freq >= 1000
            ? `${(freq / 1000).toFixed(freq % 1000 === 0 ? 0 : 1)} kHz`
            : `${Math.round(freq)} Hz`;
        const yFrac = coords.frequencyToYFraction(freq);
        span.style.position = 'absolute';
        span.style.top = `${yFrac * 100}%`;
        span.style.transform = `translateY(${-yFrac * 100}%)`;
        span.style.setProperty('--tick-pos', `${yFrac * 100}%`);
        labelsElement.appendChild(span);
    });
}
