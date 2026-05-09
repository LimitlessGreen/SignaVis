import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { createOidcAuthMiddleware } from './auth.js';
import { checkProjectRole, createRbacMiddleware } from './rbac.js';
import { metricsSnapshot, observabilityMiddleware } from './observability.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(observabilityMiddleware);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('redis error', err.message));

await redis.connect();

const authMiddleware = createOidcAuthMiddleware();
const rbac = createRbacMiddleware(pool);

async function writeAuditEvent({
  projectId = null,
  actorUserId = null,
  eventType,
  entityType,
  entityId,
  payload = {},
}) {
  if (!eventType || !entityType || !entityId) {
    return;
  }

  const insert = `
    INSERT INTO audit_events (
      project_id,
      actor_user_id,
      event_type,
      entity_type,
      entity_id,
      payload_json
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  `;

  try {
    await pool.query(insert, [
      projectId,
      actorUserId,
      eventType,
      entityType,
      String(entityId),
      JSON.stringify(payload || {}),
    ]);
  } catch (err) {
    console.error('audit write failed', err.message);
  }
}

app.get('/health', async (_req, res) => {
  try {
    const db = await pool.query('SELECT 1 as ok');
    await redis.ping();
    return res.json({
      ok: true,
      db: db.rows[0]?.ok === 1,
      redis: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({ ok: false, error: err.message });
  }
});

app.get('/metrics', (_req, res) => {
  return res.json({
    ok: true,
    metrics: metricsSnapshot(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/v1/auth/me', authMiddleware, async (req, res) => {
  return res.json({
    ok: true,
    auth: req.auth
      ? {
          subject: req.auth.subject,
          email: req.auth.email,
          roles: req.auth.roles,
        }
      : null,
  });
});

app.get('/api/v1/audit-events', authMiddleware, rbac.requireActor, rbac.requireProjectScope, rbac.requireProjectRole('reviewer'), async (req, res) => {
  const projectId = req.query.projectId;
  const query = `
    SELECT id,
           project_id AS "projectId",
           actor_user_id AS "actorUserId",
           event_type AS "eventType",
           entity_type AS "entityType",
           entity_id AS "entityId",
           payload_json AS payload,
           created_at AS "createdAt"
    FROM audit_events
    WHERE project_id = $1
    ORDER BY created_at DESC
    LIMIT 200
  `;

  const result = await pool.query(query, [projectId]);
  return res.json({ events: result.rows });
});

app.get('/api/v1/projects', authMiddleware, rbac.requireActor, rbac.requireTeamScope, async (req, res) => {
  const teamId = req.query.teamId;
  if (!teamId) {
    return res.status(400).json({ error: 'teamId is required' });
  }

  const query = `
    SELECT p.id, p.team_id AS "teamId", p.name, p.description, p.archived,
           p.created_at AS "createdAt", p.updated_at AS "updatedAt",
           COALESCE(COUNT(r.id), 0)::int AS "recordingCount"
    FROM projects p
    LEFT JOIN recordings r ON r.project_id = p.id
    WHERE p.team_id = $1
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `;

  const result = await pool.query(query, [teamId]);
  return res.json({ projects: result.rows });
});

app.post('/api/v1/projects', authMiddleware, rbac.requireActor, rbac.requireTeamScope, async (req, res) => {
  const { teamId, name, description = '', createdBy } = req.body ?? {};
  if (!teamId || !name || !createdBy) {
    return res.status(400).json({ error: 'teamId, name and createdBy are required' });
  }

  const insert = `
    INSERT INTO projects (team_id, name, description, created_by)
    VALUES ($1, $2, $3, $4)
    RETURNING id, team_id AS "teamId", name, description, archived,
              created_at AS "createdAt", updated_at AS "updatedAt"
  `;

  const result = await pool.query(insert, [teamId, name, description, createdBy]);
  await writeAuditEvent({
    projectId: result.rows[0].id,
    actorUserId: req.actor?.id || null,
    eventType: 'project.created',
    entityType: 'project',
    entityId: result.rows[0].id,
    payload: { teamId, name },
  });
  return res.status(201).json(result.rows[0]);
});

app.get('/api/v1/projects/:projectId/assets', authMiddleware, rbac.requireActor, rbac.requireProjectScope, rbac.requireProjectRole('viewer'), async (req, res) => {
  const { projectId } = req.params;
  const query = `
    SELECT id,
           project_id AS "projectId",
           type,
           source_type AS "sourceType",
           source_ref AS "sourceRef",
           storage_uri AS "storageUri",
           checksum,
           size_bytes AS "sizeBytes",
           metadata_json AS metadata,
           created_at AS "createdAt",
           updated_at AS "updatedAt"
    FROM assets
    WHERE project_id = $1
    ORDER BY created_at DESC
  `;

  const result = await pool.query(query, [projectId]);
  return res.json({ assets: result.rows });
});

app.post('/api/v1/projects/:projectId/assets', authMiddleware, rbac.requireActor, rbac.requireProjectScope, rbac.requireProjectRole('annotator'), async (req, res) => {
  const { projectId } = req.params;
  const {
    sourceType = 'local',
    sourceRef,
    metadata = {},
    importedBy,
  } = req.body ?? {};

  if (!sourceRef || !importedBy) {
    return res.status(400).json({ error: 'sourceRef and importedBy are required' });
  }

  const insert = `
    INSERT INTO assets (
      project_id,
      type,
      source_type,
      source_ref,
      metadata_json,
      created_by
    )
    VALUES ($1, 'audio', $2, $3, $4::jsonb, $5)
    RETURNING id,
              project_id AS "projectId",
              type,
              source_type AS "sourceType",
              source_ref AS "sourceRef",
              storage_uri AS "storageUri",
              checksum,
              size_bytes AS "sizeBytes",
              metadata_json AS metadata,
              created_at AS "createdAt",
              updated_at AS "updatedAt"
  `;

  const result = await pool.query(insert, [
    projectId,
    sourceType,
    sourceRef,
    JSON.stringify(metadata),
    importedBy,
  ]);

  await writeAuditEvent({
    projectId,
    actorUserId: req.actor?.id || null,
    eventType: 'asset.imported',
    entityType: 'asset',
    entityId: result.rows[0].id,
    payload: {
      sourceType,
      sourceRef,
    },
  });

  return res.status(201).json(result.rows[0]);
});

app.get('/api/v1/jobs', authMiddleware, rbac.requireActor, rbac.requireProjectScope, rbac.requireProjectRole('viewer'), async (req, res) => {
  const projectId = req.query.projectId;
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  const query = `
    SELECT id,
           project_id AS "projectId",
           asset_id AS "assetId",
           type,
           backend,
           CASE
             WHEN status = 'done' THEN 'done'
             WHEN status = 'failed' THEN 'failed'
             WHEN status = 'partial' THEN 'partial'
             WHEN status = 'cancelled' THEN 'cancelled'
             WHEN status = 'running' THEN 'running'
             ELSE 'queued'
           END AS status,
           progress,
           error_code AS "errorCode",
           error_message AS "errorMessage",
           created_by AS "createdBy",
           started_at AS "startedAt",
           finished_at AS "finishedAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
    FROM jobs
    WHERE project_id = $1
    ORDER BY created_at DESC
  `;

  const result = await pool.query(query, [projectId]);
  return res.json({ jobs: result.rows });
});

app.get('/api/v1/jobs/:jobId', authMiddleware, rbac.requireActor, async (req, res) => {
  const { jobId } = req.params;
  const query = `
    SELECT id,
           project_id AS "projectId",
           asset_id AS "assetId",
           type,
           backend,
           status,
           progress,
           error_code AS "errorCode",
           error_message AS "errorMessage",
           created_by AS "createdBy",
           started_at AS "startedAt",
           finished_at AS "finishedAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
    FROM jobs
    WHERE id = $1
    LIMIT 1
  `;

  const result = await pool.query(query, [jobId]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'job not found' });
  }

  const row = result.rows[0];
  const roleCheck = await checkProjectRole(pool, req.auth, req.actor, row.projectId, 'viewer');
  if (!roleCheck.ok) {
    return res.status(403).json({ error: 'forbidden', message: 'project role "viewer" required' });
  }

  return res.json(row);
});

app.post('/api/v1/jobs', authMiddleware, rbac.requireActor, rbac.requireProjectScope, rbac.requireProjectRole('annotator'), async (req, res) => {
  const {
    projectId,
    assetId = null,
    type = 'analysis',
    backend = 'local',
    priority = 'normal',
    payload = {},
    createdBy,
  } = req.body ?? {};

  if (!projectId || !createdBy) {
    return res.status(400).json({ error: 'projectId and createdBy are required' });
  }

  const priorityRank = priority === 'high' ? 8 : priority === 'low' ? 2 : 5;

  const insert = `
    INSERT INTO jobs (
      project_id,
      asset_id,
      type,
      backend,
      status,
      priority,
      payload_json,
      created_by
    )
    VALUES ($1, $2, $3, $4, 'queued', $5, $6::jsonb, $7)
    RETURNING id,
              project_id AS "projectId",
              asset_id AS "assetId",
              type,
              backend,
              status,
              progress,
              error_code AS "errorCode",
              error_message AS "errorMessage",
              created_by AS "createdBy",
              started_at AS "startedAt",
              finished_at AS "finishedAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
  `;

  const result = await pool.query(insert, [
    projectId,
    assetId,
    type,
    backend,
    priorityRank,
    JSON.stringify(payload),
    createdBy,
  ]);

  await redis.lPush('aw:jobs', result.rows[0].id);
  await writeAuditEvent({
    projectId,
    actorUserId: req.actor?.id || null,
    eventType: 'job.created',
    entityType: 'job',
    entityId: result.rows[0].id,
    payload: {
      type,
      backend,
      priority,
    },
  });
  return res.status(201).json(result.rows[0]);
});

app.delete('/api/v1/jobs/:jobId', authMiddleware, rbac.requireActor, async (req, res) => {
  const { jobId } = req.params;
  const lookup = await pool.query('SELECT project_id AS "projectId" FROM jobs WHERE id = $1 LIMIT 1', [jobId]);
  if (lookup.rowCount === 0) {
    return res.status(404).json({ error: 'job not found' });
  }
  const roleCheck = await checkProjectRole(pool, req.auth, req.actor, lookup.rows[0].projectId, 'manager');
  if (!roleCheck.ok) {
    return res.status(403).json({ error: 'forbidden', message: 'project role "manager" required' });
  }

  const update = `
    UPDATE jobs
    SET status = 'cancelled', updated_at = now()
    WHERE id = $1
    RETURNING id
  `;
  const result = await pool.query(update, [jobId]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'job not found' });
  }

  await writeAuditEvent({
    projectId: lookup.rows[0].projectId,
    actorUserId: req.actor?.id || null,
    eventType: 'job.cancelled',
    entityType: 'job',
    entityId: jobId,
    payload: { reason: 'api_cancel' },
  });

  return res.status(202).json({ ok: true });
});

app.post('/api/v1/jobs/:jobId/requeue', authMiddleware, rbac.requireActor, async (req, res) => {
  const { jobId } = req.params;
  const lookup = await pool.query('SELECT project_id AS "projectId" FROM jobs WHERE id = $1 LIMIT 1', [jobId]);
  if (lookup.rowCount === 0) {
    return res.status(404).json({ error: 'job not found' });
  }

  const roleCheck = await checkProjectRole(pool, req.auth, req.actor, lookup.rows[0].projectId, 'manager');
  if (!roleCheck.ok) {
    return res.status(403).json({ error: 'forbidden', message: 'project role "manager" required' });
  }

  const update = `
    UPDATE jobs
    SET status = 'queued',
        error_code = NULL,
        error_message = NULL,
        updated_at = now()
    WHERE id = $1
    RETURNING id, project_id AS "projectId", status, updated_at AS "updatedAt"
  `;
  const result = await pool.query(update, [jobId]);
  await redis.lPush('aw:jobs', jobId);

  await writeAuditEvent({
    projectId: lookup.rows[0].projectId,
    actorUserId: req.actor?.id || null,
    eventType: 'job.requeued',
    entityType: 'job',
    entityId: jobId,
    payload: { source: 'api' },
  });

  return res.status(202).json(result.rows[0]);
});

app.get('/api/v1/jobs-dlq', authMiddleware, rbac.requireActor, rbac.requireProjectScope, rbac.requireProjectRole('reviewer'), async (req, res) => {
  const ids = await redis.lRange('aw:jobs:dlq', 0, 199);
  if (ids.length === 0) {
    return res.json({ jobs: [] });
  }

  const query = `
    SELECT id,
           project_id AS "projectId",
           asset_id AS "assetId",
           type,
           backend,
           status,
           progress,
           error_code AS "errorCode",
           error_message AS "errorMessage",
           created_by AS "createdBy",
           started_at AS "startedAt",
           finished_at AS "finishedAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
    FROM jobs
    WHERE id = ANY($1::uuid[])
      AND project_id = $2
    ORDER BY updated_at DESC
  `;

  const result = await pool.query(query, [ids, req.query.projectId]);
  return res.json({ jobs: result.rows });
});

app.get('/api/v1/import-jobs', authMiddleware, rbac.requireActor, rbac.requireProjectScope, rbac.requireProjectRole('viewer'), async (req, res) => {
  const projectId = req.query.projectId;
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  const query = `
    SELECT id, project_id AS "projectId", source, status,
           total_items AS "totalItems", processed_items AS "processedItems",
           failed_items AS "failedItems", error_log AS "errorLog",
           created_by AS "createdBy", created_at AS "createdAt",
           updated_at AS "updatedAt"
    FROM import_jobs
    WHERE project_id = $1
    ORDER BY created_at DESC
  `;

  const result = await pool.query(query, [projectId]);
  return res.json({ jobs: result.rows });
});

app.post('/api/v1/import-jobs', authMiddleware, rbac.requireActor, rbac.requireProjectScope, rbac.requireProjectRole('annotator'), async (req, res) => {
  const { projectId, source = 'xeno-canto', totalItems = 0, createdBy } = req.body ?? {};
  if (!projectId || !createdBy) {
    return res.status(400).json({ error: 'projectId and createdBy are required' });
  }

  const insert = `
    INSERT INTO import_jobs (project_id, source, status, total_items, created_by)
    VALUES ($1, $2, 'queued', $3, $4)
    RETURNING id, project_id AS "projectId", source, status,
              total_items AS "totalItems", processed_items AS "processedItems",
              failed_items AS "failedItems", error_log AS "errorLog",
              created_by AS "createdBy", created_at AS "createdAt",
              updated_at AS "updatedAt"
  `;

  const result = await pool.query(insert, [projectId, source, totalItems, createdBy]);
  await redis.lPush('aw:import-jobs', result.rows[0].id);
  await writeAuditEvent({
    projectId,
    actorUserId: req.actor?.id || null,
    eventType: 'import_job.created',
    entityType: 'import_job',
    entityId: result.rows[0].id,
    payload: {
      source,
      totalItems,
    },
  });
  return res.status(201).json(result.rows[0]);
});

const port = Number(process.env.PORT || 8788);
app.listen(port, () => {
  console.log(`aw-platform-api listening on :${port}`);
});
