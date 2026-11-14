#!/usr/bin/env node
// Writes latest.json for SignaVis Lite's updater (src-tauri-lite/src/updater.rs)
// from the signed bundles of a release, and gives the files space-free names
// (GitHub would turn "SignaVis Lite_…" into "SignaVis.Lite_…" on upload).
//
//   node scripts/lite-update-manifest.mjs <bundle-dir> <tag>
//
// Without any .sig files (no TAURI_SIGNING_PRIVATE_KEY in CI) it only renames.
import fs from 'node:fs';
import path from 'node:path';

const [dir, tag] = process.argv.slice(2);
if (!dir || !tag) {
  console.error('usage: lite-update-manifest.mjs <bundle-dir> <tag>');
  process.exit(1);
}
const REPO = process.env.GITHUB_REPOSITORY || 'LimitlessGreen/SignaVis';

const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

for (const f of walk(dir)) {
  const base = path.basename(f);
  if (base.includes(' ')) fs.renameSync(f, path.join(path.dirname(f), base.replaceAll(' ', '-')));
}

// Updater platform key → bundle file name pattern.
const TARGETS = [
  ['windows-x86_64', /_x64-setup\.exe$/],
  ['windows-x86_64-nsis', /_x64-setup\.exe$/],
  ['windows-x86_64-msi', /_x64_[^/]*\.msi$/],
  ['darwin-aarch64', /\.app\.tar\.gz$/],
  ['linux-x86_64', /_amd64\.AppImage$/],
];
const files = walk(dir);
const platforms = {};
for (const [key, re] of TARGETS) {
  const bundle = files.find((f) => re.test(path.basename(f)) && fs.existsSync(`${f}.sig`));
  if (!bundle) continue;
  platforms[key] = {
    signature: fs.readFileSync(`${bundle}.sig`, 'utf8').trim(),
    url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(path.basename(bundle))}`,
  };
}
if (!Object.keys(platforms).length) {
  console.log('No signed Lite bundles — no latest.json (updater key not configured).');
  process.exit(0);
}
const manifest = {
  version: tag.replace(/^v/, ''),
  notes: `See https://github.com/${REPO}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`latest.json: ${Object.keys(platforms).join(', ')}`);
