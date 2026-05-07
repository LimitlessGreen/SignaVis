#!/usr/bin/env node
import http from 'node:http';

const HOST = process.env.ANALYSIS_MOCK_HOST || '127.0.0.1';
const PORT = Number(process.env.ANALYSIS_MOCK_PORT || 8787);

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

let locationState = null;

function sendJson(res, status, payload) {
  res.writeHead(status, JSON_HEADERS);
  res.end(payload == null ? '' : JSON.stringify(payload));
}

function sendNoContent(res) {
  res.writeHead(204, JSON_HEADERS);
  res.end();
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 15 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function buildMockDetections(options = {}) {
  const minConfidence = Number(options.minConfidence ?? 0.25);
  return [
    {
      start: 0,
      end: 3,
      scientific: 'Corvus corax',
      common: 'Raven',
      confidence: Math.max(minConfidence, 0.91),
      geoscore: locationState ? 0.83 : 1,
    },
    {
      start: 3,
      end: 6,
      scientific: 'Parus major',
      common: 'Great Tit',
      confidence: Math.max(minConfidence, 0.76),
      geoscore: locationState ? 0.62 : 1,
    },
  ];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    return sendNoContent(res);
  }

  try {
    if (req.method === 'POST' && path === '/analysis/load') {
      const body = await parseBody(req);
      const modelUrl = String(body.modelUrl || '');
      return sendJson(res, 200, {
        labelCount: 6522,
        hasAreaModel: true,
        modelUrl,
      });
    }

    if (req.method === 'POST' && path === '/analysis/location') {
      const body = await parseBody(req);
      locationState = {
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
        date: body.date || null,
      };
      return sendJson(res, 200, { ok: true, week: 22 });
    }

    if (req.method === 'DELETE' && path === '/analysis/location') {
      locationState = null;
      return sendNoContent(res);
    }

    if (req.method === 'GET' && path === '/analysis/species') {
      return sendJson(res, 200, [
        { scientific: 'Corvus corax', common: 'Raven', geoscore: locationState ? 0.83 : null },
        { scientific: 'Parus major', common: 'Great Tit', geoscore: locationState ? 0.62 : null },
      ]);
    }

    if (req.method === 'POST' && path === '/analysis/analyze') {
      const body = await parseBody(req);
      const detections = buildMockDetections(body.options || {});
      return sendJson(res, 200, detections);
    }

    return sendJson(res, 404, { message: 'Not found' });
  } catch (err) {
    return sendJson(res, 400, { message: err?.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`analysis-mock-server listening on http://${HOST}:${PORT}`);
});
