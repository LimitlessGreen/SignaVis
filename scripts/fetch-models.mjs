#!/usr/bin/env node
/**
 * Fetch the model folders the web app serves under models/. None of them are
 * committed: each one is downloaded from its upstream release, checked by
 * SHA-256 and written into models/<name>/. Pages CI runs this before the demo
 * build, so every model in the picker is deployed.
 *
 *   birdnet-v3.0       BirdNET+ V3.0 Global 10K FP16 BNL + geo model V3.0.4
 *                      (birdnet-team/birdnet-live-app, pinned commit; Apache-2.0)
 *   birdnet-v2.4       BirdNET v2.4 TF.js + meta-data model
 *                      (Zenodo 15050749; CC BY-NC-SA 4.0)
 *   birdbox-just-bird  scripts/birdbox/fetch-model.mjs
 *   birdnet-v3.0-12k   scripts/fetch-birdnet-12k.mjs
 *   anurapam           scripts/fetch-anurapam.sh (needs curl, unzip, uv)
 *
 * Downloads are cached in .cache/models/ by SHA-256, so repeated runs are offline.
 * A folder whose files already match is left alone.
 *
 * Usage: node scripts/fetch-models.mjs [name ...] [--force]
 *   no names: all models; --force: download again, ignore the cache
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache/models');
const HEADERS = { 'user-agent': 'signavis-model-fetch/1.0', accept: '*/*' };  // Zenodo rejects Node's default
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const LIVE_APP = '34390b3b32b7b6cb0bbc2261d79a59d80bb31f11';
const liveRaw = (f) => `https://raw.githubusercontent.com/birdnet-team/birdnet-live-app/${LIVE_APP}/${f.replaceAll('+', '%2B')}`;
const liveLfs = (f) => `https://media.githubusercontent.com/media/birdnet-team/birdnet-live-app/${LIVE_APP}/${f.replaceAll('+', '%2B')}`;
const m = 'assets/models/';

/** Models fetched file by file: target name -> [url, sha256]. */
const FILES = {
  'birdnet-v3.0': {
    'BirdNET+_V3.0_Global_10K_FP16_BNL.onnx': [liveLfs(m + 'BirdNET+_V3.0_Global_10K_FP16_BNL.onnx'), 'dbf8d450703323defeeaa9e7379995e97a146256f6b8bbc2a33b58776ed4bafe'],
    'BirdNET+_V3.0_Global_10K_FP16_BNL_Labels.csv': [liveRaw(m + 'BirdNET+_V3.0_Global_10K_FP16_BNL_Labels.csv'), 'f70a4b31110ffe83e1ed998fd60e29b705627b9d8fbf976d305d378057077701'],
    'BirdNET+_V3.0_Global_10K_FP16_BNL_ScoreBlacklist.json': [liveRaw(m + 'BirdNET+_V3.0_Global_10K_FP16_BNL_ScoreBlacklist.json'), 'f0e0a4500fe8464ed22fc60aa35dd8ea2997faf85c6544b9f4a5d3a03ef7e2c0'],
    'BirdNET+_Geomodel_V3.0.4_Global_10K_FP16_BNL.onnx': [liveLfs(m + 'BirdNET+_Geomodel_V3.0.4_Global_10K_FP16_BNL.onnx'), '7a36319dd5499961f3844dcb2a23559aeb9380563aa9a06bc1bced97c27757ac'],
    'BirdNET+_Geomodel_V3.0.4_Global_10K_FP16_BNL_Labels.txt': [liveRaw(m + 'BirdNET+_Geomodel_V3.0.4_Global_10K_FP16_BNL_Labels.txt'), 'a208abd23c8c3b78f544a8436e442a5f169ec2e001168202b197b21dbdbabb91'],
    'model_config.json': [liveRaw(m + 'model_config.json'), 'fb26fe7838f63d82cb0927d9d946ac0eea0c5362239fb38e88236ee0d6fde9d8'],
    'MODEL_LICENSE': [liveRaw('MODEL_LICENSE'), '09f2cd5bcc79e383308ea57ffc015a7ce11df633ae66c288fa4d6adfab738639'],
  },
};

