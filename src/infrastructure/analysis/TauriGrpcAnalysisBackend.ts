import type {
    AnalysisBackend,
    AnalysisLoadOptions,
    AnalysisLoadResult,
    AnalysisRunOptions,
    AnalysisDetection,
    AnalysisSetLocationOptions,
    AnalysisSetLocationResult,
    AnalysisSpeciesItem,
} from '../../domain/analysis/types.ts';
import {
    toProtoLoadModelRequest,
    toProtoSetLocationRequest,
    toProtoAnalyzeRequest,
    fromProtoAnalyzeResponse,
} from '../../domain/analysis/protoGatewayMapping.ts';

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

async function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
}

interface TauriGrpcAnalysisBackendOptions {
    invokeImpl?: InvokeFn;
}

/**
 * Desktop analysis adapter that forwards calls to the local Tauri gRPC bridge.
 * This keeps browser builds endpoint-based while desktop can use in-process gRPC.
 */
export class TauriGrpcAnalysisBackend implements AnalysisBackend {
    readonly mode = 'server' as const;
    readonly #invoke: InvokeFn;
    #loaded = false;
    #hasAreaModel = false;

    constructor(options: TauriGrpcAnalysisBackendOptions = {}) {
        this.#invoke = options.invokeImpl ?? defaultInvoke;
    }

    get loaded(): boolean {
        return this.#loaded;
    }

    get hasAreaModel(): boolean {
        return this.#hasAreaModel;
    }

    async load(options: AnalysisLoadOptions): Promise<AnalysisLoadResult> {
        options.onProgress?.('Connecting to desktop gRPC backend…', 10);
        const protoRequest = toProtoLoadModelRequest(options);
        const result = await this.#invoke<AnalysisLoadResult>('grpc_analysis_load_model', {
            model_url: protoRequest.model_url,
        });
        this.#loaded = true;
        this.#hasAreaModel = result.hasAreaModel === true;
        options.onProgress?.('Desktop backend ready', 100);
        return result;
    }

    async setLocation(latitude: number, longitude: number, options: AnalysisSetLocationOptions = {}): Promise<AnalysisSetLocationResult> {
        if (!this.#loaded) return { ok: false };
        const protoRequest = toProtoSetLocationRequest(latitude, longitude, options);
        return this.#invoke<AnalysisSetLocationResult>('grpc_analysis_set_location', {
            latitude: protoRequest.latitude,
            longitude: protoRequest.longitude,
            date_iso8601: protoRequest.date_iso8601 || null,
        });
    }

    async getAllSpecies(): Promise<AnalysisSpeciesItem[]> {
        if (!this.#loaded) return [];
        return this.#invoke<AnalysisSpeciesItem[]>('grpc_analysis_get_species');
    }

    async clearLocation(): Promise<void> {
        if (!this.#loaded) return;
        await this.#invoke<void>('grpc_analysis_clear_location');
    }

    async analyze(channelData: Float32Array | number[], options: AnalysisRunOptions = {}): Promise<AnalysisDetection[]> {
        if (!this.#loaded) throw new Error('Analysis backend is not loaded. Call load() first.');
        options.onProgress?.(5);
        const protoRequest = toProtoAnalyzeRequest(channelData, options);
        const detections = await this.#invoke<AnalysisDetection[]>('grpc_analysis_analyze', {
            samples: protoRequest.samples,
            options: {
                sample_rate: protoRequest.options.sample_rate,
                overlap: protoRequest.options.overlap,
                min_confidence: protoRequest.options.min_confidence,
                geo_threshold: protoRequest.options.geo_threshold,
            },
        });
        options.onProgress?.(100);
        return fromProtoAnalyzeResponse({ detections });
    }

    dispose(): void {
        this.#loaded = false;
        this.#hasAreaModel = false;
    }
}
