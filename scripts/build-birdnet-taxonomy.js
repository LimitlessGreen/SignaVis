#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const CORNELL_TAXONOMY_URL = 'https://birdnet.cornell.edu/taxonomy/api/download/json';
// BirdNET+ V3.0 Global 12K labels (Zenodo record, Apache-2.0): the model's full
// class list with birdnet_id, taxon group and common names in ~35 languages.
const V3_RECORD = '24162518';
const V3_LABELS_FILE = 'BirdNET+_V3.0_Global_12K_Labels.csv';
const V3_LABELS_URL = `https://zenodo.org/records/${V3_RECORD}/files/${V3_LABELS_FILE}?download=1`;
const V3_MODEL_VERSION = 'BirdNET+ V3.0';

// V3 / Cornell language codes -> the codes the app has used since V2.4.
const LANG_ALIASES = { en: 'en_uk', pt: 'pt_BR', 'zh-CN': 'zh' };
// Regional variants we do not offer as separate UI languages.
const SKIP_LANGS = new Set(['es_EC', 'es_ES', 'es_MX', 'zh-CN']);

const IMAGE_WIDTH = 480;
const IMAGE_HEIGHT = 320;
const WEBP_QUALITY = 70;

const CURATED_LABEL_ALIASES = {
    "Hypsiboas albomarginatus": "Boana albomarginata",
    "Hypsiboas albopunctatus": "Boana albopunctata",
    "Hypsiboas bischoffi": "Boana bischoffi",
    "Hypsiboas boans": "Boana boans",
    "Hypsiboas cinerascens": "Boana cinerascens",
    "Hypsiboas faber": "Boana faber",
    "Hypsiboas lanciformis": "Boana lanciformis",
    "Hypsiboas pardalis": "Boana pardalis",
    "Hypsiboas pulchellus": "Boana pulchella",
    "Hypsiboas punctatus": "Boana punctata",
    "Hypsiboas raniceps": "Boana raniceps",
    "Hypsiboas riojanus": "Boana riojana",
    "Hypsiboas rosenbergi": "Boana rosenbergi",
    "Dryobates villosus": "Leuconotopicus villosus",
    "Dryobates borealis": "Leuconotopicus borealis",
    "Dryobates albolarvatus": "Leuconotopicus albolarvatus",
    "Dryobates arizonae": "Leuconotopicus arizonae",
    "Dryobates stricklandi": "Leuconotopicus stricklandi",
    "Dryobates fumigatus": "Leuconotopicus fumigatus",
    "Spermophilus beecheyi": "Otospermophilus beecheyi",
    "Spermophilus variegatus": "Otospermophilus variegatus",
    "Spermophilus beldingi": "Urocitellus beldingi",
    "Spermophilus columbianus": "Urocitellus columbianus",
    "Spermophilus parryii": "Urocitellus parryii",
    "Spermophilus richardsonii": "Urocitellus richardsonii",
    "Spermophilus armatus": "Urocitellus armatus",
    "Callicebus donacophilus": "Plecturocebus donacophilus",
    "Callicebus moloch": "Plecturocebus moloch",
    "Cebus apella": "Sapajus apella",
    "Cebus nigritus": "Sapajus nigritus",
    "Lagothrix lagotricha": "Lagothrix lagothricha",
    "Galago demidoff": "Galagoides demidoff",
    "Bunopithecus hoolock": "Hoolock hoolock",
    "Pteropus giganteus": "Pteropus medius",
    "Physeter catodon": "Physeter macrocephalus",
    "Coccothraustes vespertinus": "Hesperiphona vespertina",
    "Coccothraustes abeillei": "Hesperiphona abeillei",
    "Anthropoides virgo": "Grus virgo",
    "Hyliola regilla": "Pseudacris regilla",
    "Homo Sapiens": "Homo sapiens",
    "Canis lupus (Domestic type)": "Canis familiaris",
};

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
        out[key] = value;
    }
    return out;
}

