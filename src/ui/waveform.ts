// ═══════════════════════════════════════════════════════════════════════
// waveform.js — Waveform, timeline, overview and frequency rendering
// ═══════════════════════════════════════════════════════════════════════

import { clamp, getTimeGridSteps, hexToRgb, colorWithAlpha } from '../shared/utils.ts';

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
    canvas.dataset = canvas.dataset || {};
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

function drawWaveformTimeline({ ctx, width, height, duration, pixelsPerSecond }: { ctx: CanvasRenderingContext2D; width: number; height: number; duration: number; pixelsPerSecond: number }) {
    if (width <= 0) return;
    const textColor = getCssVar('--color-text-secondary', '#cbd5e1');
    const { majorStep, minorStep } = getTimeGridSteps(pixelsPerSecond);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getCssVar('--color-bg-secondary', '#1e293b');
    ctx.fillRect(0, 0, width, height);
    ctx.font = '11px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor;
    ctx.strokeStyle = colorWithAlpha(getCssVar('--color-text-secondary', '#cbd5e1'), 0.25);

    for (let t = 0; t <= duration; t += minorStep) {
        const x = Math.round(t * pixelsPerSecond) + 0.5;
        if (x < 0 || x > width) continue;
        const isMajor = Math.abs((t / majorStep) - Math.round(t / majorStep)) < 0.0001;
        const lineHeight = isMajor ? 14 : 8;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, lineHeight);
        ctx.stroke();
        if (isMajor) {
            ctx.fillText(`${t.toFixed(1)}s`, x + 3, height / 2);
        }
    }
}

// ─── Main Waveform ──────────────────────────────────────────────────

