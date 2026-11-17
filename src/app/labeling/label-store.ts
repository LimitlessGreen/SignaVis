// ═══════════════════════════════════════════════════════════════════════
// label-store.ts — the labels of the recording on screen
//
// The only place that replaces the label list. Every change goes through a method,
// which swaps in a new array and tells the subscribers. The array itself is never
// changed in place (frozen in development), so a missed `push` fails loudly.
// Label objects stay plain objects; code that edits one in place calls changed().
//
// `entryId` says which recording the labels belong to. It changes together with the
// labels (load / clear), so they can never be saved into the wrong recording.
// ═══════════════════════════════════════════════════════════════════════

export interface StoredLabel { id: string; [key: string]: unknown }

/** Passed along with a change to the subscribers, e.g. which views need a redraw. */
export interface ChangeMeta {
    /** Views to redraw (default: all). Leave out the ones that already show the change. */
    views?: readonly string[];
}

export type LabelChange = ChangeMeta & (
    | { kind: 'load' | 'clear' | 'replace' | 'touch' }
    | { kind: 'add' | 'update' | 'remove'; ids: string[] }
);

export type LabelListener<L extends StoredLabel> = (change: LabelChange, store: LabelStore<L>) => void;

export interface LabelStoreOptions {
    /** Freeze each new array, so in-place changes throw (development only). */
    freeze?: boolean;
}

export class LabelStore<L extends StoredLabel = StoredLabel> {
    private _labels: readonly L[];
    private _entryId: string | null = null;
    private readonly _listeners = new Set<LabelListener<L>>();
    private readonly _freeze: boolean;

    constructor(opts: LabelStoreOptions = {}) {
        this._freeze = !!opts.freeze;
        this._labels = this._wrap([]);
    }

    /** Current labels. Do not change this array — use the methods. */
    get labels(): readonly L[] { return this._labels; }

    /** Recording the labels belong to (null: none yet, e.g. while a recording loads). */
    get entryId(): string | null { return this._entryId; }

    get size(): number { return this._labels.length; }

    get(id: string): L | undefined { return this._labels.find((l) => l.id === id); }

    has(id: string): boolean { return this._labels.some((l) => l.id === id); }

    /** Labels of a recording, from now on owned by it. */
    load(labels: readonly L[], entryId: string | null, meta?: ChangeMeta): void {
        this._entryId = entryId;
        this._set(labels, { kind: 'load', ...meta });
    }

    /** No labels; owned by `entryId` (default: by no recording). */
    clear(entryId: string | null = null, meta?: ChangeMeta): void {
        this._entryId = entryId;
        this._set([], { kind: 'clear', ...meta });
    }

    /** The labels now belong to this recording (labels unchanged, nobody notified). */
    claim(entryId: string | null): void { this._entryId = entryId; }

    /** New list for the same recording. */
    replaceAll(labels: readonly L[], meta?: ChangeMeta): void { this._set(labels, { kind: 'replace', ...meta }); }

    add(labels: L | readonly L[], meta?: ChangeMeta): void {
        const list: readonly L[] = Array.isArray(labels) ? labels : [labels as L];
        if (!list.length) return;
        this._set([...this._labels, ...list], { kind: 'add', ids: list.map((l) => l.id), ...meta });
    }

    /**
     * Replace labels by id with `fn(old)`; ids that are not there are skipped.
     * Returns the new labels in the order of `ids`.
     */
    update(ids: string | Iterable<string>, fn: (old: L) => L, meta?: ChangeMeta): L[] {
        const want = new Set(typeof ids === 'string' ? [ids] : ids);
        const out: L[] = [];
        const next = this._labels.map((l) => {
            if (!want.has(l.id)) return l;
            const n = fn(l);
            out.push(n);
            return n;
        });
        if (out.length) this._set(next, { kind: 'update', ids: out.map((l) => l.id), ...meta });
        return out;
    }

    /** Shallow-merge `patch` into one label. */
    patch(id: string, patch: Partial<L>, meta?: ChangeMeta): L | undefined {
        return this.update(id, (old) => ({ ...old, ...patch }), meta)[0];
    }

    /** Remove labels by id, or every label `pred` accepts. Returns the removed ones. */
    remove(which: string | Iterable<string> | ((l: L) => boolean), meta?: ChangeMeta): L[] {
        let pred: (l: L) => boolean;
        if (typeof which === 'function') pred = which;
        else {
            const ids = new Set(typeof which === 'string' ? [which] : which);
            pred = (l) => ids.has(l.id);
        }
        const removed: L[] = [];
        const kept = this._labels.filter((l) => (pred(l) ? (removed.push(l), false) : true));
        if (removed.length) this._set(kept, { kind: 'remove', ids: removed.map((l) => l.id), ...meta });
        return removed;
    }

    /** Label objects were edited in place: tell the subscribers. */
    changed(meta?: ChangeMeta): void { this._emit({ kind: 'touch', ...meta }); }

    /** Call `fn` after every change; returns the unsubscribe function. */
    subscribe(fn: LabelListener<L>): () => void {
        this._listeners.add(fn);
        return () => { this._listeners.delete(fn); };
    }

    private _wrap(arr: L[]): readonly L[] { return this._freeze ? Object.freeze(arr) : arr; }

    private _set(labels: readonly L[], change: LabelChange): void {
        this._labels = this._wrap([...labels]);
        this._emit(change);
    }

    private _emit(change: LabelChange): void {
        for (const fn of [...this._listeners]) {
            try { fn(change, this); } catch (e) { console.error('[labels] listener failed', e); }
        }
    }
}
