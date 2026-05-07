import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import { createClient } from 'redis';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('redis error', err.message));

await redis.connect();

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

app.get('/api/v1/projects', async (req, res) => {
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

app.post('/api/v1/projects', async (req, res) => {
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
  return res.status(201).json(result.rows[0]);
});

app.get('/api/v1/import-jobs', async (req, res) => {
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

app.post('/api/v1/import-jobs', async (req, res) => {
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
  return res.status(201).json(result.rows[0]);
});

const port = Number(process.env.PORT || 8788);
app.listen(port, () => {
  console.log(`aw-platform-api listening on :${port}`);
});
