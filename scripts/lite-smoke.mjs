#!/usr/bin/env node
/**
 * Smoke test for SignaVis Lite on Windows: starts the built Lite binary with
 * WebView2 remote debugging, attaches over the DevTools protocol (Node's
 * built-in WebSocket, no dependencies), reloads the page so nothing from the
 * start-up is missed, and reports console errors, uncaught exceptions and CSP
 * violations.
 *
 * Usage: node scripts/lite-smoke.mjs [path/to/signavis-lite.exe] [--wait=15]
 *        [--url=demo/labeling-app.html?xc=XC123]   (navigate there instead of reloading)
 *        [--no-reload]   (only attach; start-up errors before attaching are missed)
 *        [--screenshot=out.png]
 *        [--eval="expression"]   (repeatable; printed after the wait)
 * Exit code 1 if any error was seen.
 */
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
// Default binary: <cargo target dir>/debug — the target dir may be moved (e.g. .cargo/config.toml).
function defaultExe() {
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: 'src-tauri-lite' }).toString());
  return resolve(meta.target_directory, 'debug', 'signavis-lite.exe');
}
const exe = resolve(args.find((a) => !a.startsWith('--')) ?? defaultExe());
const waitSec = Number(args.find((a) => a.startsWith('--wait='))?.slice(7) ?? 15);
const url = args.find((a) => a.startsWith('--url='))?.slice(6);
const shot = args.find((a) => a.startsWith('--screenshot='))?.slice(13);
const evals = args.filter((a) => a.startsWith('--eval=')).map((a) => a.slice(7));
const PORT = 9333;

const child = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
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

const problems = [];
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
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`exception: ${d.exception?.description || d.text} @ ${d.url || ''}:${d.lineNumber}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (msg.method === 'Log.entryAdded' && ['error'].includes(msg.params.entry.level)) {
      problems.push(`log(${msg.params.entry.source}): ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
    }
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  if (url) await send('Page.navigate', { url: new URL(url, page.url).href });
  else if (!args.includes('--no-reload')) await send('Page.reload', { ignoreCache: true });
  await sleep(waitSec * 1000);
  console.log(`page: ${url ? new URL(url, page.url).href : page.url}`);
  for (const expression of evals) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    console.log(`eval ${expression} →`, JSON.stringify(r.result?.value ?? r.exceptionDetails?.text ?? r));
  }
  if (shot) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot, Buffer.from(data, 'base64'));
    console.log(`screenshot: ${shot}`);
  }
  ws.close();
} catch (err) {
  problems.push(`smoke harness: ${err.message}`);
} finally {
  child.kill();
}

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('no errors');
