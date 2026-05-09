import type { AnalysisBackend, AnalysisBackendMode } from '../../domain/analysis/types.ts';
import { LocalAnalysisBackend } from './LocalAnalysisBackend.ts';
import { HttpAnalysisBackend } from './HttpAnalysisBackend.ts';
import { TauriGrpcAnalysisBackend } from './TauriGrpcAnalysisBackend.ts';

export type RequestedAnalysisBackendMode = AnalysisBackendMode | 'hybrid';

interface CreateAnalysisBackendOptions {
    mode?: RequestedAnalysisBackendMode;
    endpoint?: string;
    fetchImpl?: typeof fetch;
    useTauriGrpc?: boolean;
}

export interface ResolvedAnalysisBackend {
    requestedMode: RequestedAnalysisBackendMode;
    effectiveMode: AnalysisBackendMode;
    endpoint?: string;
    reason?: string;
    backend: AnalysisBackend;
}

function normalizeEndpoint(endpoint?: string): string | undefined {
    const raw = String(endpoint ?? '').trim();
    if (!raw) {
        return undefined;
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`Invalid analysis endpoint URL: "${raw}".`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Analysis endpoint must use http:// or https:// (got "${parsed.protocol}").`);
    }

    return parsed.href.replace(/\/$/, '');
}

export function resolveAnalysisBackend(options: CreateAnalysisBackendOptions = {}): ResolvedAnalysisBackend {
    const requestedMode = options.mode ?? 'local';
    const endpoint = normalizeEndpoint(options.endpoint);

    if (requestedMode === 'local') {
        return {
            requestedMode,
            effectiveMode: 'local',
            backend: new LocalAnalysisBackend(),
        };
    }

    if (requestedMode === 'server') {
        if (!endpoint && options.useTauriGrpc) {
            return {
                requestedMode,
                effectiveMode: 'server',
                reason: 'tauri-grpc-no-endpoint',
                backend: new TauriGrpcAnalysisBackend(),
            };
        }
        if (!endpoint) {
            throw new Error('Analysis backend mode "server" requires an endpoint.');
        }
        return {
            requestedMode,
            effectiveMode: 'server',
            endpoint,
            backend: new HttpAnalysisBackend({
                mode: 'server',
                endpoint,
                fetchImpl: options.fetchImpl,
            }),
        };
    }

    if (requestedMode === 'cloud') {
        if (!endpoint) {
            throw new Error('Analysis backend mode "cloud" requires an endpoint.');
        }
        return {
            requestedMode,
            effectiveMode: 'cloud',
            endpoint,
            backend: new HttpAnalysisBackend({
                mode: 'cloud',
                endpoint,
                fetchImpl: options.fetchImpl,
            }),
        };
    }

    // hybrid mode prefers remote execution when configured, otherwise falls back.
    if (endpoint) {
        return {
            requestedMode,
            effectiveMode: 'server',
            endpoint,
            reason: 'hybrid-http-endpoint',
            backend: new HttpAnalysisBackend({
                mode: 'server',
                endpoint,
                fetchImpl: options.fetchImpl,
            }),
        };
    }

    if (options.useTauriGrpc) {
        return {
            requestedMode,
            effectiveMode: 'server',
            reason: 'hybrid-tauri-grpc',
            backend: new TauriGrpcAnalysisBackend(),
        };
    }

    return {
        requestedMode,
        effectiveMode: 'local',
        reason: 'hybrid-local-fallback',
        backend: new LocalAnalysisBackend(),
    };
}

/**
 * Creates the analysis backend implementation for the selected runtime mode.
 *
 * local: in-browser TF.js worker inference
 * server/cloud: HTTP API adapter (endpoint required)
 */
export function createAnalysisBackend(options: CreateAnalysisBackendOptions = {}): AnalysisBackend {
    return resolveAnalysisBackend(options).backend;
}
