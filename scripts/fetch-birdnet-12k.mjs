#!/usr/bin/env node
/**
 * Download BirdNET+ V3.0 Global 12K (full model, 11,725 classes) into
 * models/birdnet-v3.0-12k/ and write a model_config.json in the BirdNET Live
 * layout, so SignaVis can load it like the bundled 10K model.
 *
 * The files are not committed (git-ignored): the audio model is 173 MB, and
 * Zenodo / GitHub releases send no CORS headers, so browsers cannot load them
 * from there directly.
 *
 * Sources: https://github.com/birdnet-team/birdnet-V3.0-dev
 *   audio model + labels: Zenodo record 24162518 (Apache-2.0)
 *   geo model:            github.com/birdnet-team/geomodel release v3.0.4
 *
 * Usage: node scripts/fetch-birdnet-12k.mjs [--pruned]
 *   --pruned  72 MB model with one of three classifier heads (mobile/edge build)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'models', 'birdnet-v3.0-12k');
const pruned = process.argv.includes('--pruned');

const RECORD = '24162518';
const NAME = 'BirdNET+_V3.0_Global_12K';
const AUDIO_FILE = `${NAME}_FP16${pruned ? '_pruned' : ''}.onnx`;
const LABELS_SRC = `${NAME}_Labels.csv`;
const LABELS_FILE = `${NAME}_Labels_compact.csv`;
const GEO = 'BirdNET+_Geomodel_V3.0.4_Global_14K';
const GEO_FILE = `${GEO}_FP16.onnx`;
const GEO_LABELS = `${GEO}_Labels.txt`;
const GEO_URL = (f) => `https://github.com/birdnet-team/geomodel/releases/download/v3.0.4/${f.replace('+', '%2B')}`;

// Zenodo rejects requests with Node's default user agent.
const HEADERS = { 'user-agent': 'signavis-model-fetch/1.0', accept: '*/*' };

async function download(url, dest, md5) {
  if (existsSync(dest) && (!md5 || createHash('md5').update(readFileSync(dest)).digest('hex') === md5)) {
    console.log(`✓ ${dest.split('/').pop()} (cached)`);
    return;
  }
  console.log(`↓ ${url}`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (md5 && createHash('md5').update(buf).digest('hex') !== md5) throw new Error(`${dest}: checksum mismatch`);
  writeFileSync(dest + '.part', buf);
  renameSync(dest + '.part', dest);
}

/** Minimal RFC 4180 CSV parser (quoted fields may contain commas, quotes, newlines). */
function parseCsv(text) {
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

mkdirSync(out, { recursive: true });
const recRes = await fetch(`https://zenodo.org/api/records/${RECORD}`, { headers: { ...HEADERS, accept: 'application/json' } });
if (!recRes.ok) throw new Error(`Zenodo record ${RECORD}: HTTP ${recRes.status}`);
const record = await recRes.json();
const md5Of = (key) => record.files.find((f) => f.key === key)?.checksum?.replace(/^md5:/, '');
const zenodo = (f) => `https://zenodo.org/records/${RECORD}/files/${f}?download=1`;

await download(zenodo(AUDIO_FILE), resolve(out, AUDIO_FILE), md5Of(AUDIO_FILE));
await download(zenodo(LABELS_SRC), resolve(out, LABELS_SRC), md5Of(LABELS_SRC));
await download(zenodo('MODEL_LICENSE.md'), resolve(out, 'MODEL_LICENSE.md'), md5Of('MODEL_LICENSE.md')).catch(() => {});
await download(GEO_URL(GEO_FILE), resolve(out, GEO_FILE));
await download(GEO_URL(GEO_LABELS), resolve(out, GEO_LABELS));

// Compact labels (same columns/delimiter as the BirdNET Live 10K build).
const [header, ...rows] = parseCsv(readFileSync(resolve(out, LABELS_SRC), 'utf8'));
const col = (n) => { const i = header.indexOf(n); if (i < 0) throw new Error(`labels: no column ${n}`); return i; };
const [iIx, iId, iSci, iCom, iGrp] = ['ix', 'birdnet_id', 'scientific_name', 'common_name', 'taxon_group'].map(col);
const clean = (s) => s.replace(/[;\r\n]/g, ' ');
writeFileSync(resolve(out, LABELS_FILE), ['idx;birdnet_id;sci_name;com_name;class',
  ...rows.map((r) => [r[iIx], r[iId], clean(r[iSci]), clean(r[iCom]), r[iGrp]].join(';'))].join('\n') + '\n');
const soundClasses = rows.filter((r) => /^BN9/.test(r[iId])).length;
const geoCount = readFileSync(resolve(out, GEO_LABELS), 'utf8').trim().split('\n').length;

const config = {
  audioModel: {
    name: `BirdNET+ V3.0 Global 12K FP16${pruned ? ' pruned' : ''}`,
    version: '3.0',
    description: 'Full global classifier (birds, insects, amphibians, mammals, fishes, reptiles) plus non-animal sound classes.',
    speciesCount: rows.length - soundClasses,
    audio: { sampleRate: 32000, channels: 1 },
    onnx: { modelFile: AUDIO_FILE, inputName: 'input', outputNames: { predictions: 'predictions', embeddings: 'embeddings_out' } },
    labels: {
      file: LABELS_FILE, delimiter: ';', hasHeader: true,
      columns: { index: 'idx', birdnetId: 'birdnet_id', scientificName: 'sci_name', commonName: 'com_name', className: 'class' },
    },
    inference: { supportedWindowSeconds: [3], defaultWindowSeconds: 3, defaultConfidenceThreshold: 0.35 },
    soundClassCount: soundClasses,
    classCount: rows.length,
  },
  geoModel: {
    name: 'BirdNET+ Geomodel V3.0.4 Global 14K FP16',
    version: '3.0.4',
    modelFile: GEO_FILE,
    labelsFile: GEO_LABELS,
    inputName: 'input',
    outputName: 'probabilities',
    speciesCount: geoCount,
    defaultThreshold: 0.03,
  },
};
writeFileSync(resolve(out, 'model_config.json'), JSON.stringify(config, null, 2) + '\n');
console.log(`✓ ${out}: ${rows.length} classes (${soundClasses} sound classes), geo ${geoCount} species`);
