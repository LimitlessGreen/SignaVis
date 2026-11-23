/**
 * User species lists — the SignaVis counterpart of BirdNET's `--slist` file.
 * A list is a named set of scientific names; the active one restricts BirdNET
 * detections. Pure helpers + a small prefs-backed store.
 */
import { prefsStorage } from '../infrastructure/storage/prefs.ts';

export interface SpeciesList {
  id: string;
  name: string;
  /** Scientific names, unique, in insertion order. */
  species: string[];
  source?: 'manual' | 'location' | 'import' | 'labels';
  updatedAt: number;
}

export interface SpeciesListState {
  activeId: string | null;
  lists: SpeciesList[];
}

export const STORAGE_KEY = 'signavis.speciesLists.v1';

/**
 * Parse a BirdNET species list file. Accepts `Genus species_Common name`
 * (BirdNET labels format), plain scientific names and CSV/TSV rows whose first
 * column is the scientific name. Blank lines and `#` comments are skipped.
 */
export function parseSpeciesListText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sci = line.split(/[_\t;,]/)[0].replace(/^"|"$/g, '').trim().replace(/\s+/g, ' ');
    if (!sci || /^scientific/i.test(sci)) continue;
    const key = sci.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sci);
  }
  return out;
}

/** BirdNET `--slist` format: one `Scientific name_Common name` per line. */
export function serializeSpeciesList(species: string[], commonName: (sci: string) => string = () => ''): string {
  return species.map((sci) => {
    const common = commonName(sci);
    return common ? `${sci}_${common}` : sci;
  }).join('\n') + '\n';
}

/** Case-insensitive membership set for filtering. */
export function speciesFilterSet(list: SpeciesList | null | undefined): Set<string> | null {
  return list ? new Set(list.species.map((s) => s.toLowerCase())) : null;
}

/** Keep detections whose scientific name is in the set (null = no filter). */
export function filterBySpeciesList<T extends { scientific?: string }>(dets: T[], set: Set<string> | null): T[] {
  if (!set) return dets;
  return dets.filter((d) => set.has(String(d.scientific || '').toLowerCase()));
}

const newId = () => `sl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class SpeciesListStore {
  state: SpeciesListState;
  private listeners = new Set<() => void>();
  private storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  constructor(storage?: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.state = this.load();
  }

  private load(): SpeciesListState {
    try {
      const raw = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null');
      if (raw && Array.isArray(raw.lists)) {
        const lists = raw.lists.filter((l: any) => l && typeof l.id === 'string' && Array.isArray(l.species));
        const activeId = lists.some((l: any) => l.id === raw.activeId) ? raw.activeId : null;
        return { activeId, lists };
      }
    } catch { /* corrupt → start fresh */ }
    return { activeId: null, lists: [] };
  }

  private commit() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* quota */ }
    this.listeners.forEach((fn) => fn());
  }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  get lists() { return this.state.lists; }
  get(id: string | null) { return this.state.lists.find((l) => l.id === id) || null; }
  get active() { return this.get(this.state.activeId); }

  create(name: string, species: string[] = [], source: SpeciesList['source'] = 'manual'): SpeciesList {
    const list: SpeciesList = { id: newId(), name: name.trim() || 'Untitled list', species: dedupe(species), source, updatedAt: Date.now() };
    this.state.lists.push(list);
    this.commit();
    return list;
  }

  rename(id: string, name: string) { this.patch(id, (l) => { l.name = name.trim() || l.name; }); }

  add(id: string, sci: string[]) {
    this.patch(id, (l) => { l.species = dedupe([...l.species, ...sci]); });
  }

  remove(id: string, sci: string[]) {
    const drop = new Set(sci.map((s) => s.toLowerCase()));
    this.patch(id, (l) => { l.species = l.species.filter((s) => !drop.has(s.toLowerCase())); });
  }

  duplicate(id: string) {
    const src = this.get(id);
    return src ? this.create(`${src.name} (copy)`, src.species, src.source) : null;
  }

  delete(id: string) {
    this.state.lists = this.state.lists.filter((l) => l.id !== id);
    if (this.state.activeId === id) this.state.activeId = null;
    this.commit();
  }

  /** null = all species (no filter). */
  setActive(id: string | null) {
    this.state.activeId = id && this.get(id) ? id : null;
    this.commit();
  }

  private patch(id: string, fn: (l: SpeciesList) => void) {
    const l = this.get(id);
    if (!l) return;
    fn(l);
    l.updatedAt = Date.now();
    this.commit();
  }
}

function dedupe(species: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of species) {
    const v = String(s || '').trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

/** The prefs store (blocked storage is handled there). */
function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  return prefsStorage;
}
