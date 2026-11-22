// ═══════════════════════════════════════════════════════════════════════
// core.ts — package entry 'signavis/core': the player and what it needs.
//
// Optional modules (Xeno-canto, BirdNET, live recording, taxonomy) are
// separate entries and are not pulled in here. 'signavis' (index.ts) is
// core + all of them.
// tests/core-coupling.test.mjs keeps this entry from growing them back in.
// ═══════════════════════════════════════════════════════════════════════

export * from './app/BirdNETPlayer.ts';
export type { PlayerFeature, OptionFeatureFactory } from './app/playerFeature.ts';
export { readRecordingStart, isoClockTime, ravenClock, utcLabel, formatRecordingStart, type RecordingStart } from './domain/recordingTime.ts';

// Events
export { EventBus } from './shared/EventBus.ts';
export type { EventHandler } from './shared/EventBus.ts';
export type {
    TransportState,
    TransportStateChangeDetail,
    AudioEngineReadyDetail,
    AudioEngineUiUpdateDetail,
    SpectrogramReadyDetail,
    AnnotationEntry,
    SpectrogramLabelEntry,
    LabelFocusDetail,
    UndoChangeDetail,
    AnnotationEventDetail,
    SpectrogramLabelEventDetail,
} from './shared/events.ts';

// Headless / testing utilities
export { AudioEngineBase } from './infrastructure/audio/AudioEngineBase.ts';
export { MockAudioEngine } from './infrastructure/audio/MockAudioEngine.ts';
export type { IStorage } from './infrastructure/storage/IStorage.ts';
export { StorageBase } from './infrastructure/storage/IStorage.ts';
export { InMemoryStorageAdapter } from './infrastructure/storage/InMemoryStorageAdapter.ts';
export { LocalStorageAdapter } from './infrastructure/storage/LocalStorageAdapter.ts';
export { prefs, prefsStorage, setPrefsBackend, type PrefsBackend } from './infrastructure/storage/prefs.ts';

// Domain
export type { UndoCommand } from './domain/undoStack.ts';
export { UndoStack } from './domain/undoStack.ts';
export type { TransportStateName } from './domain/transportState.ts';
export { FrequencyViewport } from './app/FrequencyViewport.ts';
