#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import sharp from 'sharp';

const CORNELL_TAXONOMY_URL = 'https://birdnet.cornell.edu/taxonomy/api/download/json';
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

async function downloadFile(url, dest) {
    if (fs.existsSync(dest)) return;
    console.log(`Downloading ${url} to ${dest} ...`);
    const res = await fetch(url);
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const sourceDir = args.source;
    const outputFile = args.output;
    const modelVersion = args.model || 'V2.4';
    const sourceUrl = args['source-url'] || 'https://github.com/birdnet-team/BirdNET-Analyzer';
    const skipImages = args['skip-images'] === 'true';

    if (!sourceDir || !outputFile) {
        console.error('Usage: node scripts/build-birdnet-taxonomy.js --source <labels-dir> --output <json-file> [--model V2.4] [--source-url <url>]');
        process.exit(1);
    }

    const dataDir = path.join(path.dirname(outputFile), '..', 'data');
    const cornellCache = path.join(dataDir, 'cornell-taxonomy.json');
    const imageDir = path.join(path.dirname(outputFile), 'species_images');

    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(imageDir, { recursive: true });

    await downloadFile(CORNELL_TAXONOMY_URL, cornellCache);

    console.log(`Loading Cornell taxonomy from ${cornellCache} ...`);
    const cornellRaw = JSON.parse(fs.readFileSync(cornellCache, 'utf8'));
    const cornellBySci = new Map(cornellRaw.map(e => [e.scientific_name, e]));
    const cornellByNorm = new Map();
    for (const e of cornellRaw) {
        const norm = normalizeSci(e.scientific_name);
        if (norm && !cornellByNorm.has(norm)) cornellByNorm.set(norm, e);
    }

    const built = buildTaxonomyFromDir(sourceDir);
    const records = [];
    let imageCount = 0;

    console.log(`Processing ${built.byScientific.size} species ...`);

    for (const [sciName, names] of [...built.byScientific.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        let entry = cornellBySci.get(sciName);
        if (!entry) {
            const alias = CURATED_LABEL_ALIASES[sciName];
            if (alias) entry = cornellBySci.get(alias);
        }
        if (!entry) {
            entry = cornellByNorm.get(normalizeSci(sciName));
        }

        const record = { s: sciName, n: names };

        if (entry) {
            record.birdnet_id = entry.birdnet_id;
            record.taxon_group = entry.taxon_group;

            const imageUrl = entry.image?.medium || entry.image?.thumb;
            if (imageUrl && !skipImages) {
                const imgDest = path.join(imageDir, `${sciName}.webp`);
                const ok = await downloadAndResizeImage(imageUrl, imgDest);
                if (ok) {
                    record.img = true;
                    record.img_author = entry.image_author;
                    record.img_license = entry.image_license;
                    imageCount++;
                }
            }
        }

        records.push(record);
    }

    const payload = {
        modelVersion,
        sourceUrl,
        updatedAt: new Date().toISOString(),
        languages: built.languages,
        speciesCount: records.length,
        records,
    };

    fs.writeFileSync(outputFile, JSON.stringify(payload), 'utf8');
    console.log(`Wrote ${payload.speciesCount} species to ${outputFile}`);
    console.log(`Processed ${imageCount} images into ${imageDir}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
