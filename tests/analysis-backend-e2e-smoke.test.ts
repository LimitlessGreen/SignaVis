import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

import { HttpAnalysisBackend } from '../src/infrastructure/analysis/HttpAnalysisBackend.ts';

async function waitForServerReady(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/analysis/species`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Mock server did not become ready within ${timeoutMs}ms`);
}

// A free port: a fixed one collides with parallel runs, and then the mock exits at once
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

test('HttpAnalysisBackend works against live mock analysis server', async () => {
  const port = await freePort();
  const host = '127.0.0.1';
  const baseUrl = `http://${host}:${port}`;

  const server = spawn(process.execPath, ['./scripts/mock-analysis-server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANALYSIS_MOCK_HOST: host,
      ANALYSIS_MOCK_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServerReady(baseUrl);

    const backend = new HttpAnalysisBackend({ mode: 'server', endpoint: baseUrl });

    const loadResult = await backend.load({ modelUrl: '../models/birdnet-v2.4/' });
    assert.equal(loadResult.labelCount, 6522);
    assert.equal(loadResult.hasAreaModel, true);

    const locationResult = await backend.setLocation(48.14, 11.58, { date: '2026-05-07' });
    assert.equal(locationResult.ok, true);
    assert.equal(locationResult.week, 22);

    const species = await backend.getAllSpecies();
    assert.ok(species.length >= 2);
    assert.equal(species[0].scientific, 'Corvus corax');

    const detections = await backend.analyze(
      new Float32Array([0.1, 0.2, -0.1]),
      { minConfidence: 0.42, overlap: 1, sampleRate: 48000 },
    );

    assert.ok(detections.length >= 2);
    assert.equal(detections[0].scientific, 'Corvus corax');
    assert.ok(Number(detections[0].confidence) >= 0.42);

    await backend.clearLocation();
  } finally {
    // Only wait while it still runs: an 'exit' already emitted would never fire again
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill('SIGTERM');
      await exited;
    }

    if (stderr.trim()) {
      // Keep stderr surfaced in assertions if the test fails later.
      assert.ok(true, stderr);
    }
  }
});
