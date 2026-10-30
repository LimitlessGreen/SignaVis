/**
 * Tag vocabulary — the allowed values for sound type / sex / life stage, per XC species group.
 *
 * XC publishes the lists per recording (`/api/3/recording/{nr}?key=…&group_properties`); they
 * depend on the group (birds, bats, grasshoppers, …), so they are cached per group. Recordings
 * without XC number use the cached list of the last group seen, else a built-in fallback.
 */

export type VocabKey = 'soundType' | 'sex' | 'lifeStage';
export type Vocabulary = Record<VocabKey, string[]>;

export const VOCAB_KEYS: VocabKey[] = ['soundType', 'sex', 'lifeStage'];

/** Built-in lists (birds), used until XC lists were loaded once. */
export const FALLBACK_VOCABULARY: Vocabulary = {
    soundType: ['song', 'call', 'alarm call', 'flight call', 'begging call', 'drumming', 'nocturnal flight call', 'subsong', 'duet'],
    sex: ['male', 'female', 'uncertain'],
    lifeStage: ['adult', 'juvenile', 'nestling', 'immature', 'subadult', 'uncertain'],
};

/** Field names the XC lists may use for each key. */
const FIELD_ALIASES: Record<VocabKey, string[]> = {
    soundType: ['sound_type', 'sound_types', 'soundType', 'type', 'types'],
    sex: ['sex', 'sexes'],
    lifeStage: ['life_stage', 'life_stages', 'lifeStage', 'stage', 'stages'],
};

const str = (v: any) => String(v ?? '').trim();

function toValues(v: any): string[] {
    if (v == null) return [];
    if (Array.isArray(v)) {
        return v.map((x) => (x && typeof x === 'object' ? str(x.value ?? x.name ?? x.label ?? x.term) : str(x))).filter(Boolean);
    }
    if (typeof v === 'object') {
        // { values: [...] } or { song: "...", call: "..." }
        if (Array.isArray(v.values) || Array.isArray(v.options)) return toValues(v.values ?? v.options);
        return Object.keys(v).map(str).filter(Boolean);
    }
    return [];
}

/**
 * Read the value lists from an XC response. XC v3 returns them as
 * `{"group-sound-properties": {sound_type: [...], sex: [...], life_stage: [...], recording_method: [...]}}`
 * next to the recording fields; also accepted: `{group_properties: {...}}`, the lists at the top level, under a
 * `properties` key or in the first recording, values as strings or `{value|name|label}` objects.
 * Returns only the keys found, or null when nothing was found.
 */
export function parseGroupProperties(json: any): Partial<Vocabulary> | null {
    const candidates = [
        json?.['group-sound-properties'],  // actual XC API v3 response (verified 2026-10-30)
        json?.group_properties, json?.groupProperties, json?.properties,
        json?.recording?.group_properties, json?.recordings?.[0]?.group_properties, json,
    ].filter((c) => c && typeof c === 'object');
    for (const c of candidates) {
        const out: Partial<Vocabulary> = {};
        for (const key of VOCAB_KEYS) {
            // Lists only: a plain string (e.g. a recording's own "type": "song") is a value, not a list
            const field = FIELD_ALIASES[key].find((f) => c[f] != null && typeof c[f] === 'object');
            if (!field) continue;
            const values = [...new Set(toValues(c[field]))];
            if (values.length) out[key] = values;
        }
        if (Object.keys(out).length) return out;
    }
    return null;
}

/** Species group of an XC recording ('birds', 'bats', …), lower case. */
export function recordingGroup(xcMeta: any) {
    return str(xcMeta?.grp ?? xcMeta?.group).toLowerCase();
}

const STORAGE_KEY = 'signavis.xc-group-vocab.v1';

interface VocabStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

/** Per-group cache of XC value lists, persisted in localStorage. */
export class TagVocabularyCache {
    _groups: Record<string, Partial<Vocabulary>> = {};
    _lastGroup = '';
    _storage: VocabStorage | null;

    constructor(storage: VocabStorage | null = (typeof localStorage !== 'undefined' ? localStorage : null)) {
        this._storage = storage;
        try {
            const data = JSON.parse(this._storage?.getItem(STORAGE_KEY) || '{}');
            if (data?.groups && typeof data.groups === 'object') this._groups = data.groups;
            this._lastGroup = str(data?.lastGroup);
        } catch { /* ignore */ }
    }

    has(group: string) { return !!this._groups[str(group).toLowerCase()]; }

    set(group: string, vocab: Partial<Vocabulary>) {
        const g = str(group).toLowerCase() || 'unknown';
        this._groups[g] = vocab;
        this._lastGroup = g;
        try { this._storage?.setItem(STORAGE_KEY, JSON.stringify({ groups: this._groups, lastGroup: this._lastGroup })); } catch { /* ignore */ }
    }

    /**
     * Lists for a group; missing keys fall back to the built-in lists.
     * Without group (no XC number) the last loaded group is used.
     */
    get(group?: string): Vocabulary & { source: 'xc' | 'fallback'; group: string } {
        const g = str(group).toLowerCase() || this._lastGroup;
        const hit = g ? this._groups[g] : undefined;
        const out: any = { source: hit ? 'xc' : 'fallback', group: hit ? g : '' };
        for (const k of VOCAB_KEYS) out[k] = (hit?.[k]?.length ? hit[k]! : FALLBACK_VOCABULARY[k]).slice();
        return out;
    }
}
