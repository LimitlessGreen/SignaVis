// ═══════════════════════════════════════════════════════════════════════
// index.ts — package entry 'signavis': the core player plus every optional
// module. Hosts that need less import 'signavis/core' and the parts they want.
// The IIFE bundle (window.BirdNETPlayerModule) is built from this file.
// ═══════════════════════════════════════════════════════════════════════

export * from './core.ts';
export * from './label-table.ts';

// The full entry's player knows every feature, so boolean options such as
// { labelTable: true } work without passing features. A subclass, not a
// registration at import time: bundlers may drop side effects of this file
// (package.json sideEffects), a class they keep when it is used.
import { BirdNETPlayer as CorePlayer } from './app/BirdNETPlayer.ts';
import { labelTable } from './features/label-table.ts';

const FULL_OPTION_FEATURES = {
    labelTable: (player: CorePlayer) => labelTable({ columns: player.options.labelTableColumns }),
};

export class BirdNETPlayer extends CorePlayer {
    // A getter, not a static field: nothing runs when the class is defined, so a
    // host that imports only e.g. XenoCantoApiClient from 'signavis' drops the player.
    static get optionFeatures() { return FULL_OPTION_FEATURES; }
}

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
