/**
 * Persists user-defined tag options per preset key in localStorage.
 *
 * Usage:
 *   import { CustomTagStore } from './custom-tag-store.js';
 *   const store = new CustomTagStore();
 *   store.add('soundType', 'whistle');
 *   store.getMerged('soundType', ['song', 'call']); // [{value:'song',custom:false}, ..., {value:'whistle',custom:true}]
 */

const STORAGE_KEY = 'aw-custom-tag-options';

export class CustomTagStore {
    // TypeScript property declarations (migrated from JS)
    _data: any;
    toLowerCase: any;
  constructor() {
    this._data = this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      // Validate: each key must map to an array of strings
      const clean: any = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) clean[k] = v.filter((s) => typeof s === 'string' && s.trim());
      }
      return clean;
    } catch {
      return {};
    }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
    } catch { /* quota exceeded — silently ignore */ }
  }

  _emitChange(action: any, key: any, info = {}) {
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        const detail = { action: String(action || ''), key: String(key || ''), ...info };
        window.dispatchEvent(new CustomEvent('aw:customTagStoreChanged', { detail }));
      }
    } catch (e) { /* ignore */ }
  }

  /** Get custom options for a preset key. */
  getCustom(key: any) {
    return (this._data[key] || []).slice();
  }

  /** Add a custom option. No-op if it already exists (case-insensitive). */
  add(key: any, value: any) {
    const trimmed = (value || '').trim();
    if (!trimmed) return false;
    if (!this._data[key]) this._data[key] = [];
    const lc = trimmed.toLowerCase();
    if (this._data[key].some((v: any) => v.toLowerCase() === lc)) return false;
    this._data[key].push(trimmed);
    this._save();
    this._emitChange('add', key, { value: trimmed });
    return true;
  }

  /** Remove a custom option. */
  remove(key: any, value: any) {
    if (!this._data[key]) return false;
    const lc = (value || '').toLowerCase();
    const idx = this._data[key].findIndex((v: any) => v.toLowerCase() === lc);
    if (idx < 0) return false;
    this._data[key].splice(idx, 1);
    if (!this._data[key].length) delete this._data[key];
    this._save();
    this._emitChange('remove', key, { value });
    return true;
  }

  /** Rename a custom option. */
  rename(key: any, oldValue: any, newValue: any) {
    const trimmed = (newValue || '').trim();
    if (!trimmed || !this._data[key]) return false;
    const lcOld = (oldValue || '').toLowerCase();
    const idx = this._data[key].findIndex((v: any) => v.toLowerCase() === lcOld);
    if (idx < 0) return false;
    this._data[key][idx] = trimmed;
    this._save();
    this._emitChange('rename', key, { oldValue, newValue: trimmed });
    return true;
  }

  /**
   * Get merged preset + custom options for a key.
   * @param {string} key
   * @param {string[]} presetOptions
   * @returns {{ value: string, custom: boolean }[]}
   */
  getMerged(key: any, presetOptions: string[] = []) {
    const presetLC = new Set(presetOptions.map((v) => v.toLowerCase()));
    const items = presetOptions.map((v) => ({ value: v, custom: false }));
    for (const v of this.getCustom(key)) {
      if (!presetLC.has(v.toLowerCase())) {
        items.push({ value: v, custom: true });
      }
    }
    return items;
  }
}
