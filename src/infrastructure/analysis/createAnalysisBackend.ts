import type { AnalysisBackend, AnalysisBackendMode } from '../../domain/analysis/types.ts';
import { LocalAnalysisBackend } from './LocalAnalysisBackend.ts';
import { HttpAnalysisBackend } from './HttpAnalysisBackend.ts';
import { TauriGrpcAnalysisBackend } from './TauriGrpcAnalysisBackend.ts';

interface CreateAnalysisBackendOptions {
    mode?: AnalysisBackendMode;
    endpoint?: string;
    fetchImpl?: typeof fetch;
    useTauriGrpc?: boolean;
}

/**
 * Creates the analysis backend implementation for the selected runtime mode.
 *
 * local: in-browser TF.js worker inference
 * server/cloud: HTTP API adapter (endpoint required)
 */
export function createAnalysisBackend(options: CreateAnalysisBackendOptions = {}): AnalysisBackend {
    const mode = options.mode ?? 'local';
    if (mode === 'local') {
        return new LocalAnalysisBackend();
    }
    if (mode === 'server' && !options.endpoint && options.useTauriGrpc) {
        return new TauriGrpcAnalysisBackend();
    }
    if (!options.endpoint) {
        throw new Error(`Analysis backend mode \"${mode}\" requires an endpoint.`);
    }
    return new HttpAnalysisBackend({
        mode,
        endpoint: options.endpoint,
        fetchImpl: options.fetchImpl,
    });
}
