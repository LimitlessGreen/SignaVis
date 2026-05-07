import type {
    AnalysisLoadOptions,
    AnalysisSetLocationOptions,
    AnalysisRunOptions,
    AnalysisDetection,
} from './types.ts';

export interface ProtoLoadModelRequest {
    model_url: string;
}

export interface ProtoSetLocationRequest {
    latitude: number;
    longitude: number;
    date_iso8601: string;
}

export interface ProtoAnalyzeRequest {
    samples: number[];
    options: {
        sample_rate: number;
        overlap: number;
        min_confidence: number;
        geo_threshold: number;
    };
}

export interface ProtoAnalyzeResponse {
    detections: Array<{
        start: number;
        end: number;
        scientific: string;
        common: string;
        confidence: number;
        geoscore: number;
    }>;
}

export function toProtoLoadModelRequest(options: AnalysisLoadOptions): ProtoLoadModelRequest {
    return { model_url: options.modelUrl };
}

export function toProtoSetLocationRequest(
    latitude: number,
    longitude: number,
    options: AnalysisSetLocationOptions = {},
): ProtoSetLocationRequest {
    const date = options.date instanceof Date ? options.date.toISOString() : (options.date ?? '');
    return {
        latitude,
        longitude,
        date_iso8601: date,
    };
}

export function toProtoAnalyzeRequest(
    channelData: Float32Array | number[],
    options: AnalysisRunOptions = {},
): ProtoAnalyzeRequest {
    return {
        samples: Array.from(channelData as ArrayLike<number>),
        options: {
            sample_rate: options.sampleRate ?? 48000,
            overlap: options.overlap ?? 0,
            min_confidence: options.minConfidence ?? 0.25,
            geo_threshold: options.geoThreshold ?? 0,
        },
    };
}

export function fromProtoAnalyzeResponse(response: ProtoAnalyzeResponse): AnalysisDetection[] {
    return (response.detections || []).map((d) => ({
        start: d.start,
        end: d.end,
        scientific: d.scientific,
        common: d.common,
        confidence: d.confidence,
        geoscore: d.geoscore,
    }));
}
