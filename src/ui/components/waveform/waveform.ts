// ═══════════════════════════════════════════════════════════════════════
// Waveform — canvas rendering for waveform, timeline, overview and frequency labels
// ═══════════════════════════════════════════════════════════════════════

import { CQT_FMIN } from '../../../shared/constants.ts';
import { amplitudeMap, amplitudeTicks, isClipped, peakBadge, CLIP_LEVEL, DEFAULT_WAVEFORM_DISPLAY, type WaveformDisplay } from '../../../domain/waveformScale.ts';
import { computeFreqTicks, formatKhz } from '../../../domain/freqAxisTicks.ts';
import { envelopeMinMax, channelPeaks, PEAK_BLOCK, PEAK_BLOCK_FINE, type ChannelPeaks } from '../../../domain/waveformEnvelope.ts';
import { clamp, getTimeGridSteps, formatGridTime, hexToRgb, colorWithAlpha } from '../../../shared/utils.ts';
import { selectedSamples } from '../../../shared/channels.ts';

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
            if (m.attributeName === 'data-theme' || m.attributeName === 'data-accent') { redrawFn(); break; }
        }
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });
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

// ─── Band-filtered source (Settings → Waveform → Band) ──────────────

/** What the renderer draws instead of the raw samples when a band is on (see bandFilter.ts). */
export interface WaveformBandSource {
    /** Pyramid of the filtered signal. */
    peaks: ChannelPeaks;
    /** Largest |filtered sample| ("fit to peak" uses it). */
    peakAbs: number;
    /** Filtered samples [start, end) for zoomed-in views. */
    filterRange(start: number, end: number): Float32Array;
    /** Shown in the badge, e.g. "2.0–8.0 kHz". */
    label: string;
    /** A newer band is being computed; this one is shown meanwhile. */
    pending?: boolean;
}

/** [min, max] of a pyramid over [start, end): coarse blocks inside, fine blocks at the edges. */
function pyramidMinMax(p: ChannelPeaks, start: number, end: number): [number, number] {
    let lo = Infinity, hi = -Infinity;
    const take = (l: { min: Float32Array; max: Float32Array }, a: number, b: number) => {
        for (let i = Math.max(0, a); i < Math.min(l.min.length, b); i++) {
            if (l.min[i] < lo) lo = l.min[i];
            if (l.max[i] > hi) hi = l.max[i];
        }
    };
    const f0 = Math.floor(start / PEAK_BLOCK_FINE), f1 = Math.ceil(end / PEAK_BLOCK_FINE);
    const r = PEAK_BLOCK / PEAK_BLOCK_FINE;
    const c0 = Math.ceil(f0 / r), c1 = Math.floor(f1 / r);
    if (c1 > c0) { take(p.fine, f0, c0 * r); take(p.coarse, c0, c1); take(p.fine, c1 * r, f1); }
    else take(p.fine, f0, f1);
    return [lo, hi];
}

// ─── Peak cache ─────────────────────────────────────────────────────

function getPeaks(audioBuffer: AudioBuffer): ChannelPeaks {
    return channelPeaks(selectedSamples(audioBuffer));
}

function setCanvasSize(canvas: HTMLCanvasElement, width: number, height: number) {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
}

function setStyle(el: HTMLElement, prop: 'width' | 'display', value: string) {
    if (el.style[prop] !== value) el.style[prop] = value;
}

// ─── Peak badge ─────────────────────────────────────────────────────

