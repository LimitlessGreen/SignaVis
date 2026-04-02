#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

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

    const records = [...byScientific.entries()]
        .map(([scientificName, names]) => ({ s: scientificName, n: names }))
        .sort((a, b) => a.s.localeCompare(b.s));

    return {
        languages: [...new Set(languages)].sort((a, b) => a.localeCompare(b)),
        records,
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const sourceDir = args.source;
    const outputFile = args.output;
    const modelVersion = args.model || 'V2.4';
    const sourceUrl = args['source-url'] || 'https://github.com/birdnet-team/BirdNET-Analyzer';

    if (!sourceDir || !outputFile) {
        console.error('Usage: node scripts/build-birdnet-taxonomy.js --source <labels-dir> --output <json-file> [--model V2.4] [--source-url <url>]');
        process.exit(1);
    }
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        console.error(`Source directory not found: ${sourceDir}`);
        process.exit(1);
    }

    const built = buildTaxonomyFromDir(sourceDir);
    const payload = {
        modelVersion,
        sourceUrl,
        updatedAt: new Date().toISOString(),
        languages: built.languages,
        speciesCount: built.records.length,
        records: built.records,
    };

    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${payload.speciesCount} species (${payload.languages.length} languages) to ${outputFile}`);
}

main();
