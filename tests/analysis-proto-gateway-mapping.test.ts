import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toProtoLoadModelRequest,
  toProtoSetLocationRequest,
  toProtoAnalyzeRequest,
  fromProtoAnalyzeResponse,
} from '../src/domain/analysis/protoGatewayMapping.ts';

test('toProtoLoadModelRequest maps camelCase to snake_case', () => {
  const out = toProtoLoadModelRequest({ modelUrl: '../models/birdnet-v2.4/' });
  assert.deepEqual(out, { model_url: '../models/birdnet-v2.4/' });
});

test('toProtoSetLocationRequest maps date and coordinates', () => {
  const out = toProtoSetLocationRequest(48.14, 11.58, { date: '2026-05-07' });
  assert.deepEqual(out, {
    latitude: 48.14,
    longitude: 11.58,
    date_iso8601: '2026-05-07',
  });
});

test('toProtoAnalyzeRequest maps options and samples with defaults', () => {
  const out = toProtoAnalyzeRequest(new Float32Array([0.1, -0.2]));
  assert.deepEqual(out, {
    samples: [0.10000000149011612, -0.20000000298023224],
    options: {
      sample_rate: 48000,
      overlap: 0,
      min_confidence: 0.25,
      geo_threshold: 0,
    },
  });
});

test('toProtoAnalyzeRequest maps explicit option overrides', () => {
  const out = toProtoAnalyzeRequest([0, 1, 2], {
    sampleRate: 32000,
    overlap: 1,
    minConfidence: 0.42,
    geoThreshold: 0.12,
  });
  assert.deepEqual(out, {
    samples: [0, 1, 2],
    options: {
      sample_rate: 32000,
      overlap: 1,
      min_confidence: 0.42,
      geo_threshold: 0.12,
    },
  });
});

test('fromProtoAnalyzeResponse maps detections back to domain shape', () => {
  const out = fromProtoAnalyzeResponse({
    detections: [
      {
        start: 0,
        end: 3,
        scientific: 'Corvus corax',
        common: 'Raven',
        confidence: 0.91,
        geoscore: 0.83,
      },
    ],
  });

  assert.deepEqual(out, [
    {
      start: 0,
      end: 3,
      scientific: 'Corvus corax',
      common: 'Raven',
      confidence: 0.91,
      geoscore: 0.83,
    },
  ]);
});
