// ═══════════════════════════════════════════════════════════════════════
// taxonomyResolver.js — BirdNET taxonomy lookup with fuzzy matching
// ═══════════════════════════════════════════════════════════════════════

function normalizeScientificName(raw: unknown) {
    const s = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[()]/g, ' ')
        .replace(/[^a-z\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return '';
    const parts = s.split(' ');
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : parts[0];
}

function getGenusAndEpithet(raw: unknown) {
    const n = normalizeScientificName(raw);
    if (!n) return { genus: '', epithet: '' };
    const parts = n.split(' ');
    return { genus: parts[0] || '', epithet: parts[1] || '' };
}

function levenshtein(a: unknown, b: unknown) {
    const s = String(a || '');
    const t = String(b || '');
    if (s === t) return 0;
    if (!s) return t.length;
    if (!t) return s.length;
    const m = s.length;
    const n = t.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i += 1) dp[i][0] = i;
    for (let j = 0; j <= n; j += 1) dp[0][j] = j;
    for (let i = 1; i <= m; i += 1) {
        for (let j = 1; j <= n; j += 1) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost,
            );
        }
    }
    return dp[m][n];
}

export class TaxonomyResolver {
    constructor() {
        this._data = null;
        this._byScientific = new Map();
        this._byScientificNorm = new Map();
        this._byGenus = new Map();
        this._cache = new Map();
    }

    get data() { return this._data; }
    get languages() { return this._data?.languages ?? []; }
    get speciesCount() { return this._data?.speciesCount ?? 0; }
    get modelVersion() { return this._data?.modelVersion ?? ''; }
    get records() { return this._data?.records ?? []; }

    load(data: unknown) {
        if (!data || !Array.isArray(data.records) || !Array.isArray(data.languages)) {
            throw new Error('Invalid taxonomy format.');
        }
        this._data = data;
        this._byScientific = new Map(data.records.map((r: unknown) => [r.s, r]));
        this._byScientificNorm = new Map();
        this._byGenus = new Map();
        this._cache = new Map();
        for (const rec of data.records) {
            const norm = normalizeScientificName(rec?.s || '');
            if (norm && !this._byScientificNorm.has(norm)) {
                this._byScientificNorm.set(norm, rec);
            }
            const { genus } = getGenusAndEpithet(rec?.s || '');
            if (!genus) continue;
            if (!this._byGenus.has(genus)) this._byGenus.set(genus, []);
            this._byGenus.get(genus).push(rec);
        }
    }

    clear() {
        this._data = null;
        this._byScientific = new Map();
        this._byScientificNorm = new Map();
        this._byGenus = new Map();
        this._cache = new Map();
    }

    resolveCommonName(record: unknown, lang: unknown) {
        if (!record || !record.n) return '';
        return record.n[lang] || record.n.en_uk || Object.values(record.n)[0] || '';
    }

    resolve(scientificName: unknown) {
        const raw = String(scientificName || '').trim();
        if (!raw) return null;

        if (this._cache.has(raw)) return this._cache.get(raw);

        let rec = this._byScientific.get(raw) || null;
        if (!rec) {
            const norm = normalizeScientificName(raw);
            if (norm) rec = this._byScientificNorm.get(norm) || null;
        }

        if (!rec) {
            const { genus, epithet } = getGenusAndEpithet(raw);
            const genusCandidates = this._byGenus.get(genus) || [];
            if (epithet && genusCandidates.length) {
                let best = null;
                let bestDist = Number.POSITIVE_INFINITY;
                for (const c of genusCandidates) {
                    const { epithet: candidateEpithet } = getGenusAndEpithet(c?.s || '');
                    if (!candidateEpithet) continue;
                    const d = levenshtein(epithet, candidateEpithet);
                    if (d < bestDist) {
                        bestDist = d;
                        best = c;
                    }
                }
                const threshold = Math.max(1, Math.floor(epithet.length * 0.34));
                if (best && bestDist <= threshold) rec = best;
            }
        }

        this._cache.set(raw, rec || null);
        return rec || null;
    }
}
