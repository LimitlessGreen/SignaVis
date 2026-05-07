export type AnalysisBackendMode = 'local' | 'server' | 'cloud';

export interface AnalysisLoadOptions {
    modelUrl: string;
    onProgress?: (msg: string, percent: number) => void;
}

export interface AnalysisLoadResult {
    labelCount: number;
    hasAreaModel: boolean;
}

export interface AnalysisSetLocationOptions {
    date?: string | Date;
}

export interface AnalysisSetLocationResult {
    ok: boolean;
    week?: number;
}

export interface AnalysisSpeciesItem {
    scientific: string;
    common: string;
    geoscore: number | null;
}

export interface AnalysisDetection {
    start: number;
    end: number;
    scientific: string;
    common: string;
    confidence: number;
    geoscore: number;
}

export interface AnalysisRunOptions {
    sampleRate?: number;
    overlap?: number;
    minConfidence?: number;
    geoThreshold?: number;
    onProgress?: (percent: number) => void;
}

/**
 * Port for local/server/cloud analysis implementations.
 * Keep this surface minimal and backend-agnostic so UI code can switch
 * between execution modes without touching feature logic.
 */
export interface AnalysisBackend {
    readonly mode: AnalysisBackendMode;
    readonly loaded: boolean;
    readonly hasAreaModel: boolean;
    load(options: AnalysisLoadOptions): Promise<AnalysisLoadResult>;
    setLocation(latitude: number, longitude: number, options?: AnalysisSetLocationOptions): Promise<AnalysisSetLocationResult>;
    getAllSpecies(): Promise<AnalysisSpeciesItem[]>;
    clearLocation(): Promise<void>;
    analyze(channelData: Float32Array | number[], options?: AnalysisRunOptions): Promise<AnalysisDetection[]>;
    dispose(): void;
}
