// ═══════════════════════════════════════════════════════════════════════
// app/lite/assistant-tools.ts — tools an AI assistant may call (MCP, later an in-app chat)
//
// One registry: name, description, JSON schema of the arguments, tier and handler. The Lite app
// registers its tools (labeling/main.js); the Rust MCP server (src-tauri-lite/src/mcp.rs) lists
// them and forwards calls here. Pure apart from the handlers: argument checking, results in the
// MCP shape, tiers (read / write / destructive) and an activity log.
// ═══════════════════════════════════════════════════════════════════════

export type ToolTier = 'read' | 'write' | 'destructive';

export interface JsonSchema {
    type?: string | string[];
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    additionalProperties?: boolean;
    default?: unknown;
}

/** MCP content blocks a handler may return (text is the usual one). */
export type ToolContent =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string };

export interface ToolResult { content: ToolContent[]; isError?: boolean; structuredContent?: unknown }

export interface ToolContext {
    /** Ask the person (destructive tools); false = declined. */
    confirm: (message: string, title: string) => Promise<boolean>;
}

export interface ToolDef {
    name: string;
    title?: string;
    description: string;
    tier: ToolTier;
    input?: JsonSchema;
    /** Returns plain data (sent as JSON text + structuredContent), a string, or a ToolResult. */
    run: (args: Record<string, any>, ctx: ToolContext) => unknown | Promise<unknown>;
    /** Destructive tools: the question shown before running (default: generic). */
    confirmText?: (args: Record<string, any>) => string;
}

export interface ToolLogEntry { at: string; name: string; tier: ToolTier; ok: boolean; summary: string }

/** The tool list in the MCP `tools/list` shape. */
export interface McpTool {
    name: string;
    title?: string;
    description: string;
    inputSchema: JsonSchema;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint?: boolean };
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array'
    : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v);

/** Problems of `value` against `schema` (the subset tools use); empty = fine. */
export function checkArgs(schema: JsonSchema | undefined, value: unknown, path = 'arguments'): string[] {
    if (!schema) return [];
    const errs: string[] = [];
    if (schema.type) {
        const want = Array.isArray(schema.type) ? schema.type : [schema.type];
        const got = typeOf(value);
        const ok = want.some((t) => t === got || (t === 'number' && got === 'integer'));
        if (!ok) return [`${path} must be ${want.join(' or ')}, got ${got}`];
    }
    if (schema.enum && !schema.enum.includes(value)) errs.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    if (typeof value === 'number') {
        if (schema.minimum != null && value < schema.minimum) errs.push(`${path} must be ≥ ${schema.minimum}`);
        if (schema.maximum != null && value > schema.maximum) errs.push(`${path} must be ≤ ${schema.maximum}`);
    }
    if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...checkArgs(schema.items, v, `${path}[${i}]`)));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        for (const r of schema.required || []) if (obj[r] === undefined) errs.push(`${path}.${r} is required`);
        for (const [k, v] of Object.entries(obj)) {
            const sub = schema.properties?.[k];
            if (sub) errs.push(...checkArgs(sub, v, `${path}.${k}`));
            else if (schema.additionalProperties === false) errs.push(`${path}.${k} is not a known argument`);
        }
    }
    return errs;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

function asResult(out: unknown): ToolResult {
    if (out && typeof out === 'object' && Array.isArray((out as ToolResult).content)) return out as ToolResult;
    if (typeof out === 'string') return text(out);
    if (out === undefined) return text('done');
    const res: ToolResult = text(JSON.stringify(out, null, 1));
    // structuredContent must be an object (MCP); arrays go in as { items }.
    res.structuredContent = Array.isArray(out) ? { items: out } : (typeof out === 'object' && out ? out : { value: out });
    return res;
}

export class ToolRegistry {
    private tools = new Map<string, ToolDef>();
    readonly log: ToolLogEntry[] = [];
    /** Called after every call (the app shows write calls as a toast). */
    onCall: ((entry: ToolLogEntry) => void) | null = null;

    private ctx: ToolContext;

    constructor(ctx: ToolContext) { this.ctx = ctx; }

    add(def: ToolDef): this {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(def.name)) throw new Error(`bad tool name: ${def.name}`);
        this.tools.set(def.name, def);
        return this;
    }

    has(name: string) { return this.tools.has(name); }

    list(): McpTool[] {
        return [...this.tools.values()].map((t) => ({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            description: t.description,
            inputSchema: { type: 'object', properties: {}, ...(t.input || {}) },
            annotations: { readOnlyHint: t.tier === 'read', destructiveHint: t.tier === 'destructive', ...(t.tier === 'read' ? { idempotentHint: true } : {}) },
        }));
    }

    /** Run a tool; never throws (errors come back as `isError` results, as MCP wants for tool errors). */
    async call(name: string, args: unknown = {}): Promise<ToolResult> {
        const def = this.tools.get(name);
        if (!def) return text(`Unknown tool "${name}". Call tools/list for the available tools.`, true);
        const a = (args ?? {}) as Record<string, any>;
        const errs = checkArgs({ type: 'object', ...(def.input || {}) }, a);
        if (errs.length) return this.done(def, false, text(`Invalid arguments: ${errs.join('; ')}`, true));
        try {
            if (def.tier === 'destructive') {
                const q = def.confirmText?.(a) || `An AI assistant wants to run "${def.title || def.name}".`;
                if (!await this.ctx.confirm(q, 'AI assistant')) return this.done(def, false, text('The person declined this action in SignaVis.', true));
            }
            return this.done(def, true, asResult(await def.run(a, this.ctx)));
        } catch (e) {
            return this.done(def, false, text(`Error: ${e instanceof Error ? e.message : String(e)}`, true));
        }
    }

    private done(def: ToolDef, ok: boolean, res: ToolResult): ToolResult {
        const first = res.content[0];
        const summary = first?.type === 'text' ? first.text.slice(0, 160) : first?.type || '';
        const entry: ToolLogEntry = { at: new Date().toISOString(), name: def.name, tier: def.tier, ok: ok && !res.isError, summary };
        this.log.push(entry);
        if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
        try { this.onCall?.(entry); } catch { /* the log must not break a call */ }
        return res;
    }
}
