// Can this browser record from the microphone? Kept apart from LiveRecorder so
// the player can answer without loading the recorder.
export function liveRecordingSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
        && typeof AudioContext !== 'undefined';
}