function normalizeSci(name) {
    return (name || '').replace(/\(.*?\)/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseLabelLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return null;
    const sep = trimmed.indexOf('_');
    if (sep <= 0) return null;
    const scientificName = trimmed.slice(0, sep).trim();
    const commonName = trimmed.slice(sep + 1).trim();
    if (!scientificName || !commonName) return null;
    return { scientificName, commonName };
}

/** Minimal RFC 4180 CSV parser (quoted fields may contain commas, quotes, newlines). */
export function parseCsv(text) {
    const rows = []; let row = []; let f = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(f); f = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(f); f = ''; if (row.length > 1 || row[0]) rows.push(row); row = [];
        } else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows;
}

/** V3 labels CSV -> [{ s, birdnet_id, taxon_group, names: { lang: name } }]. */
export function parseV3Labels(text) {
    const [header, ...rows] = parseCsv(text);
    const col = (n) => { const i = header.indexOf(n); if (i < 0) throw new Error(`V3 labels: no column ${n}`); return i; };
    const iSci = col('scientific_name'), iId = col('birdnet_id'), iGrp = col('taxon_group'), iCom = col('common_name');
    const nameCols = header.map((h, i) => [h, i]).filter(([h]) => h.startsWith('common_name_'));
    return rows.map((r) => {
        const names = {};
        for (const [h, i] of nameCols) if (r[i]) names[h.slice('common_name_'.length)] = r[i];
        if (!names.en && r[iCom]) names.en = r[iCom];
        const opt = (n) => { const i = header.indexOf(n); return i >= 0 ? r[i] || '' : ''; };
        return { s: r[iSci], birdnet_id: r[iId], taxon_group: r[iGrp], names, inat_id: opt('inat_id'), ebird_code: opt('ebird_code') };
    });
}

/**
 * Merge name maps into the app's language codes. Later sources win, so pass
 * them from least to most authoritative. Empty values never overwrite.
 */
export function mergeNames(...sources) {
    const out = {};
    for (const src of sources) {
        for (const [lang, v] of Object.entries(src || {})) {
            if (!v || SKIP_LANGS.has(lang)) continue;
            out[LANG_ALIASES[lang] || lang] = v;
        }
    }
    // zh-CN only fills zh when no plain zh name exists.
    for (const src of sources) if (src?.['zh-CN'] && !out.zh) out.zh = src['zh-CN'];
    return out;
}

async function downloadFile(url, dest) {
    if (fs.existsSync(dest)) return;
    console.log(`Downloading ${url} to ${dest} ...`);
    const res = await fetch(url, { headers: { 'User-Agent': 'signavis-taxonomy-build/1.0' } });
    if (!res.ok) throw new Error(`Failed to download ${url}: ${res.statusText}`);
    const fileStream = fs.createWriteStream(dest);
    await finished(Readable.fromWeb(res.body).pipe(fileStream));
}

async function downloadAndResizeImage(url, dest) {
    if (fs.existsSync(dest)) return true;
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'BirdNET-Live-Builder/1.0' } });
        if (!res.ok) return false;
        const buffer = await res.arrayBuffer();
        await sharp(Buffer.from(buffer))
            .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover' })
            .webp({ quality: WEBP_QUALITY })
            .toFile(dest);
        return true;
    } catch (e) {
        console.warn(`Failed to process image ${url}: ${e.message}`);
        return false;
    }
}

function buildTaxonomyFromDir(labelsDir) {
    const entries = fs.readdirSync(labelsDir, { withFileTypes: true });
    const files = entries
        .filter((e) => e.isFile() && /^BirdNET_GLOBAL_6K_.*_Labels_.*\.txt$/i.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));

    const byScientific = new Map();
    const languages = [];

    for (const fileName of files) {
        const m = fileName.match(/_Labels_(.+)\.txt$/i);
        if (!m) continue;
        const lang = m[1];
        languages.push(lang);

        const content = fs.readFileSync(path.join(labelsDir, fileName), 'utf8');
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            const parsed = parseLabelLine(line);
            if (!parsed) continue;
            const row = byScientific.get(parsed.scientificName) || {};
            row[lang] = parsed.commonName;
            byScientific.set(parsed.scientificName, row);
        }
    }

    return {
        languages: [...new Set(languages)].sort((a, b) => a.localeCompare(b)),
        byScientific,
    };
}

