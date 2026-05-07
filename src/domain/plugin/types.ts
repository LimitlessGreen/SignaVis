// ═══════════════════════════════════════════════════════════════════════
// domain/plugin/types.ts — Plugin system contracts
//
// Design goals:
//   • Declarative manifests so the host can reason about capabilities
//     before activating a plugin (sandboxing, permission display)
//   • Async lifecycle for WASM and remote plugins
//   • No hard dependency on DOM or runtime details
// ═══════════════════════════════════════════════════════════════════════

// ── Capabilities ─────────────────────────────────────────────────────

/**
 * A capability declaration describes what a plugin contributes.
 * The host uses this to gate permission prompts and load order.
 */
export type PluginCapabilityKind =
    | 'analysis'        // contributes an AnalysisBackend implementation
    | 'visualization'   // adds a custom panel or spectrogram overlay
    | 'exporter'        // adds a custom label/project export format
    | 'importer'        // adds a custom label/project import format
    | 'scripting';      // provides a scripting / automation environment

export interface PluginCapability {
    kind: PluginCapabilityKind;
    /** Human-readable description shown in the plugin permission dialog. */
    description?: string;
}

// ── Manifest ─────────────────────────────────────────────────────────

/**
 * Declarative metadata loaded before the plugin is activated.
 * Must be serializable (used for persistence and remote registry).
 */
export interface PluginManifest {
    /** Reverse-DNS-style unique id, e.g. "io.github.youraccount.my-plugin". */
    id: string;
    /** Display name. */
    name: string;
    /** SemVer string, e.g. "1.0.0". */
    version: string;
    /** Minimum host version required. */
    minHostVersion?: string;
    capabilities: PluginCapability[];
    description?: string;
    author?: string;
    homepage?: string;
}

// ── Lifecycle ────────────────────────────────────────────────────────

export interface PluginActivateContext {
    host: import('./IPluginHost.ts').IPluginHost;
}

export interface Plugin {
    readonly manifest: PluginManifest;

    /**
     * Called once after the user grants permissions.
     * The plugin should register its contributions with the host here.
     */
    activate(ctx: PluginActivateContext): Promise<void>;

    /**
     * Called before the plugin is removed.
     * Must clean up all registrations and event listeners.
     */
    deactivate(): Promise<void>;
}

// ── Registration entries (returned by PluginRegistry) ────────────────

export type PluginStatus = 'inactive' | 'activating' | 'active' | 'error';

export interface PluginEntry {
    manifest: PluginManifest;
    status: PluginStatus;
    error?: string;
}
