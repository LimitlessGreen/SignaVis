// ═══════════════════════════════════════════════════════════════════════
// index.ts — package entry 'signavis': the core player plus every optional
// module. Hosts that need less import 'signavis/core' and the parts they want.
// The IIFE bundle (window.BirdNETPlayerModule) is built from this file.
// ═══════════════════════════════════════════════════════════════════════

export * from './core.ts';

// Xeno-canto
export {
    DEFAULT_XC_ENDPOINT,
    XenoCantoApiClient,
    XenoCantoApiError,
    buildXenoCantoAnnotationSet,
} from './infrastructure/xeno-canto/xenoCantoApi.ts';
export {
    DEFAULT_XC_RECORDINGS_ENDPOINT,
    normalizeXcId,
    getRecordingScientificName,
    fetchXenoCantoRecording,
    extractXenoCantoRawLabels,
    mapXenoCantoLabelsToSpectrogram,
    importXenoCantoSpectrogramLabels,
} from './infrastructure/xeno-canto/xenoCantoRecordingsApi.ts';

// Taxonomy
export { TaxonomyResolver } from './infrastructure/taxonomyResolver.ts';

// Live recording
export { LiveRecorder, encodeWav, recordingFileName, type LiveRecorderOptions, type LiveRecording } from './infrastructure/audio/LiveRecorder.ts';

// BirdNET
export { BirdNETInference, BIRDNET_MODEL_URL, BIRDNET_V24_MODEL_URL } from './infrastructure/birdnetInference.ts';