/** Models extracted from one archive: target file -> [path in archive, sha256]. */
const ARCHIVES = {
  'birdnet-v2.4': {
    url: 'https://zenodo.org/records/15050749/files/BirdNET_v2.4_tfjs.zip?download=1',
    sha256: 'f81af091fe334b15ad3f82766b3340ed768b0a6acd274ab10e8fc32d19410655',
    lf: ['labels.json'],  // shipped with CRLF; stored with LF as before
    files: {
      'model.json': 'cbc10d46bb3c5cac268e55ec3e1314cf520dfc0b15b626025cee941876d5e67a',
      'labels.json': 'eaf062ee269d646f7ac7bc76dd7b1222eb83c4c6f517913a83e3c04e560c0f2b',
      'group1-shard1of13.bin': '62c6e6135f2925785b15c872715df29587471d0d91b8a75f2707754d2d41c41b',
      'group1-shard2of13.bin': '2c7356997fb3c74954adde1648a1e650eefff0ee2f6dceeba0f388f5bfc3b99f',
      'group1-shard3of13.bin': '9405b2e71b22f68536a5e3b04bc593790e4f959e3a88bb815c680f26360beb55',
      'group1-shard4of13.bin': '0c0f88923dac0712e5d0bfee9f50474a344ca6b08e3dfd7ff27e3ef6716d1693',
      'group1-shard5of13.bin': 'f2f7acbf5cb470b9eb00d3de3f871143ac50f6aa3506a7e956bc91b7d91e48a9',
      'group1-shard6of13.bin': '75782b73672c34a31cd111ce6816cab1ab6264e816c4baa15e811bce07bd7fe0',
      'group1-shard7of13.bin': '0539c23ee436acbce0086e2fd40ed74f4f2f4fbdc262da5186e249f8e8b41afe',
      'group1-shard8of13.bin': '7b4d62a8ba75ffa6c4327c8f9a9d06840f71e9bc52817cafe10ecbd57451cd02',
      'group1-shard9of13.bin': '7e4720b896431303e5c6aa53744397a3c8ac3097c34a15d90ebe022d9e607a28',
      'group1-shard10of13.bin': 'cf1dce3898e96c422596d2e0f64490263bc8d6bcb6e14bfb63467200938f195f',
      'group1-shard11of13.bin': '6601c211eb0de4b13773065759867c9e0948b87bdd2652fbff1d32ec8f3d30c5',
      'group1-shard12of13.bin': '539c5bf4e5cad4e050ce06cc0b34f4f43d8f6729797823fe9dc7a8c6e2665511',
      'group1-shard13of13.bin': 'cd39bf5e5520b2b5d52b27d8d19b313d78d6333d829afeb023b7308cb33e52fb',
      'mdata/model.json': '5b356b2da4dbe658c553f70391dc15b57f6bcaa8693543abbec006fca26eb0a1',
      'mdata/group1-shard1of8.bin': '34c757742e89526e95849596ffcaf266da5628682daf450eb50759381bb29d87',
      'mdata/group1-shard2of8.bin': 'd725e6e2aa99be957446d6ada346f902359c4bbc8222c91a9df0d1ad478c2902',
      'mdata/group1-shard3of8.bin': '319af99a0196f7cd332027929bb31baa4c25c42e46bc0667addca90c177ff836',
      'mdata/group1-shard4of8.bin': 'd3f67e8348663faa9d8a5600ae3a30f8581438a3c8d021986bacd256e7ce2407',
      'mdata/group1-shard5of8.bin': '5d7ffaf81c8bf0d8c62c47416515b31398f3df5f5cd41933b1fb3a467c0ef4b7',
      'mdata/group1-shard6of8.bin': 'd0400b12b1709d6b0dc66a95d0203aa58f9825fd890d5237d6bfeba117bcaade',
      'mdata/group1-shard7of8.bin': '1f0cacb5af0b2e0cef4b600589ec718b3077dd81bc49416436b3fa4e7b2704f8',
      'mdata/group1-shard8of8.bin': 'fab4681220f19f2481454ad18b711a96e001e2d50b46fb8cf952dcee02e326cf',
    },
    prefix: 'model/',
  },
};