// Loudest sample of the file in dBFS, top right; red when the file clips.
function drawPeakBadge(ctx: CanvasRenderingContext2D, width: number, peakAbs: number, css: CSSStyleDeclaration, danger: string, bandLabel = '') {
    if (!(peakAbs > 0) || width < 160) return;
    const clipped = peakAbs >= CLIP_LEVEL;
    const peak = clipped ? `${peakBadge(peakAbs)} \u00b7 clipped` : peakBadge(peakAbs);
    const text = bandLabel ? `${bandLabel} \u00b7 ${peak}` : peak;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = colorWithAlpha(css.getPropertyValue('--color-bg-secondary').trim() || '#1e293b', 0.75);
    ctx.fillRect(width - w - 10, 2, w + 8, 14);
    ctx.fillStyle = clipped ? danger : (css.getPropertyValue('--color-text-secondary').trim() || '#94a3b8');
    ctx.fillText(text, width - 6, 4);
    ctx.textAlign = 'start';
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
    display = DEFAULT_WAVEFORM_DISPLAY,
    band = null,
    bandPendingLabel = '',
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
    display?: WaveformDisplay;
    /** Draw this band-filtered signal instead of the raw samples. */
    band?: WaveformBandSource | null;
    /** No band ready yet: the raw signal is drawn and the badge names the band being computed. */
    bandPendingLabel?: string;
}) {
    if (!audioBuffer) return;

    const ampCtx = amplitudeCanvas.getContext('2d');
    const timelineCtx = waveformTimelineCanvas.getContext('2d');
    if (!ampCtx || !timelineCtx) return;

    try {
        (amplitudeCanvas as any)._aw_lastRender = { audioBuffer, amplitudeCanvas, waveformTimelineCanvas, waveformContent, pixelsPerSecond, waveformHeight, amplitudePeakAbs, showTimeline, scrollLeft, viewportWidth, display, band, bandPendingLabel };
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

    const channelData = selectedSamples(audioBuffer);
    const totalSamples = channelData.length;
    const midY = ampHeight / 2;
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
    // Level grid at the axis ticks, centre line stronger.
    // Band on: heights follow the filtered signal; the badge and clipping stay with the raw file.
    const map = amplitudeMap(display, band ? band.peakAbs : amplitudePeakAbs);
    const levelGrid = new Path2D();
    for (const t of amplitudeTicks(map, ampHeight)) {
        if (t.frac <= 0.001 || t.frac >= 0.999 || t.frac === 0.5) continue;
        const gy = Math.round(t.frac * ampHeight) + 0.5;
        levelGrid.moveTo(0, gy);
        levelGrid.lineTo(width, gy);
    }
    ampCtx.strokeStyle = colorWithAlpha(gridColor, 0.12);
    ampCtx.stroke(levelGrid);
    ampCtx.strokeStyle = colorWithAlpha(gridColor, 0.35);
    ampCtx.beginPath();
    ampCtx.moveTo(0, midY + 0.5);
    ampCtx.lineTo(width, midY + 0.5);
    ampCtx.stroke();

    const accent = cssVar('--color-accent', '#60a5fa');
    const danger = cssVar('--color-danger', '#ef4444');
    const samplesPerPx = totalSamples / totalWidth;
    // A level only when a column spans several of its blocks (edge blocks may
    // reach slightly past the column).
    const pyramid = band ? band.peaks : null;
    const peaks = samplesPerPx >= 4 * PEAK_BLOCK ? (pyramid ?? getPeaks(audioBuffer)).coarse
        : samplesPerPx >= 4 * PEAK_BLOCK_FINE ? (pyramid ?? getPeaks(audioBuffer)).fine
        : null;
    // Zoomed in with a band: filter just the visible samples (with settling lead-in).
    const s0 = Math.floor(sl * samplesPerPx);
    const src = !peaks && band ? band.filterRange(s0, Math.min(totalSamples, Math.ceil((sl + width) * samplesPerPx) + 1)) : channelData;
    const off = src === channelData ? 0 : s0;
    // A filtered column can not show clipping: look at the raw samples, and only if the file clips at all.
    const rawClipCheck = !!band && amplitudePeakAbs >= CLIP_LEVEL;
    // One path per layer: min/max envelope, RMS body, clipped columns.
    const peakPath = new Path2D();
    const rmsPath = new Path2D();
    const clipPath = new Path2D();
    const y = (f: number) => (1 - f) * midY;
    const symmetric = display.scale === 'db';
    for (let x = 0; x < width; x++) {
        const start = Math.floor((x + sl) * samplesPerPx);
        const end = Math.min(totalSamples, Math.floor((x + sl + 1) * samplesPerPx));
        let lo = Infinity;
        let hi = -Infinity;
        let acc = 0;
        if (peaks) {
            // Whole blocks: the column may reach a little past its samples (same as min/max).
            const b0 = Math.floor(start / peaks.block);
            const b1 = Math.min(peaks.min.length, Math.ceil(end / peaks.block));
            for (let b = b0; b < b1; b++) {
                if (peaks.min[b] < lo) lo = peaks.min[b];
                if (peaks.max[b] > hi) hi = peaks.max[b];
                acc += peaks.sq[b];
            }
            acc /= Math.max(1, Math.min(totalSamples, b1 * peaks.block) - b0 * peaks.block);
        } else {
            for (let i = start - off; i < end - off; i++) {
                const v = src[i];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
                if (v === v) acc += v * v;
            }
            acc /= Math.max(1, end - start);
        }
        if (lo > hi) continue;
        const px = x + 0.5;
        let clipped: boolean;
        if (rawClipCheck) { const [rlo, rhi] = envelopeMinMax(channelData, start, end); clipped = isClipped(rlo, rhi); }
        else clipped = !band && isClipped(lo, hi);
        // dB: a loudness envelope, mirrored (sign has no meaning on a log scale, and
        // one-sided columns of low rumble would leave gaps at the centre line).
        if (symmetric) { const a = Math.max(-lo, hi); lo = -a; hi = a; }
        const top = y(map.map(hi));
        const bottom = y(map.map(lo));
        // At least one pixel, so silence still reads as a line.
        peakPath.moveTo(px, top - 0.5);
        peakPath.lineTo(px, Math.max(bottom, top) + 0.5);
        if (display.rms) {
            const r = Math.sqrt(acc);
            // RMS never exceeds the envelope (one-sided columns: from the envelope edge).
            const rt = Math.max(top, y(map.map(Math.min(r, Math.max(hi, 0)))));
            const rb = Math.min(bottom, y(map.map(-Math.min(r, Math.max(-lo, 0)))));
            if (rb > rt) { rmsPath.moveTo(px, rt); rmsPath.lineTo(px, rb); }
        }
        if (clipped) { clipPath.moveTo(px, 0); clipPath.lineTo(px, ampHeight); }
    }
    ampCtx.lineWidth = 1;
    ampCtx.strokeStyle = display.rms ? colorWithAlpha(accent, 0.4) : accent;
    ampCtx.stroke(peakPath);
    if (display.rms) {
        ampCtx.strokeStyle = accent;
        ampCtx.stroke(rmsPath);
    }
    // Clipped columns: faint red band with solid caps at both edges (a solid
    // full-height line would read as the playhead).
    ampCtx.strokeStyle = colorWithAlpha(danger, 0.28);
    ampCtx.stroke(clipPath);
    ampCtx.save();
    ampCtx.strokeStyle = danger;
    const cap = Math.max(3, Math.round(ampHeight * 0.08));
    ampCtx.beginPath();
    ampCtx.rect(0, 0, width, cap);
    ampCtx.rect(0, ampHeight - cap, width, cap);
    ampCtx.clip();
    ampCtx.stroke(clipPath);
    ampCtx.restore();

    const bandLabel = band ? `${band.label}${band.pending ? ' \u2026' : ''}` : bandPendingLabel ? `${bandPendingLabel} \u2026` : '';
    drawPeakBadge(ampCtx, width, amplitudePeakAbs, css, danger, bandLabel);

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
    startNorm = 0,
    endNorm = 1,
    display = DEFAULT_WAVEFORM_DISPLAY,
    band = null,
}: {
    audioBuffer: AudioBuffer;
    overviewCanvas: HTMLCanvasElement;
    overviewContainer: HTMLElement;
    amplitudePeakAbs: number;
    /** Same scale as the main view; the strip draws no RMS body (too small to read). */
    display?: WaveformDisplay;
    /** Same band as the main view. */
    band?: WaveformBandSource | null;
    /** Part of the file to show (normalized); the detail strip shows a slice. */
    startNorm?: number;
    endNorm?: number;
}) {
    if (!audioBuffer) return;

    const ctx = overviewCanvas.getContext('2d');
    if (!ctx) return;

    try {
        (overviewCanvas as any)._aw_lastRender = { audioBuffer, overviewCanvas, overviewContainer, amplitudePeakAbs, startNorm, endNorm, display, band };
    } catch (e) {}

    // Device pixels, so the strip stays crisp on HiDPI screens.
    const dpr = Math.max(1, Math.min(3, (globalThis as any).devicePixelRatio || 1));
    const rect = overviewContainer.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width * dpr));
    const H = Math.max(1, Math.floor(rect.height * dpr));
    overviewCanvas.width = W;
    overviewCanvas.height = H;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = getCssVar('--color-bg-tertiary', '#0f3460');
    ctx.fillRect(0, 0, W, H);

    const channelData = selectedSamples(audioBuffer);
    const totalSamples = channelData.length;
    const s0 = Math.floor(clamp(startNorm, 0, 1) * totalSamples);
    const s1 = Math.max(s0 + 1, Math.ceil(clamp(endNorm, 0, 1) * totalSamples));
    const span = s1 - s0;
    const mid = H / 2;
    const map = amplitudeMap(display, band ? band.peakAbs : amplitudePeakAbs);
    // Band: block levels for wide columns, the filtered samples themselves for narrow ones.
    const narrow = !!band && span / W < 2 * PEAK_BLOCK_FINE;
    const filtered = narrow ? band!.filterRange(s0, s1) : null;
    const rawClipCheck = !!band && amplitudePeakAbs >= CLIP_LEVEL;
    // Keep a little headroom so peaks do not touch the strip edges.
    const amp = mid * 0.9;
    const accent = getCssVar('--color-accent', '#60a5fa');
    const danger = getCssVar('--color-danger', '#ef4444');

    const symmetric = display.scale === 'db';
    const clipped: number[] = [];
    ctx.fillStyle = accent;
    for (let x = 0; x < W; x++) {
        const start = s0 + Math.floor(x * span / W);
        const end = Math.min(s1, Math.max(start + 1, s0 + Math.floor((x + 1) * span / W)));
        const [lo, hi] = filtered ? envelopeMinMax(filtered, start - s0, end - s0)
            : band ? pyramidMinMax(band.peaks, start, end)
            : envelopeMinMax(channelData, start, end);
        if (!(lo <= hi)) continue;
        const a = Math.max(-lo, hi);
        const y0 = mid - map.map(symmetric ? a : hi) * amp;
        const y1 = mid - map.map(symmetric ? -a : lo) * amp;
        ctx.fillRect(x, y0, 1, Math.max(dpr, y1 - y0));
        if (band ? rawClipCheck && isClipped(...envelopeMinMax(channelData, start, end)) : isClipped(lo, hi)) clipped.push(x);
    }
    // Clipped spots as red ticks at both edges: findable in hours of audio.
    if (clipped.length) {
        ctx.fillStyle = danger;
        const t = Math.max(2 * dpr, Math.round(H * 0.12));
        for (const x of clipped) { ctx.fillRect(x, 0, Math.max(1, dpr), t); ctx.fillRect(x, H - t, Math.max(1, dpr), t); }
    }

    installThemeObserver(overviewCanvas, () => {
        const s = (overviewCanvas as any)._aw_lastRender;
        if (s) requestAnimationFrame(() => {
            // A spectrogram image drawn meanwhile clears the saved state: keep it.
            if ((overviewCanvas as any)._aw_lastRender !== s) return;
            try { renderOverviewWaveform(s); } catch {}
        });
    });
}

