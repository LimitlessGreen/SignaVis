import test from 'node:test';
import assert from 'node:assert/strict';

import { createAnalysisBackend } from '../src/infrastructure/analysis/createAnalysisBackend.ts';
import { HttpAnalysisBackend } from '../src/infrastructure/analysis/HttpAnalysisBackend.ts';
import { AnalysisBackendProxy } from '../src/infrastructure/analysis/AnalysisBackendProxy.ts';
import { TauriGrpcAnalysisBackend } from '../src/infrastructure/analysis/TauriGrpcAnalysisBackend.ts';

test('createAnalysisBackend requires endpoint for server/cloud mode', () => {
  assert.throws(() => createAnalysisBackend({ mode: 'server' }), /requires an endpoint/i);
  assert.throws(() => createAnalysisBackend({ mode: 'cloud' }), /requires an endpoint/i);
});

test('createAnalysisBackend can use desktop gRPC for server mode without endpoint', () => {
  const backend = createAnalysisBackend({ mode: 'server', useTauriGrpc: true });
  assert.ok(backend instanceof TauriGrpcAnalysisBackend);
  assert.equal(backend.mode, 'server');
});

test('HttpAnalysisBackend load + location + species + analyze works via mocked fetch', async () => {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const fetchMock = async (url: any, init: any = {}) => {
    const method = String(init?.method || 'GET').toUpperCase();
    const rawBody = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body: rawBody });

    if (String(url).endsWith('/analysis/load') && method === 'POST') {
      return new Response(JSON.stringify({ labelCount: 6522, hasAreaModel: true }), { status: 200 });
    }
    if (String(url).endsWith('/analysis/location') && method === 'POST') {
      return new Response(JSON.stringify({ ok: true, week: 22 }), { status: 200 });
    }
    if (String(url).endsWith('/analysis/species') && method === 'GET') {
      return new Response(JSON.stringify([{ scientific: 'Corvus corax', common: 'Raven', geoscore: 0.8 }]), { status: 200 });
    }
    if (String(url).endsWith('/analysis/analyze') && method === 'POST') {
      return new Response(JSON.stringify([
        { start: 0, end: 3, scientific: 'Corvus corax', common: 'Raven', confidence: 0.92, geoscore: 0.8 },
      ]), { status: 200 });
    }
    if (String(url).endsWith('/analysis/location') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify({ message: 'Unexpected request' }), { status: 500 });
  };

  const backend = new HttpAnalysisBackend({
    mode: 'server',
    endpoint: 'http://localhost:8787/',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });

  const load = await backend.load({ modelUrl: '../models/birdnet-v2.4/' });
  assert.equal(load.labelCount, 6522);
  assert.equal(load.hasAreaModel, true);
  assert.equal(backend.loaded, true);
  assert.equal(backend.hasAreaModel, true);

  const location = await backend.setLocation(52.5, 13.4, { date: '2026-05-07' });
  assert.equal(location.ok, true);
  assert.equal(location.week, 22);

  const species = await backend.getAllSpecies();
  assert.equal(species.length, 1);
  assert.equal(species[0].scientific, 'Corvus corax');

  const detections = await backend.analyze(new Float32Array([0, 0, 0, 0]), {
    sampleRate: 48000,
    overlap: 0.5,
    minConfidence: 0.25,
  });
  assert.equal(detections.length, 1);
  assert.equal(detections[0].common, 'Raven');

  await backend.clearLocation();

  assert.ok(calls.some((c) => c.url.endsWith('/analysis/load') && c.method === 'POST'));
  assert.ok(calls.some((c) => c.url.endsWith('/analysis/location') && c.method === 'POST'));
  assert.ok(calls.some((c) => c.url.endsWith('/analysis/species') && c.method === 'GET'));
  assert.ok(calls.some((c) => c.url.endsWith('/analysis/analyze') && c.method === 'POST'));
  assert.ok(calls.some((c) => c.url.endsWith('/analysis/location') && c.method === 'DELETE'));
});

test('AnalysisBackendProxy switches backend and disposes previous one', async () => {
  const disposed: string[] = [];
  const mkStub = (mode: 'local' | 'server') => ({
    mode,
    loaded: mode === 'local',
    hasAreaModel: mode === 'local',
    load: async () => ({ labelCount: 1, hasAreaModel: mode === 'local' }),
    setLocation: async () => ({ ok: true }),
    getAllSpecies: async () => [],
    clearLocation: async () => {},
    analyze: async () => [],
    dispose: () => { disposed.push(mode); },
  });

  const local = mkStub('local') as any;
  const server = mkStub('server') as any;

  const proxy = new AnalysisBackendProxy(local);
  assert.equal(proxy.mode, 'local');
  assert.equal(proxy.loaded, true);

  proxy.setBackend(server);
  assert.equal(proxy.mode, 'server');
  assert.equal(proxy.loaded, false);
  assert.deepEqual(disposed, ['local']);

  proxy.dispose();
  assert.deepEqual(disposed, ['local', 'server']);
});

test('TauriGrpcAnalysisBackend forwards full flow via invoke bridge', async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
  const invokeMock = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });

    if (command === 'grpc_analysis_load_model') {
      return { labelCount: 1234, hasAreaModel: true } as T;
    }
    if (command === 'grpc_analysis_set_location') {
      return { ok: true, week: 14 } as T;
    }
    if (command === 'grpc_analysis_get_species') {
      return [{ scientific: 'Corvus corax', common: 'Raven', geoscore: 0.8 }] as T;
    }
    if (command === 'grpc_analysis_analyze') {
      return [
        { start: 0, end: 1, scientific: 'Corvus corax', common: 'Raven', confidence: 0.93, geoscore: 0.8 },
      ] as T;
    }
    if (command === 'grpc_analysis_clear_location') {
      return undefined as T;
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  const backend = new TauriGrpcAnalysisBackend({ invokeImpl: invokeMock });

  const load = await backend.load({ modelUrl: '../models/birdnet-v2.4/' });
  assert.equal(load.labelCount, 1234);
  assert.equal(load.hasAreaModel, true);
  assert.equal(backend.loaded, true);
  assert.equal(backend.hasAreaModel, true);

  const location = await backend.setLocation(10.1, 11.2, { date: '2026-05-07' });
  assert.equal(location.ok, true);
  assert.equal(location.week, 14);

  const species = await backend.getAllSpecies();
  assert.equal(species.length, 1);
  assert.equal(species[0].scientific, 'Corvus corax');

  const detections = await backend.analyze([0.1, -0.2, 0.3], {
    sampleRate: 48_000,
    overlap: 1,
    minConfidence: 0.25,
    geoThreshold: 0,
  });
  assert.equal(detections.length, 1);
  assert.equal(detections[0].common, 'Raven');

  await backend.clearLocation();

  assert.ok(calls.some((c) => c.command === 'grpc_analysis_load_model'));
  assert.ok(calls.some((c) => c.command === 'grpc_analysis_set_location'));
  assert.ok(calls.some((c) => c.command === 'grpc_analysis_get_species'));
  assert.ok(calls.some((c) => c.command === 'grpc_analysis_analyze'));
  assert.ok(calls.some((c) => c.command === 'grpc_analysis_clear_location'));
});
