#!/usr/bin/env node
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(ROOT, "githooks");

async function main() {
  await fs.mkdir(HOOKS_DIR, { recursive: true });

  const prePushPath = path.join(HOOKS_DIR, "pre-push");
  const prePush = `#!/usr/bin/env node
import { spawn } from 'child_process';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: true });
    p.on('close', (code) => (code === 0 ? resolve() : reject(code)));
  });
}

(async () => {
  try {
    await run('npm', ['run', 'typecheck']);
    await run('npm', ['test']);
    process.exit(0);
  } catch (code) {
    process.exit(code || 1);
  }
})();\n`;

  await fs.writeFile(prePushPath, prePush, "utf8");
  try {
    await fs.chmod(prePushPath, 0o755);
  } catch (err) {
    // ignore on Windows
  }

  try {
    execSync(`git config core.hooksPath ${path.relative(ROOT, HOOKS_DIR)}`, { cwd: ROOT });
    console.log('Set git core.hooksPath to githooks/');
  } catch (err) {
    console.warn('Could not set git core.hooksPath automatically (git not available or failed). Run `git config core.hooksPath githooks` manually.');
  }

  console.log('Installed githooks/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