/**
 * Draws a whole-file spectrogram image into the overview strip (overview
 * mode 'spectrogram'). Clears the waveform's theme re-render so a theme
 * change does not paint the waveform over it.
 */
export function renderOverviewImage({
    image,
    overviewCanvas,
    overviewContainer,
}: {
    image: CanvasImageSource;
    overviewCanvas: HTMLCanvasElement;
    overviewContainer: HTMLElement;
}) {
    const ctx = overviewCanvas.getContext('2d');
    if (!ctx) return;
    (overviewCanvas as any)._aw_lastRender = null;
    const rect = overviewContainer.getBoundingClientRect();
    overviewCanvas.width = Math.max(1, Math.floor(rect.width));
    overviewCanvas.height = Math.max(1, Math.floor(rect.height));
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, 0, 0, overviewCanvas.width, overviewCanvas.height);
}

// ─── Frequency Labels ───────────────────────────────────────────────

export function renderFrequencyLabels({ labelsElement, coords }: { labelsElement: HTMLElement; coords: any }) {
    labelsElement.innerHTML = '';

    const maxHz = coords.freqViewMax ?? Math.min(coords.maxFreq, coords.sampleRate / 2);
    let minHz = coords.freqViewMin ?? ((coords.freqRange && coords.freqRange[0]) || 0);
    // Log axes have no 0 Hz: start at the lowest band.
    if (coords.scale === 'cqt' || coords.freqScale === 'log') minHz = Math.max(minHz, CQT_FMIN);
    const height = labelsElement.clientHeight || labelsElement.getBoundingClientRect?.().height || 0;

    const ticks = computeFreqTicks({
        height, minHz, maxHz,
        toFrac: (hz: number) => coords.frequencyToYFraction(hz),
    });
    for (const t of ticks) {
        const y = coords.frequencyToYFraction(t.hz) * height;
        const el = document.createElement('div');
        el.className = `freq-tick${t.labeled ? ' freq-tick--label' : ''}${t.major ? ' freq-tick--major' : ''}`;
        el.style.top = `${y}px`;
        if (t.labeled) {
            const span = document.createElement('span');
            span.textContent = formatKhz(t.hz);
            // Centered on the tick, except where that would cut it off at the bottom.
            if (y > height - 6) span.classList.add('freq-tick__text--bottom');
            el.appendChild(span);
        }
        labelsElement.appendChild(el);
    }
    const unit = document.createElement('div');
    unit.className = 'freq-unit';
    unit.textContent = 'kHz';
    labelsElement.appendChild(unit);
}
