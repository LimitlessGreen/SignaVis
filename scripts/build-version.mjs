/**
 * Build-time version info, injected into bundles via Vite `define`.
 *
 * - version: contents of VERSION
 * - commit:  short git SHA ('' when git is unavailable)
 * - label:   "X.Y.Z" when HEAD is exactly the release tag vX.Y.Z,
 *            otherwise "X.Y.Z+<sha>" (or "X.Y.Z+dev" without git), so data
 *            produced by an unreleased build is never attributed to a release.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export function getBuildVersion() {
  const version = readFileSync(resolve(ROOT, 'VERSION'), 'utf8').trim();
  const tag = `v${version}`;
  const commit = git('rev-parse', '--short', 'HEAD');
  // In CI, build steps may touch tracked files; only local edits count as dirty.
  const dirty = !process.env.CI && commit !== '' && git('status', '--porcelain', '--untracked-files=no') !== '';
  const onTag =
    process.env.GITHUB_REF === `refs/tags/${tag}` ||
    (commit !== '' && git('tag', '--points-at', 'HEAD').split(/\s+/).includes(tag));
  let label = version;
  if (!onTag || dirty) label = `${version}+${commit || 'dev'}${dirty ? '.dirty' : ''}`;
  return { version, commit, label };
}

/** Vite `define` entries. */
export function versionDefines() {
  const v = getBuildVersion();
  return {
    __SIGNAVIS_VERSION__: JSON.stringify(v.label),
    __SIGNAVIS_COMMIT__: JSON.stringify(v.commit),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(getBuildVersion()));
}
