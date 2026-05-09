import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PLATFORM_LOCAL_PORT || 8788);
const DB_FILE = resolve(process.cwd(), 'platform/.local-testenv/db.json');
const RESET = process.argv.includes('--reset');

function ensureDbDir() {
  mkdirSync(dirname(DB_FILE), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function seedDb() {
  const createdAt = nowIso();
  return {
    users: [
      {
        id: '00000000-0000-0000-0000-000000000001',
        externalAuthId: 'local-admin',
        email: 'admin@local.test',
        displayName: 'Platform Admin',
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        externalAuthId: 'local-annotator',
        email: 'annotator@local.test',
        displayName: 'Annotator One',
        createdAt,
        updatedAt: createdAt,
      },
    ],
    teams: [{ id: '10000000-0000-0000-0000-000000000001', name: 'Demo Team', createdAt, updatedAt: createdAt }],
    projects: [
      {
        id: '20000000-0000-0000-0000-000000000001',
        teamId: '10000000-0000-0000-0000-000000000001',
        name: 'Demo Project',
        description: 'Seed project for local no-docker test environment',
        archived: false,
        createdBy: '00000000-0000-0000-0000-000000000001',
        createdAt,
        updatedAt: createdAt,
      },
    ],
    assets: [],
    jobs: [],
    importJobs: [],
  };
}

function loadDb() {
  ensureDbDir();
  if (RESET && existsSync(DB_FILE)) {
    rmSync(DB_FILE, { force: true });
  }
  if (!existsSync(DB_FILE)) {
    const initial = seedDb();
    writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const text = readFileSync(DB_FILE, 'utf8');
  return JSON.parse(text);
}

function saveDb(db) {
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const db = loadDb();
const importQueue = [];
const jobQueue = [];
const analysisState = {
  loaded: false,
  location: null,
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  });
  res.end(body);
}

function empty(res, status = 204) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  });
  res.end();
}

function parseBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        rejectBody(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new Error('invalid json'));
      }
    });
    req.on('error', rejectBody);
  });
}

