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

interface HttpAnalysisBackendOptions {
    mode: Extract<AnalysisBackendMode, 'server' | 'cloud'>;
    endpoint: string;
    fetchImpl?: typeof fetch;
}

export class HttpAnalysisBackend implements AnalysisBackend {
    readonly mode: Extract<AnalysisBackendMode, 'server' | 'cloud'>;
    readonly #endpoint: string;
    readonly #fetchImpl: typeof fetch;
    #loaded = false;
    #hasAreaModel = false;

    constructor({ mode, endpoint, fetchImpl }: HttpAnalysisBackendOptions) {
        this.mode = mode;
        this.#endpoint = endpoint.replace(/\/$/, '');
        this.#fetchImpl = fetchImpl ?? fetch;
    }

    get loaded(): boolean {
        return this.#loaded;
    }

    get hasAreaModel(): boolean {
        return this.#hasAreaModel;
    }

    async load(options: AnalysisLoadOptions): Promise<AnalysisLoadResult> {
        options.onProgress?.('Connecting to analysis backend…', 10);
        const result = await this.#jsonRequest<AnalysisLoadResult>('/analysis/load', {
            method: 'POST',
            body: JSON.stringify({ modelUrl: options.modelUrl }),
        });
        this.#loaded = true;
        this.#hasAreaModel = result.hasAreaModel === true;
        options.onProgress?.('Backend ready', 100);
        return result;
    }

    async setLocation(latitude: number, longitude: number, options: AnalysisSetLocationOptions = {}): Promise<AnalysisSetLocationResult> {
        if (!this.#loaded) return { ok: false };
        const date = options.date instanceof Date ? options.date.toISOString() : options.date;
        return this.#jsonRequest<AnalysisSetLocationResult>('/analysis/location', {
            method: 'POST',
            body: JSON.stringify({ latitude, longitude, date: date ?? null }),
        });
    }

    async getAllSpecies(): Promise<AnalysisSpeciesItem[]> {
        if (!this.#loaded) return [];
        return this.#jsonRequest<AnalysisSpeciesItem[]>('/analysis/species', { method: 'GET' });
    }

    async clearLocation(): Promise<void> {
        if (!this.#loaded) return;
        await this.#jsonRequest<void>('/analysis/location', { method: 'DELETE' });
    }

    async analyze(channelData: Float32Array | number[], options: AnalysisRunOptions = {}): Promise<AnalysisDetection[]> {
        if (!this.#loaded) throw new Error('Analysis backend is not loaded. Call load() first.');
        options.onProgress?.(5);
        const samples = channelData instanceof Float32Array ? Array.from(channelData) : Array.from(channelData as number[]);
        const detections = await this.#jsonRequest<AnalysisDetection[]>('/analysis/analyze', {
            method: 'POST',
            body: JSON.stringify({
                samples,
                options: {
                    sampleRate: options.sampleRate,
                    overlap: options.overlap,
                    minConfidence: options.minConfidence,
                    geoThreshold: options.geoThreshold,
                },
            }),
        });
        options.onProgress?.(100);
        return detections;
    }

    dispose(): void {
        this.#loaded = false;
        this.#hasAreaModel = false;
    }

    async #jsonRequest<T>(path: string, init: RequestInit): Promise<T> {
        const response = await this.#fetchImpl(`${this.#endpoint}${path}`, {
            ...init,
            headers: {
                'content-type': 'application/json',
                ...(init.headers ?? {}),
            },
        });
        if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try {
                const payload = await response.json() as { message?: string };
                if (payload?.message) message = payload.message;
            } catch {
                // Keep status fallback.
            }
            throw new Error(`Analysis backend request failed: ${message}`);
        }
        if (response.status === 204) return undefined as T;
        return response.json() as Promise<T>;
    }
}
