import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = resolve(__dirname, '../..');
const DEFAULT_PORT = Number(process.env.PLATFORM_LOCAL_PORT || 8791);

function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}
let nextTestPort = DEFAULT_PORT;

function startLocalEnv() {
  const port = nextTestPort++;
  const child = spawn(process.execPath, [resolve(APP_ROOT, 'platform/local-testenv.mjs'), '--reset'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PLATFORM_LOCAL_PORT: String(port),
    },
    stdio: 'pipe',
  });

  let discoveredPort = port;
  const logs = [];
  child.stdout.on('data', (chunk) => {
    const line = String(chunk);
    logs.push(`[stdout] ${line.trim()}`);
    const match = line.match(/listening on http:\/\/localhost:(\d+)/);
    if (match) {
      discoveredPort = Number(match[1]);
    }
  });

  child.stderr.on('data', (chunk) => {
    logs.push(`[stderr] ${String(chunk).trim()}`);
  });

  return {
    child,
    getPort: () => discoveredPort,
    getLogs: () => logs.slice(-20),
  };
}

async function waitForHealth(env, timeoutMs = 10_000) {
  const started = Date.now();
  let lastStatus = null;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (env.child.exitCode !== null) {
      throw new Error(`local testenv exited early with code ${env.child.exitCode}; logs=${env.getLogs().join(' | ')}`);
    }

    try {
      const res = await fetch(`${baseUrl(env.getPort())}/health`);
      if (res.ok) {
        return;
      }
      lastStatus = res.status;
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(200);
  }
  const details = [
    `port ${env.getPort()}`,
    lastStatus !== null ? `lastStatus=${lastStatus}` : null,
    lastError ? `lastError=${lastError}` : null,
    `logs=${env.getLogs().join(' | ')}`,
  ].filter(Boolean).join('; ');
  throw new Error(`local testenv did not become healthy in time (${details})`);
}

async function stopLocalEnv(child) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');
  try {
    await Promise.race([
      once(child, 'exit'),
      delay(1500),
    ]);
  } catch {}

  if (child.exitCode === null) {
    child.kill('SIGKILL');
    try {
      await Promise.race([
        once(child, 'exit'),
        delay(1500),
      ]);
    } catch {}
  }
}

async function jsonFetch(path, options = {}) {
  const { base, ...fetchOptions } = options;
  const res = await fetch(`${base}${path}`, {
    ...fetchOptions,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let payload = null;
  const text = await res.text();
  if (text) {
    payload = JSON.parse(text);
  }

  return { res, payload };
}

async function pollJobDone(base, projectId, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { res, payload } = await jsonFetch(`/api/v1/jobs?projectId=${encodeURIComponent(projectId)}`, {
      base,
    });
    assert.equal(res.status, 200);
    const latest = payload.jobs[0];
    if (latest?.status === 'done') {
      return latest;
    }
    await delay(250);
  }
  throw new Error('job did not reach done status in time');
}

test('vertical slice local env: project -> asset -> analysis -> job status', async (t) => {
  const env = startLocalEnv();
  const child = env.child;
  const base = baseUrl(env.getPort());
  t.after(async () => {
    await stopLocalEnv(child);
  });

  await waitForHealth(env);

  const createProject = await jsonFetch('/api/v1/projects', {
    base,
    method: 'POST',
    body: JSON.stringify({
      teamId: '10000000-0000-0000-0000-000000000001',
      name: 'VS Test Project',
      createdBy: '00000000-0000-0000-0000-000000000001',
    }),
  });
  assert.equal(createProject.res.status, 201);
  assert.ok(createProject.payload.id);
  const projectId = createProject.payload.id;

  const importAsset = await jsonFetch(`/api/v1/projects/${projectId}/assets`, {
    base,
    method: 'POST',
    body: JSON.stringify({
      sourceType: 'local',
      sourceRef: '/tmp/test.wav',
      importedBy: '00000000-0000-0000-0000-000000000001',
    }),
  });
  assert.equal(importAsset.res.status, 201);
  assert.ok(importAsset.payload.id);
  const assetId = importAsset.payload.id;

  // Fehlerfall: Analyze vor Model-Load muss scheitern.
  const analyzeBeforeLoad = await jsonFetch('/analysis/analyze', {
    base,
    method: 'POST',
    body: JSON.stringify({
      samples: [0, 0.1, 0.2],
      options: { minConfidence: 0.25 },
    }),
  });
  assert.equal(analyzeBeforeLoad.res.status, 412);

  const loadModel = await jsonFetch('/analysis/load', {
    base,
    method: 'POST',
    body: JSON.stringify({ modelUrl: '/models/birdnet-v2.4/model.json' }),
  });
  assert.equal(loadModel.res.status, 200);
  assert.equal(typeof loadModel.payload.labelCount, 'number');

  const analyzeAfterLoad = await jsonFetch('/analysis/analyze', {
    base,
    method: 'POST',
    body: JSON.stringify({
      samples: [0, 0.1, 0.2, 0.3],
      options: { minConfidence: 0.3, sampleRate: 48000 },
    }),
  });
  assert.equal(analyzeAfterLoad.res.status, 200);
  assert.ok(Array.isArray(analyzeAfterLoad.payload));
  assert.ok(analyzeAfterLoad.payload.length > 0);

  const createJob = await jsonFetch('/api/v1/jobs', {
    base,
    method: 'POST',
    body: JSON.stringify({
      projectId,
      assetId,
      type: 'analysis',
      backend: 'local',
      createdBy: '00000000-0000-0000-0000-000000000001',
      payload: { model: 'birdnet-v2.4' },
    }),
  });
  assert.equal(createJob.res.status, 201);
  assert.equal(createJob.payload.status, 'queued');

  const doneJob = await pollJobDone(base, projectId);
  assert.equal(doneJob.projectId, projectId);
  assert.equal(doneJob.assetId, assetId);
  assert.equal(doneJob.status, 'done');
});

test('vertical slice local env: analyze without model returns 412', async () => {
  const env = startLocalEnv();
  const child = env.child;

  await waitForHealth(env);
  const base = baseUrl(env.getPort());

  try {
    const { res, payload } = await jsonFetch('/analysis/analyze', {
      base,
      method: 'POST',
      body: JSON.stringify({
        audioPath: '/tmp/not-used.wav',
        options: { minConfidence: 0.2 },
      }),
    });

    assert.equal(res.status, 412);
    assert.equal(payload.message, 'analysis model not loaded');
  } finally {
    await stopLocalEnv(child);
  }
});
