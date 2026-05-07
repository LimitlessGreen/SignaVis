import { BirdNETInference } from '../birdnetInference.ts';
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

export class LocalAnalysisBackend implements AnalysisBackend {
    readonly mode: AnalysisBackendMode = 'local';
    #birdnet = new BirdNETInference();

    get loaded(): boolean {
        return this.#birdnet.loaded;
    }

    get hasAreaModel(): boolean {
        return this.#birdnet.hasAreaModel;
    }

    load(options: AnalysisLoadOptions): Promise<AnalysisLoadResult> {
        return this.#birdnet.load(options);
    }

    setLocation(latitude: number, longitude: number, options: AnalysisSetLocationOptions = {}): Promise<AnalysisSetLocationResult> {
        return this.#birdnet.setLocation(latitude, longitude, options);
    }

    getAllSpecies(): Promise<AnalysisSpeciesItem[]> {
        return this.#birdnet.getAllSpecies();
    }

    clearLocation(): Promise<void> {
        return this.#birdnet.clearLocation();
    }

    analyze(channelData: Float32Array | number[], options: AnalysisRunOptions = {}): Promise<AnalysisDetection[]> {
        return this.#birdnet.analyze(channelData, options);
    }

    dispose(): void {
        this.#birdnet.dispose();
    }
}
