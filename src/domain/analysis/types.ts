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

/** Grid for range maps: row latitudes (north first) and evenly spaced columns west→east (cell centres). */
export interface RangeGrid {
    lats: number[];
    west: number;
    east: number;
    cols: number;
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
    /** Name of the area model, for the source note (optional). */
    readonly geoModelName?: string | null;
    load(options: AnalysisLoadOptions): Promise<AnalysisLoadResult>;
    setLocation(latitude: number, longitude: number, options?: AnalysisSetLocationOptions): Promise<AnalysisSetLocationResult>;
    getAllSpecies(): Promise<AnalysisSpeciesItem[]>;
    /** Geomodel scores for weeks 1–48 per species at one place; null when unsupported. Optional. */
    getYearProfile?(latitude: number, longitude: number, species: string[]): Promise<Record<string, number[]> | null>;
    /** Geomodel scores of one species on a lat/lon grid for one week; null when unsupported. Optional. */
    getRangeGrid?(species: string, grid: RangeGrid, week: number): Promise<Float32Array | null>;
    clearLocation(): Promise<void>;
    analyze(channelData: Float32Array | number[], options?: AnalysisRunOptions): Promise<AnalysisDetection[]>;
    dispose(): void;
}
