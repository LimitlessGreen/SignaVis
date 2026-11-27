// ═══════════════════════════════════════════════════════════════════════
// app/lite/assistant-bridge.ts — connects the tool registry to the Rust MCP server (Lite only)
//
// Registers the tool list (mcp_set_tools), answers `mcp://call` events (mcp_respond) and switches
// the server on/off (mcp_set_enabled). Whether it is on is remembered per install (prefs).
// ═══════════════════════════════════════════════════════════════════════

import type { ToolRegistry } from './assistant-tools.ts';

export interface McpStatus { running: boolean; url: string | null; configPath: string | null; clientConfig: unknown }

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export const MCP_PREF_KEY = 'signavis.lite.mcpEnabled';

export class AssistantBridge {
    status: McpStatus | null = null;
    private invoke: Invoke | null = null;
    private reg: ToolRegistry;
    private prefs: Pick<Storage, 'getItem' | 'setItem'>;

    constructor(reg: ToolRegistry, prefs: Pick<Storage, 'getItem' | 'setItem'>) { this.reg = reg; this.prefs = prefs; }

    get enabled() { return !!this.status?.running; }

    async start(): Promise<void> {
        const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
        this.invoke = invoke as Invoke;
        await this.invoke('mcp_set_tools', { tools: this.reg.list() });
        await listen<{ id: number; name: string; arguments: unknown }>('mcp://call', async ({ payload }) => {
            const result = await this.reg.call(payload.name, payload.arguments);
            await this.invoke!('mcp_respond', { id: payload.id, result }).catch((e) => console.warn('[assistant] respond failed', e));
        });
        this.status = await this.invoke<McpStatus>('mcp_status');
        if (this.prefs.getItem(MCP_PREF_KEY) === '1' && !this.status.running) await this.setEnabled(true).catch((e) => console.warn('[assistant]', e));
    }

    async setEnabled(on: boolean): Promise<McpStatus> {
        if (!this.invoke) throw new Error('assistant bridge not started');
        this.status = await this.invoke<McpStatus>('mcp_set_enabled', { enabled: on });
        this.prefs.setItem(MCP_PREF_KEY, on ? '1' : '0');
        return this.status;
    }
}
