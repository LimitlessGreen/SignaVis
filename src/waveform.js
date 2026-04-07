// ═══════════════════════════════════════════════════════════════════════
// waveform.js — Waveform, timeline, overview and frequency rendering
// ═══════════════════════════════════════════════════════════════════════

import { getTimeGridSteps } from './utils.js';

// ─── Waveform Timeline (private helper) ─────────────────────────────

function drawWaveformTimeline({ ctx, width, height, duration, pixelsPerSecond }) {
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
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';

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

    const width = Math.max(1, Math.floor(audioBuffer.duration * pixelsPerSecond));
    const clampedWaveformHeight = Math.max(64, Math.floor(waveformHeight));
    const timelineHeight = showTimeline ? Math.max(18, Math.min(32, Math.round(clampedWaveformHeight * 0.22))) : 0;
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
    ampCtx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-bg-tertiary');
    ampCtx.fillRect(0, 0, width, ampHeight);
    for (let t = 0; t <= audioBuffer.duration; t += minorStep) {
        const x = Math.round(t * pixelsPerSecond) + 0.5;
        const isMajor = Math.abs((t / majorStep) - Math.round(t / majorStep)) < 0.0001;
        ampCtx.strokeStyle = isMajor ? 'rgba(148,163,184,0.22)' : 'rgba(148,163,184,0.12)';
        ampCtx.beginPath();
        ampCtx.moveTo(x, 0);
        ampCtx.lineTo(x, ampHeight);
        ampCtx.stroke();
    }
    ampCtx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ampCtx.beginPath();
    ampCtx.moveTo(0, midY + 0.5);
    ampCtx.lineTo(width, midY + 0.5);
    ampCtx.stroke();

    ampCtx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-accent');
    ampCtx.lineWidth = 1;
    for (let x = 0; x < width; x++) {
        const start = Math.floor(x * totalSamples / width);
        const end = Math.min(totalSamples, Math.floor((x + 1) * totalSamples / width));
        let min = 1;
        let max = -1;
        for (let i = start; i < end; i++) {
            const v = Math.max(-1, Math.min(1, channelData[i] * ampScale));
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

    const rect = overviewContainer.getBoundingClientRect();
    overviewCanvas.width = Math.max(1, Math.floor(rect.width));
    overviewCanvas.height = Math.max(1, Math.floor(rect.height));

    ctx.clearRect(0, 0, overviewCanvas.width, overviewCanvas.height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-bg-tertiary');
    ctx.fillRect(0, 0, overviewCanvas.width, overviewCanvas.height);

    const channelData = audioBuffer.getChannelData(0);
    const totalSamples = channelData.length;
    const amp = overviewCanvas.height / 2;
    const ampScale = 1 / Math.max(1e-6, amplitudePeakAbs);

    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-accent');
    ctx.lineWidth = 1;

    for (let x = 0; x < overviewCanvas.width; x++) {
        const start = Math.floor(x * totalSamples / overviewCanvas.width);
        const end = Math.min(totalSamples, Math.floor((x + 1) * totalSamples / overviewCanvas.width));
        let min = 1;
        let max = -1;
        for (let i = start; i < end; i++) {
            const v = Math.max(-1, Math.min(1, channelData[i] * ampScale));
            if (v < min) min = v;
            if (v > max) max = v;
        }
        ctx.beginPath();
        ctx.moveTo(x, (1 + min) * amp);
        ctx.lineTo(x, (1 + max) * amp);
        ctx.stroke();
    }
}

// ─── Frequency Labels ───────────────────────────────────────────────

export function renderFrequencyLabels({ labelsElement, coords }) {
    labelsElement.innerHTML = '';

    const boundedMaxFreq = Math.min(coords.maxFreq, coords.sampleRate / 2);
    const minFreq = (coords.freqRange && coords.freqRange[0]) || 0;
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
        // Prevent clipping: align top labels downward, bottom labels upward
        if (yFrac < 0.08) {
            span.style.transform = 'translateY(1px)';
        } else if (yFrac > 0.92) {
            span.style.transform = 'translateY(-100%)';
            span.style.top = `calc(${yFrac * 100}% - 1px)`;
        } else {
            span.style.transform = 'translateY(-50%)';
        }
        labelsElement.appendChild(span);
    });
}
