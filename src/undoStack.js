// ── Undo / Redo (Snapshot-based Memento) ────────────────────────────
export class UndoStack {
    /**
     * @param {number} [maxSize=100] - maximum number of undo snapshots
     */
    constructor(maxSize = 100) {
        /** @type {Array<any>} */
        this._stack = [];
        this._index = -1;
        this._maxSize = maxSize;
    }
    /** Push a new snapshot. Discards any redo history. */
    push(snapshot) {
        // Drop redo tail
        this._stack.length = this._index + 1;
        this._stack.push(snapshot);
        // Enforce max size by dropping oldest entries
        if (this._stack.length > this._maxSize) {
            this._stack.splice(0, this._stack.length - this._maxSize);
        }
        this._index = this._stack.length - 1;
    }
    /** Return previous snapshot or null if at beginning. */
    undo() {
        if (this._index <= 0) return null;
        this._index--;
        return this._stack[this._index];
    }
    /** Return next snapshot or null if at end. */
    redo() {
        if (this._index >= this._stack.length - 1) return null;
        this._index++;
        return this._stack[this._index];
    }
    get canUndo() { return this._index > 0; }
    get canRedo() { return this._index < this._stack.length - 1; }
    get size() { return this._stack.length; }
    clear() { this._stack.length = 0; this._index = -1; }
}