export function renderMainWaveform({
    audioBuffer,
    amplitudeCanvas,
    waveformTimelineCanvas,
    waveformContent,
    pixelsPerSecond,
    waveformHeight = 100,
    amplitudePeakAbs,
    showTimeline = true,
}: {
    audioBuffer: AudioBuffer;
    amplitudeCanvas: HTMLCanvasElement;
    waveformTimelineCanvas: HTMLCanvasElement;
    waveformContent: HTMLElement;
    pixelsPerSecond: number;
    waveformHeight?: number;
    amplitudePeakAbs: number;
    showTimeline?: boolean;
}) {
    if (!audioBuffer) return;

    const ampCtx = amplitudeCanvas.getContext('2d');
    const timelineCtx = waveformTimelineCanvas.getContext('2d');
    if (!ampCtx || !timelineCtx) return;

    // persist last render args so we can redraw on theme changes
    try {
        (amplitudeCanvas as any)._aw_lastRender = { audioBuffer, amplitudeCanvas, waveformTimelineCanvas, waveformContent, pixelsPerSecond, waveformHeight, amplitudePeakAbs, showTimeline };
    } catch (e) {}

    const width = Math.max(1, Math.floor(audioBuffer.duration * pixelsPerSecond));
    const clampedWaveformHeight = Math.max(64, Math.floor(waveformHeight));
    const timelineHeight = showTimeline ? clamp(Math.round(clampedWaveformHeight * 0.22), 18, 32) : 0;
    const ampHeight = Math.max(32, clampedWaveformHeight - timelineHeight);

    amplitudeCanvas.width = width;
    amplitudeCanvas.height = ampHeight;
    waveformTimelineCanvas.width = width;
    waveformTimelineCanvas.height = timelineHeight;
    waveformTimelineCanvas.style.display = showTimeline ? 'block' : 'none';
    waveformContent.style.width = `${width}px`;

    const channelData = audioBuffer.getChannelData(0);
    const totalSamples = channelData.length;
    const midY = ampHeight / 2;
    const ampScale = 1 / Math.max(1e-6, amplitudePeakAbs);
    const { majorStep, minorStep } = getTimeGridSteps(pixelsPerSecond);

    ampCtx.clearRect(0, 0, width, ampHeight);
    ampCtx.fillStyle = getCssVar('--color-bg-tertiary', '#0f3460');
    ampCtx.fillRect(0, 0, width, ampHeight);
    for (let t = 0; t <= audioBuffer.duration; t += minorStep) {
        const x = Math.round(t * pixelsPerSecond) + 0.5;
        const isMajor = Math.abs((t / majorStep) - Math.round(t / majorStep)) < 0.0001;
        ampCtx.strokeStyle = isMajor ? colorWithAlpha(getCssVar('--color-text-secondary', '#94a3b8'), 0.22) : colorWithAlpha(getCssVar('--color-text-secondary', '#94a3b8'), 0.12);
        ampCtx.beginPath();
        ampCtx.moveTo(x, 0);
        ampCtx.lineTo(x, ampHeight);
        ampCtx.stroke();
    }
    ampCtx.strokeStyle = colorWithAlpha(getCssVar('--color-text-secondary', '#94a3b8'), 0.35);
    ampCtx.beginPath();
    ampCtx.moveTo(0, midY + 0.5);
    ampCtx.lineTo(width, midY + 0.5);
    ampCtx.stroke();

    ampCtx.strokeStyle = getCssVar('--color-accent', '#60a5fa');
    ampCtx.lineWidth = 1;
    for (let x = 0; x < width; x++) {
        const start = Math.floor(x * totalSamples / width);
        const end = Math.min(totalSamples, Math.floor((x + 1) * totalSamples / width));
        let min = 1;
        let max = -1;
        for (let i = start; i < end; i++) {
            const v = clamp(channelData[i] * ampScale, -1, 1);
            if (v < min) min = v;
            if (v > max) max = v;
        }
        ampCtx.beginPath();
        ampCtx.moveTo(x + 0.5, (1 + min) * midY);
        ampCtx.lineTo(x + 0.5, (1 + max) * midY);
        ampCtx.stroke();
    }

    if (showTimeline && timelineHeight > 0) {
        drawWaveformTimeline({
            ctx: timelineCtx,
            width,
            height: timelineHeight,
            duration: audioBuffer.duration,
            pixelsPerSecond,
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

    // persist last render args so we can redraw on theme changes
    try {
        (overviewCanvas as any)._aw_lastRender = { audioBuffer, overviewCanvas, overviewContainer, amplitudePeakAbs };
    } catch (e) {}

    const rect = overviewContainer.getBoundingClientRect();
    overviewCanvas.width = Math.max(1, Math.floor(rect.width));
    overviewCanvas.height = Math.max(1, Math.floor(rect.height));

    ctx.clearRect(0, 0, overviewCanvas.width, overviewCanvas.height);
    ctx.fillStyle = getCssVar('--color-bg-tertiary', '#0f3460');
    ctx.fillRect(0, 0, overviewCanvas.width, overviewCanvas.height);

    const channelData = audioBuffer.getChannelData(0);
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

    // Use frequency viewport if active, otherwise full range
    const boundedMaxFreq = coords.freqViewMax ?? Math.min(coords.maxFreq, coords.sampleRate / 2);
    const minFreq = coords.freqViewMin ?? ((coords.freqRange && coords.freqRange[0]) || 0);
    const range = boundedMaxFreq - minFreq;

    // Choose a "nice" tick step based on the frequency range
    const niceSteps = [100, 200, 500, 1000, 2000, 2500, 5000, 10000, 20000];
    const targetTicks = 6;
    const rawStep = range / targetTicks;
    const step = niceSteps.reduce((best, s) =>
        Math.abs(s - rawStep) < Math.abs(best - rawStep) ? s : best
    );

    // Generate frequencies at nice round intervals
    const frequencies = [];
    const startFreq = Math.ceil(minFreq / step) * step;
    for (let f = startFreq; f <= boundedMaxFreq + 1; f += step) {
        frequencies.push(f);
    }
    // Ensure 0 Hz is included if visible
    if (minFreq === 0 && (frequencies.length === 0 || frequencies[0] !== 0)) {
        frequencies.unshift(0);
    }

    frequencies.forEach((freq) => {
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
