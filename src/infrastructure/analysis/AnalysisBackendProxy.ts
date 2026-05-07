import type {
    AnalysisBackend,
    AnalysisBackendMode,
    AnalysisLoadOptions,
    AnalysisLoadResult,
    AnalysisRunOptions,
    AnalysisDetection,
    AnalysisSetLocationOptions,
    AnalysisSetLocationResult,
    AnalysisSpeciesItem,
} from '../../domain/analysis/types.ts';

/**
 * Stable facade around a replaceable backend implementation.
 * Existing UI references remain valid while runtime mode changes.
 */
export class AnalysisBackendProxy implements AnalysisBackend {
    #current: AnalysisBackend;

    constructor(initialBackend: AnalysisBackend) {
        this.#current = initialBackend;
    }

    get mode(): AnalysisBackendMode {
        return this.#current.mode;
    }

    get loaded(): boolean {
        return this.#current.loaded;
    }

    get hasAreaModel(): boolean {
        return this.#current.hasAreaModel;
    }

    setBackend(nextBackend: AnalysisBackend): void {
        const previous = this.#current;
        this.#current = nextBackend;
        previous.dispose();
    }

    load(options: AnalysisLoadOptions): Promise<AnalysisLoadResult> {
        return this.#current.load(options);
    }

    setLocation(latitude: number, longitude: number, options: AnalysisSetLocationOptions = {}): Promise<AnalysisSetLocationResult> {
        return this.#current.setLocation(latitude, longitude, options);
    }

    getAllSpecies(): Promise<AnalysisSpeciesItem[]> {
        return this.#current.getAllSpecies();
    }

    clearLocation(): Promise<void> {
        return this.#current.clearLocation();
    }

    analyze(channelData: Float32Array | number[], options: AnalysisRunOptions = {}): Promise<AnalysisDetection[]> {
        return this.#current.analyze(channelData, options);
    }

    dispose(): void {
        this.#current.dispose();
    }
}