/** Models with their own fetch script (they convert or split what they download). */
const SCRIPTS = {
  'birdbox-just-bird': ['node', ['scripts/birdbox/fetch-model.mjs']],
  'birdnet-v3.0-12k': ['node', ['scripts/fetch-birdnet-12k.mjs']],
  'anurapam': ['bash', ['scripts/fetch-anurapam.sh']],
};

export const MODELS = [...Object.keys(FILES), ...Object.keys(ARCHIVES), ...Object.keys(SCRIPTS)];
export { FILES, ARCHIVES };

/** Download url, verify its SHA-256 and keep it in the cache. */
async function cached(url, hash, force) {
  const file = join(CACHE, hash);
  if (!force && existsSync(file) && sha256(readFileSync(file)) === hash) return readFileSync(file);
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`  ↓ ${url}`);
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256(buf) !== hash) throw new Error(`SHA-256 ${sha256(buf)}, expected ${hash}`);
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(file + '.part', buf);
      renameSync(file + '.part', file);
      return buf;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${err.message}`);
      console.log(`    failed (${err.message}), retrying`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

const complete = (dir, hashes) => Object.entries(hashes)
  .every(([f, h]) => existsSync(join(dir, f)) && sha256(readFileSync(join(dir, f))) === h);

/** Write all files into a staging folder, then swap it in, so a failed run leaves no half model. */
function publish(dir, files) {
  const stage = `${dir}.part`;
  rmSync(stage, { recursive: true, force: true });
  for (const [f, buf] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, f)), { recursive: true });
    writeFileSync(join(stage, f), buf);
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(stage, dir);
}

async function fetchFiles(name, force) {
  const dir = join(ROOT, 'models', name);
  const hashes = Object.fromEntries(Object.entries(FILES[name]).map(([f, [, h]]) => [f, h]));
  if (!force && complete(dir, hashes)) return console.log(`✓ ${name} (up to date)`);
  const out = {};
  for (const [f, [url, h]] of Object.entries(FILES[name])) out[f] = await cached(url, h, force);
  publish(dir, out);
  console.log(`✓ ${name}`);
}

async function fetchArchive(name, force) {
  const a = ARCHIVES[name];
  const dir = join(ROOT, 'models', name);
  if (!force && complete(dir, a.files)) return console.log(`✓ ${name} (up to date)`);
  const zip = await cached(a.url, a.sha256, force);
  const work = mkdtempSync(join(tmpdir(), 'signavis-models-'));
  try {
    writeFileSync(join(work, 'a.zip'), zip);
    const out = {};
    for (const [f, h] of Object.entries(a.files)) {
      // Read entries straight from the archive: it stores read-only folders that rm cannot clean up.
      let buf = execFileSync('unzip', ['-p', join(work, 'a.zip'), a.prefix + f], { maxBuffer: 256 << 20 });
      if (a.lf?.includes(f)) buf = Buffer.from(buf.toString('utf8').replaceAll('\r\n', '\n'));
      if (sha256(buf) !== h) throw new Error(`${name}/${f}: SHA-256 ${sha256(buf)}, expected ${h}`);
      out[f] = buf;
    }
    publish(dir, out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`✓ ${name}`);
}

function runScript(name, force) {
  const [cmd, args] = SCRIPTS[name];
  // The AnuraPAM conversion takes minutes and is not cached by its script.
  if (name === 'anurapam' && !force && existsSync(join(ROOT, 'models/anurapam/model.json'))) {
    return console.log(`✓ ${name} (present; --force converts it again)`);
  }
  console.log(`→ ${name}: ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, [...args, ...(force && name === 'birdbox-just-bird' ? ['--force'] : [])], { cwd: ROOT, stdio: 'inherit' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const names = args.filter((a) => !a.startsWith('--'));
  const unknown = names.filter((n) => !MODELS.includes(n));
  if (unknown.length) {
    console.error(`unknown model(s): ${unknown.join(', ')}; known: ${MODELS.join(', ')}`);
    process.exit(2);
  }
  for (const name of names.length ? names : MODELS) {
    if (FILES[name]) await fetchFiles(name, force);
    else if (ARCHIVES[name]) await fetchArchive(name, force);
    else runScript(name, force);
  }
}
