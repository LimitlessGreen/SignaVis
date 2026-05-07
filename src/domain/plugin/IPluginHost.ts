// ═══════════════════════════════════════════════════════════════════════
// domain/plugin/IPluginHost.ts — Services the host exposes to plugins
//
// Plugins only ever see this interface, never the concrete application.
// Keeping it narrow ensures forward-compatibility and minimises the
// attack surface for untrusted plugins.
// ═══════════════════════════════════════════════════════════════════════

import type { AnalysisBackend } from '../analysis/types.ts';
import type { Project } from '../project/types.ts';

// ── Contribution types ────────────────────────────────────────────────

export interface LabelImporter {
    /** File extensions this importer handles, e.g. ["csv", "txt"]. */
    readonly fileExtensions: string[];
    /** Display label for the import dialog. */
    readonly label: string;
    /** Parse the file content and return an array of label objects. */
    parse(content: string, filename: string): Promise<import('../annotations.ts').SpectrogramLabel[]>;
}

export interface LabelExporter {
    /** Suggested file extension, e.g. "csv". */
    readonly fileExtension: string;
    /** Display label for the export dialog. */
    readonly label: string;
    /** Serialize labels to a string. */
    serialize(labels: import('../annotations.ts').SpectrogramLabel[]): Promise<string>;
}

export type AnalysisBackendFactory = (opts: { endpoint?: string }) => AnalysisBackend;

// ── Host API ─────────────────────────────────────────────────────────

export interface IPluginHost {
    /**
     * Register a custom AnalysisBackend factory.
     * The returned function removes the registration.
     */
    registerAnalysisBackend(id: string, factory: AnalysisBackendFactory): () => void;

    /**
     * Register a custom label exporter.
     * The returned function removes the registration.
     */
    registerExporter(id: string, exporter: LabelExporter): () => void;

    /**
     * Register a custom label importer.
     * The returned function removes the registration.
     */
    registerImporter(id: string, importer: LabelImporter): () => void;

    /**
     * Read-only snapshot of the currently open project.
     * Returns null when no project is loaded.
     */
    getProject(): Project | null;

    /**
     * Subscribe to a named application event.
     * Returns an unsubscribe function.
     */
    on(event: string, handler: (...args: unknown[]) => void): () => void;
}
