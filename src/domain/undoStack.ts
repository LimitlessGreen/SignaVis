// ── Undo / Redo (Dual-mode: Memento + Command) ─────────────────────────
//
// Two entry kinds on the same stack, interleaved:
//
//   Memento  – push(snapshot)
//     Caller has already applied the change.
//     undo() returns the previous snapshot; caller restores state.
//     redo() returns the next snapshot; caller restores state.
//
//   Command  – record(command)
//     Caller has already applied the change (command.execute was called outside).
//     undo() calls command.undo() internally, returns null.
//     redo() calls command.execute() internally, returns null.
//
// Return value of undo() / redo():
//   • snapshot data  — if a memento entry was traversed (caller must restore it)
//   • null           — if a command entry was traversed (side-effect already applied)
//                      OR if nothing could be undone/redone

export interface UndoCommand {
    type?: string;
    description?: string;
    execute(): void;
    undo(): void;
}

type StackEntry<T> =
    | { kind: 'snapshot'; data: T }
    | { kind: 'command';  cmd: UndoCommand };

export class UndoStack<T = unknown> {
    private _stack: StackEntry<T>[] = [];
    private _index = -1;
    private readonly _maxSize: number;

    constructor(maxSize = 100) {
        this._maxSize = maxSize;
    }

    // ── Memento API (backward-compatible) ────────────────────────────

    push(snapshot: T): void {
        this._commit({ kind: 'snapshot', data: snapshot });
    }

    // ── Command API ───────────────────────────────────────────────────

    record(command: UndoCommand): void {
        this._commit({ kind: 'command', cmd: command });
    }

    // ── Traversal ─────────────────────────────────────────────────────

    undo(): T | null {
        if (this._index <= 0) return null;
        const current = this._stack[this._index];
        this._index--;
        if (current.kind === 'command') {
            try { current.cmd.undo(); } catch (e) { console.error('UndoStack: command.undo() failed', e); }
            return null;
        }
        const prev = this._stack[this._index];
        return prev.kind === 'snapshot' ? prev.data : null;
    }

    redo(): T | null {
        if (this._index >= this._stack.length - 1) return null;
        this._index++;
        const entry = this._stack[this._index];
        if (entry.kind === 'command') {
            try { entry.cmd.execute(); } catch (e) { console.error('UndoStack: command.execute() failed', e); }
            return null;
        }
        return entry.data;
    }

    // ── Introspection ─────────────────────────────────────────────────

    get canUndo(): boolean { return this._index > 0; }
    get canRedo(): boolean { return this._index < this._stack.length - 1; }
    get size(): number     { return this._stack.length; }

    peekUndoKind(): 'snapshot' | 'command' | null {
        if (this._index <= 0) return null;
        return this._stack[this._index].kind;
    }

    peekUndoDescription(): string | null {
        if (this._index <= 0) return null;
        const entry = this._stack[this._index];
        return entry.kind === 'command' ? (entry.cmd.description ?? null) : null;
    }

    clear(): void { this._stack.length = 0; this._index = -1; }

    // ── Private ───────────────────────────────────────────────────────

    private _commit(entry: StackEntry<T>): void {
        this._stack.length = this._index + 1;
        this._stack.push(entry);
        if (this._stack.length > this._maxSize) {
            this._stack.splice(0, this._stack.length - this._maxSize);
        }
        this._index = this._stack.length - 1;
    }
}