/**
 * Build the taxonomy records. Pure (no I/O) so it can be tested.
 *  - V3 12K classes are the base (x unset).
 *  - V2.4-only species stay labelable (legacy model, older label files), x: 1.
 *  - Every other Cornell species is available for manual labeling, x: 1.
 * Names: V2.4 label files < Cornell taxonomy < V3 labels CSV.
 * `a`: alternative scientific names (synonyms, V2.4 spelling) for lookup.
 */
export function buildRecords({ v3, v24 = new Map(), cornell = [] }) {
    const cornellBySci = new Map();
    const cornellByNorm = new Map();
    for (const e of cornell) {
        cornellBySci.set(e.scientific_name, e);
        for (const n of [e.scientific_name, ...(e.scientific_name_aliases || [])]) {
            const k = normalizeSci(n);
            if (k && !cornellByNorm.has(k)) cornellByNorm.set(k, e);
        }
    }
    const findCornell = (sci) => cornellBySci.get(sci)
        || cornellBySci.get(CURATED_LABEL_ALIASES[sci])
        || cornellByNorm.get(normalizeSci(sci))
        || cornellByNorm.get(normalizeSci(CURATED_LABEL_ALIASES[sci]))
        || null;

    // V2.4 names keyed by the Cornell/V3 name they map to.
    const v24ByKey = new Map();
    for (const [sci, names] of v24) {
        const c = findCornell(sci);
        v24ByKey.set(normalizeSci(c?.scientific_name || CURATED_LABEL_ALIASES[sci] || sci), { sci, names });
    }

    // External IDs: eBird code, iNaturalist taxon id, Xeno-canto name (only if it differs).
    const addIds = (rec, row, c) => {
        const ebird = row?.ebird_code || c?.ebird_code;
        const inat = Number(row?.inat_id || c?.inat_id) || 0;
        if (ebird) rec.ebird = ebird;
        if (inat) rec.inat = inat;
        if (c?.xc_name && c.xc_name !== rec.s) rec.xc = c.xc_name;
    };

    const records = [];
    const used = new Set();
    const usedCornell = new Set();
    const addAliases = (rec, c, legacySci) => {
        const a = new Set([...(c?.scientific_name_aliases || [])]);
        if (c && c.scientific_name !== rec.s) a.add(c.scientific_name);
        if (legacySci && legacySci !== rec.s) a.add(legacySci);
        a.delete(rec.s);
        if (a.size) rec.a = [...a].sort();
    };

    for (const row of v3) {
        if (!row.s || used.has(normalizeSci(row.s))) continue;
        const c = findCornell(row.s);
        const legacy = v24ByKey.get(normalizeSci(row.s)) || (c && v24ByKey.get(normalizeSci(c.scientific_name)));
        const rec = { s: row.s, n: mergeNames(legacy?.names, c?.common_names, row.names) };
        rec.birdnet_id = row.birdnet_id || c?.birdnet_id;
        rec.taxon_group = row.taxon_group || c?.taxon_group;
        addAliases(rec, c, legacy?.sci);
        addIds(rec, row, c);
        if (legacy) legacy.taken = true;
        if (c) usedCornell.add(c);
        used.add(normalizeSci(row.s));
        records.push(rec);
    }
    const modelCount = records.length;

    for (const legacy of v24ByKey.values()) {
        if (legacy.taken) continue;
        const c = findCornell(legacy.sci);
        if (c && usedCornell.has(c)) continue;
        const sci = c?.scientific_name || legacy.sci;
        if (used.has(normalizeSci(sci))) continue;
        const rec = { s: sci, n: mergeNames(legacy.names, c?.common_names), x: 1 };
        if (c?.birdnet_id) rec.birdnet_id = c.birdnet_id;
        if (c?.taxon_group) rec.taxon_group = c.taxon_group;
        addAliases(rec, c, legacy.sci);
        addIds(rec, null, c);
        if (c) usedCornell.add(c);
        used.add(normalizeSci(sci));
        records.push(rec);
    }

    for (const c of cornell) {
        if (c.record_type !== 'species' || usedCornell.has(c) || used.has(normalizeSci(c.scientific_name))) continue;
        const rec = { s: c.scientific_name, n: mergeNames(c.common_names), x: 1 };
        if (!rec.n.en_uk) rec.n.en_uk = c.common_name || c.scientific_name;
        if (c.birdnet_id) rec.birdnet_id = c.birdnet_id;
        if (c.taxon_group) rec.taxon_group = c.taxon_group;
        addAliases(rec, c);
        addIds(rec, null, c);
        used.add(normalizeSci(c.scientific_name));
        records.push(rec);
    }

    records.sort((a, b) => a.s.localeCompare(b.s));
    return { records, modelCount, extraCount: records.length - modelCount, findCornell };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const outputFile = args.output;
    const v24Dir = args['v24-labels'];
    const skipImages = args['skip-images'] === 'true';
    if (!outputFile) {
        console.error('Usage: node scripts/build-birdnet-taxonomy.js --output <json-file> [--v3-labels <csv>] [--v24-labels <labels-dir>] [--skip-images]');
        process.exit(1);
    }

    const dataDir = path.dirname(outputFile);
    const cornellCache = path.join(dataDir, 'cornell-taxonomy.json');
    const imageDir = path.join(dataDir, 'species_images');
    const v3Labels = args['v3-labels'] || path.join(dataDir, V3_LABELS_FILE);
    fs.mkdirSync(imageDir, { recursive: true });

    await downloadFile(CORNELL_TAXONOMY_URL, cornellCache);
    await downloadFile(V3_LABELS_URL, v3Labels);

    const cornell = JSON.parse(fs.readFileSync(cornellCache, 'utf8'));
    const v3 = parseV3Labels(fs.readFileSync(v3Labels, 'utf8'));
    const v24 = v24Dir && fs.existsSync(v24Dir) ? buildTaxonomyFromDir(v24Dir).byScientific : new Map();
    if (!v24.size) console.warn('No V2.4 label files: building without V2.4-only species and names.');

    const { records, modelCount, extraCount, findCornell } = buildRecords({ v3, v24, cornell });

    // Images for the model's classes (as before: not for x: 1 extras).
    let imageCount = 0;
    if (!skipImages) {
        for (const rec of records) {
            if (rec.x) continue;
            const c = findCornell(rec.s);
            const imageUrl = c?.image?.medium || c?.image?.thumb;
            if (!imageUrl) continue;
            const ok = await downloadAndResizeImage(imageUrl, path.join(imageDir, `${rec.s}.webp`));
            if (!ok) continue;
            rec.img = true;
            rec.img_author = c.image_author;
            rec.img_license = c.image_license;
            imageCount++;
        }
    }

    // Offer the languages of the BirdNET label sets; Cornell knows many more
    // (often only a handful of names each), which would bloat the file.
    const languages = [...new Set([
        ...Object.keys(mergeNames(Object.fromEntries(v3.flatMap((r) => Object.keys(r.names)).map((l) => [l, 'x'])))),
        ...(v24.size ? [...v24.values()].flatMap((n) => Object.keys(n)) : []),
    ])].sort((a, b) => a.localeCompare(b));
    const keep = new Set(languages);
    for (const rec of records) {
        for (const l of Object.keys(rec.n)) if (!keep.has(l)) delete rec.n[l];
        // Store only names that differ from English; the resolver falls back to en_uk.
        for (const l of Object.keys(rec.n)) if (l !== 'en_uk' && rec.n[l] === rec.n.en_uk) delete rec.n[l];
    }

    const payload = {
        modelVersion: V3_MODEL_VERSION,
        sourceUrl: `https://zenodo.org/records/${V3_RECORD}`,
        sources: ['BirdNET+ V3.0 Global 12K labels', 'BirdNET taxonomy (birdnet.cornell.edu)', ...(v24.size ? ['BirdNET V2.4 labels'] : [])],
        updatedAt: new Date().toISOString(),
        languages,
        speciesCount: modelCount,
        extraCount,
        records,
    };
    fs.writeFileSync(outputFile, JSON.stringify(payload), 'utf8');
    console.log(`Wrote ${modelCount} model classes + ${extraCount} extra species (${languages.length} languages) to ${outputFile}`);
    console.log(`Processed ${imageCount} images into ${imageDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
