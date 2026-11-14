#!/usr/bin/env node
/**
 * Microsoft Store screenshots of SignaVis Lite (Windows).
 *
 * Starts the built Lite binary with WebView2 remote debugging and a fresh,
 * throw-away WebView2 profile (your own projects stay untouched), renders
 * each scene of scripts/lite-store-scenes.mjs at a fixed size and writes PNGs.
 *
 *   node scripts/lite-store-screenshots.mjs [signavis-lite.exe] [--out=dir]
 *        [--size=1920x1080] [--only=name,name] [--keep-profile]
 *
 * Default exe: <cargo target>/release/signavis-lite.exe; default out: store-assets/screenshots.
 * Uses the Xeno-canto API key from XC_API_KEY or ~/.signavis-xc-key (only inside that profile).
 * The Store needs PNG, at least 1366x768; 1920x1080 or larger is recommended.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HELPERS, PREPARE, SCENES } from './lite-store-scenes.mjs';

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
function defaultExe() {
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: 'src-tauri-lite' }).toString());
  return resolve(meta.target_directory, 'release', 'signavis-lite.exe');
}
const exe = resolve(args.find((a) => !a.startsWith('--')) ?? defaultExe());
const outDir = resolve(opt('out') ?? 'store-assets/screenshots');
const [width, height] = (opt('size') ?? '1920x1080').split('x').map(Number);
const only = opt('only')?.split(',');
const PORT = 9334;

mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'signavis-lite-shots-'));
const child = spawn(exe, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    SIGNAVIS_LITE_DATA_DIR: profile,
  },
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('about:'));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('WebView2 debugging endpoint did not come up');
}

let failed = false;
try {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg); pending.delete(msg.id); }
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(2000);
  await evaluate(PREPARE);
  // Xeno-canto API key (env XC_API_KEY or ~/.signavis-xc-key): the XC labels load and no
  // "no API key" dialog covers the screenshot. It only lives in the throw-away profile.
  const keyFile = join(homedir(), '.signavis-xc-key');
  const xcKey = process.env.XC_API_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');
  if (xcKey) await evaluate(`localStorage.setItem('signavis.xc-api-key.v1', ${JSON.stringify(xcKey)});`);
  else console.warn('no XC API key — screenshots will show the "no API key" dialog');

  for (const scene of SCENES) {
    if (only && !only.includes(scene.name)) continue;
    process.stdout.write(`${scene.name}… `);
    try {
      if (scene.url) {
        await send('Page.navigate', { url: new URL(scene.url, page.url).href });
        await sleep(1500);
      }
      // Helpers available to every scene script.
      await evaluate(`
        window.__shot = {
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          async waitFor(fn, ms = 60000) {
            const t0 = Date.now();
            while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch {} await this.sleep(250); }
            throw new Error('timeout waiting for ' + fn);
          },
          click(sel) { const el = document.querySelector(sel); if (!el) throw new Error('no ' + sel); el.click(); return el; },
        };
        { const S = window.__shot; ${HELPERS} }`);
      if (scene.setup) await evaluate(`const S = window.__shot; ${scene.setup}`);
      await sleep(scene.settle ?? 1500);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const file = join(outDir, `${scene.name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(file);
    } catch (e) {
      failed = true;
      console.log(`FAILED: ${e.message}`);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, `${scene.name}.FAILED.png`), Buffer.from(data, 'base64'));
    }
  }
  ws.close();
} catch (err) {
  failed = true;
  console.error(`screenshots: ${err.message}`);
} finally {
  child.kill();
  if (!args.includes('--keep-profile')) {
    await sleep(1000);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* WebView2 may still hold files */ }
  }
}
process.exit(failed ? 1 : 0);
