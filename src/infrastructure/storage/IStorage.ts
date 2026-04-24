// ═══════════════════════════════════════════════════════════════════════
// storage/IStorage.ts — Sync key-value storage interface
// ═══════════════════════════════════════════════════════════════════════

export interface IStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    hasItem(key: string): boolean;
    clear(): void;
}

export abstract class StorageBase implements IStorage {
    getItem(_key: string): string | null {
        throw new Error(`${this.constructor.name}: getItem not implemented`);
    }
    setItem(_key: string, _value: string): void {
        throw new Error(`${this.constructor.name}: setItem not implemented`);
    }
    removeItem(_key: string): void {
        throw new Error(`${this.constructor.name}: removeItem not implemented`);
    }
    hasItem(key: string): boolean { return this.getItem(key) !== null; }
    clear(): void {
        throw new Error(`${this.constructor.name}: clear not implemented`);
    }
}