function withRecordingCount(project) {
  return { ...project, recordingCount: 0 };
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    empty(res, 204);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      mode: 'local-json',
      dbFile: DB_FILE,
      queueDepth: importQueue.length,
      jobQueueDepth: jobQueue.length,
      timestamp: nowIso(),
    });
    return;
  }

  const assetsMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/assets$/);
  if (req.method === 'GET' && assetsMatch) {
    const projectId = assetsMatch[1];
    const assets = db.assets.filter((a) => a.projectId === projectId);
    json(res, 200, { assets });
    return;
  }

  if (req.method === 'POST' && assetsMatch) {
    const projectId = assetsMatch[1];
    const body = await parseBody(req);
    const { sourceType = 'local', sourceRef, importedBy, metadata = {} } = body;
    if (!sourceRef || !importedBy) {
      json(res, 400, { error: 'sourceRef and importedBy are required' });
      return;
    }

    const createdAt = nowIso();
    const asset = {
      id: randomUUID(),
      projectId,
      type: 'audio',
      sourceType,
      sourceRef,
      metadata,
      createdAt,
      updatedAt: createdAt,
    };
    db.assets.push(asset);
    saveDb(db);
    json(res, 201, asset);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/jobs') {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      json(res, 400, { error: 'projectId is required' });
      return;
    }
    const jobs = db.jobs.filter((j) => j.projectId === projectId);
    json(res, 200, { jobs });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/jobs') {
    const body = await parseBody(req);
    const {
      projectId,
      assetId = null,
      type = 'analysis',
      backend = 'local',
      createdBy,
      payload = {},
    } = body;
    if (!projectId || !createdBy) {
      json(res, 400, { error: 'projectId and createdBy are required' });
      return;
    }

    const createdAt = nowIso();
    const job = {
      id: randomUUID(),
      projectId,
      assetId,
      type,
      backend,
      status: 'queued',
      progress: 0,
      payload,
      createdBy,
      startedAt: null,
      finishedAt: null,
      createdAt,
      updatedAt: createdAt,
    };

    db.jobs.push(job);
    jobQueue.push(job.id);
    saveDb(db);
    json(res, 201, job);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/projects') {
    const teamId = url.searchParams.get('teamId');
    if (!teamId) {
      json(res, 400, { error: 'teamId is required' });
      return;
    }
    const projects = db.projects.filter((p) => p.teamId === teamId).map(withRecordingCount);
    json(res, 200, { projects });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/analysis/load') {
    analysisState.loaded = true;
    json(res, 200, { labelCount: 6522, hasAreaModel: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/analysis/location') {
    if (!analysisState.loaded) {
      json(res, 200, { ok: false, week: 0 });
      return;
    }
    const body = await parseBody(req);
    analysisState.location = {
      latitude: Number(body.latitude || 0),
      longitude: Number(body.longitude || 0),
      date: body.date || null,
    };
    json(res, 200, { ok: true, week: 22 });
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/analysis/location') {
    analysisState.location = null;
    empty(res, 204);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/analysis/species') {
    if (!analysisState.loaded) {
      json(res, 200, []);
      return;
    }

    const geoscore = analysisState.location ? 0.83 : 1.0;
    json(res, 200, [
      { scientific: 'Corvus corax', common: 'Raven', geoscore },
      { scientific: 'Parus major', common: 'Great Tit', geoscore: analysisState.location ? 0.62 : 1.0 },
    ]);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/analysis/analyze') {
    if (!analysisState.loaded) {
      json(res, 412, { message: 'analysis model not loaded' });
      return;
    }

    const body = await parseBody(req);
    const minConfidence = Number(body?.options?.minConfidence ?? 0.25);
    const geoscore = analysisState.location ? 0.83 : 1.0;
    json(res, 200, [
      {
        start: 0,
        end: 3,
        scientific: 'Corvus corax',
        common: 'Raven',
        confidence: Math.max(minConfidence, 0.91),
        geoscore,
      },
      {
        start: 3,
        end: 6,
        scientific: 'Parus major',
        common: 'Great Tit',
        confidence: Math.max(minConfidence, 0.76),
        geoscore: analysisState.location ? 0.62 : 1.0,
      },
    ]);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/projects') {
    const body = await parseBody(req);
    const { teamId, name, description = '', createdBy } = body;
    if (!teamId || !name || !createdBy) {
      json(res, 400, { error: 'teamId, name and createdBy are required' });
      return;
    }

    const createdAt = nowIso();
    const project = {
      id: randomUUID(),
      teamId,
      name,
      description,
      archived: false,
      createdBy,
      createdAt,
      updatedAt: createdAt,
    };
    db.projects.push(project);
    saveDb(db);
    json(res, 201, withRecordingCount(project));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/import-jobs') {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      json(res, 400, { error: 'projectId is required' });
      return;
    }
    const jobs = db.importJobs.filter((j) => j.projectId === projectId);
    json(res, 200, { jobs });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/import-jobs') {
    const body = await parseBody(req);
    const { projectId, source = 'xeno-canto', totalItems = 0, createdBy } = body;
    if (!projectId || !createdBy) {
      json(res, 400, { error: 'projectId and createdBy are required' });
      return;
    }

    const createdAt = nowIso();
    const job = {
      id: randomUUID(),
      projectId,
      source,
      status: 'queued',
      totalItems,
      processedItems: 0,
      failedItems: 0,
      errorLog: '',
      createdBy,
      createdAt,
      updatedAt: createdAt,
    };

    db.importJobs.push(job);
    importQueue.push(job.id);
    saveDb(db);
    json(res, 201, job);
    return;
  }

  json(res, 404, { error: 'not found' });
}

// Minimal background worker loop for import progress simulation.
setInterval(() => {
  if (!importQueue.length) return;
  const jobId = importQueue.shift();
  const job = db.importJobs.find((j) => j.id === jobId);
  if (!job) return;

  job.status = 'running';
  job.updatedAt = nowIso();
  saveDb(db);

  setTimeout(() => {
    job.status = 'done';
    job.processedItems = job.totalItems;
    job.updatedAt = nowIso();
    saveDb(db);
  }, 1000);
}, 400);

// Minimal background worker loop for jobs queue simulation.
setInterval(() => {
  if (!jobQueue.length) return;
  const jobId = jobQueue.shift();
  const job = db.jobs.find((j) => j.id === jobId);
  if (!job) return;

  job.status = 'running';
  job.progress = 0.5;
  job.startedAt = job.startedAt || nowIso();
  job.updatedAt = nowIso();
  saveDb(db);

  setTimeout(() => {
    job.status = 'done';
    job.progress = 1;
    job.finishedAt = nowIso();
    job.updatedAt = nowIso();
    saveDb(db);
  }, 600);
}, 300);

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    json(res, 500, { error: err.message || 'internal error' });
  });
});

server.listen(PORT, () => {
  console.log(`[platform-local] listening on http://localhost:${PORT}`);
  console.log(`[platform-local] db file: ${DB_FILE}`);
});
