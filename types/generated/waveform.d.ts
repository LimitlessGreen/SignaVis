export function renderMainWaveform({ audioBuffer, amplitudeCanvas, waveformTimelineCanvas, waveformContent, pixelsPerSecond, waveformHeight, amplitudePeakAbs, showTimeline, }: {
    audioBuffer: any;
    amplitudeCanvas: any;
    waveformTimelineCanvas: any;
    waveformContent: any;
    pixelsPerSecond: any;
    waveformHeight?: number | undefined;
    amplitudePeakAbs: any;
    showTimeline?: boolean | undefined;
}): void;
export function renderOverviewWaveform({ audioBuffer, overviewCanvas, overviewContainer, amplitudePeakAbs, }: {
    audioBuffer: any;
    overviewCanvas: any;
    overviewContainer: any;
    amplitudePeakAbs: any;
}): void;
export function renderFrequencyLabels({ labelsElement, maxFreq, sampleRateHz }: {
    labelsElement: any;
    maxFreq: any;
    sampleRateHz: any;
}): void;
