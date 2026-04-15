// ═══════════════════════════════════════════════════════════════════════
// waveform.js — Waveform, timeline, overview and frequency rendering
// ═══════════════════════════════════════════════════════════════════════

import { clamp, getTimeGridSteps, hexToRgb, colorWithAlpha } from './utils.js';

function getCssVar(name, fallback = '') {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    } catch {
        return fallback;
    }
}

// ─── Waveform Timeline (private helper) ─────────────────────────────

function drawWaveformTimeline({ ctx, width, height, duration, pixelsPerSecond }) {
    if (width <= 0) return;
    const css = getComputedStyle(document.documentElement);
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
}) {
    if (!audioBuffer) return;

    const ampCtx = amplitudeCanvas.getContext('2d');
    const timelineCtx = waveformTimelineCanvas.getContext('2d');
    if (!ampCtx || !timelineCtx) return;

    // persist last render args so we can redraw on theme changes
    try {
        amplitudeCanvas._aw_lastRender = { audioBuffer, amplitudeCanvas, waveformTimelineCanvas, waveformContent, pixelsPerSecond, waveformHeight, amplitudePeakAbs, showTimeline };
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

    // Install a MutationObserver to redraw when theme changes (data-theme attr)
    try {
        if (!amplitudeCanvas.dataset.awThemeObserverInstalled) {
            amplitudeCanvas.dataset.awThemeObserverInstalled = '1';
            const redraw = () => {
                const s = amplitudeCanvas._aw_lastRender;
                if (s) {
                    requestAnimationFrame(() => {
                        try { renderMainWaveform(s); } catch (e) { /* ignore */ }
                    });
                }
            };
            const mo = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.attributeName === 'data-theme') { redraw(); break; }
                }
            });
            mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
            try {
                const mm = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
                if (mm) {
                    if (mm.addEventListener) mm.addEventListener('change', redraw);
                    else if (mm.addListener) mm.addListener(redraw);
                }
            } catch (e) {}
            amplitudeCanvas._aw_themeObserver = mo;
            amplitudeCanvas._aw_themeRedraw = redraw;
        }
    } catch (e) {}
}

// ─── Overview Waveform ──────────────────────────────────────────────

export function renderOverviewWaveform({
    audioBuffer,
    overviewCanvas,
    overviewContainer,
    amplitudePeakAbs,
}) {
    if (!audioBuffer) return;

    const ctx = overviewCanvas.getContext('2d');
    if (!ctx) return;

    // persist last render args so we can redraw on theme changes
    try {
        overviewCanvas._aw_lastRender = { audioBuffer, overviewCanvas, overviewContainer, amplitudePeakAbs };
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

    // Install MutationObserver to redraw overview when theme changes
    try {
        if (!overviewCanvas.dataset.awThemeObserverInstalled) {
            overviewCanvas.dataset.awThemeObserverInstalled = '1';
            const redraw = () => {
                const s = overviewCanvas._aw_lastRender;
                if (s) requestAnimationFrame(() => { try { renderOverviewWaveform(s); } catch (e) {} });
            };
            const mo = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.attributeName === 'data-theme') { redraw(); break; }
                }
            });
            mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
            try {
                const mm = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
                if (mm) {
                    if (mm.addEventListener) mm.addEventListener('change', redraw);
                    else if (mm.addListener) mm.addListener(redraw);
                }
            } catch (e) {}
            overviewCanvas._aw_themeObserver = mo;
            overviewCanvas._aw_themeRedraw = redraw;
        }
    } catch (e) {}
}

// Ensure overview canvas redraws on theme change
try {
    // If we have a global observer installed already (on an amplitude canvas), skip creating a duplicate
} catch (e) {}

// ─── Frequency Labels ───────────────────────────────────────────────

export function renderFrequencyLabels({ labelsElement, coords }) {
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
