import { Pool } from 'pg';
import { createClient } from 'redis';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function makeRedis() {
  const c = createClient({ url: process.env.REDIS_URL });
  c.on('error', (err) => console.error('redis error', err.message));
  return c;
}

const redis = makeRedis();
const redisPlatformQueue = makeRedis();
const redisImportQueue = makeRedis();

await redis.connect();
await redisPlatformQueue.connect();
await redisImportQueue.connect();

const JOB_QUEUE_KEY = 'aw:jobs';
const JOB_PROCESSING_KEY = 'aw:jobs:processing';
const JOB_DLQ_KEY = 'aw:jobs:dlq';
const MAX_RETRIES = Number(process.env.WORKER_MAX_RETRIES || 3);
const STALE_RUNNING_SECONDS = Number(process.env.WORKER_STALE_RUNNING_SECONDS || 120);

async function ackJob(jobId) {
  await redis.lRem(JOB_PROCESSING_KEY, 1, jobId);
}

async function requeueJobWithBackoff(jobId, retryCount) {
  const backoffMs = Math.min(30_000, Math.max(500, retryCount * 1000));
  await new Promise((resolve) => setTimeout(resolve, backoffMs));
  await redis.lPush(JOB_QUEUE_KEY, jobId);
}

async function markJobRunning(jobId) {
  await pool.query(
    `
      UPDATE jobs
      SET status = 'running',
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = $1
    `,
    [jobId],
  );
}

async function markJobDone(jobId) {
  await pool.query(
    `
      UPDATE jobs
      SET status = 'done',
          progress = 1,
          finished_at = now(),
          updated_at = now(),
          error_code = NULL,
          error_message = NULL
      WHERE id = $1
    `,
    [jobId],
  );
}

async function markJobFailed(jobId, retryCount, message) {
  await pool.query(
    `
      UPDATE jobs
      SET status = 'failed',
          updated_at = now(),
          error_code = 'worker_error',
          error_message = $3,
          payload_json = jsonb_set(COALESCE(payload_json, '{}'::jsonb), '{retryCount}', to_jsonb($2::int), true)
      WHERE id = $1
    `,
    [jobId, retryCount, message],
  );
}

async function markJobQueued(jobId, retryCount) {
  await pool.query(
    `
      UPDATE jobs
      SET status = 'queued',
          updated_at = now(),
          payload_json = jsonb_set(COALESCE(payload_json, '{}'::jsonb), '{retryCount}', to_jsonb($2::int), true)
      WHERE id = $1
    `,
    [jobId, retryCount],
  );
}

async function loadJob(jobId) {
  const result = await pool.query(
    `
      SELECT id,
             type,
             status,
             payload_json AS payload
      FROM jobs
      WHERE id = $1
      LIMIT 1
    `,
    [jobId],
  );
  return result.rows[0] || null;
}

async function processPlatformJob(jobId) {
  const job = await loadJob(jobId);
  if (!job) {
    console.warn('job not found in DB, dropping', jobId);
    await ackJob(jobId);
    return;
  }

  const retryCount = Number(job.payload?.retryCount || 0);

  try {
    await markJobRunning(jobId);

    // Simulated worker processing; plug real import/analysis/embedding handlers here.
    await new Promise((resolve) => setTimeout(resolve, 800));

    await markJobDone(jobId);
    await ackJob(jobId);
    console.log('completed platform job', jobId, 'type=', job.type);
  } catch (err) {
    const nextRetry = retryCount + 1;
    const message = err?.message || 'unknown worker error';

    if (nextRetry <= MAX_RETRIES) {
      await markJobQueued(jobId, nextRetry);
      await ackJob(jobId);
      await requeueJobWithBackoff(jobId, nextRetry);
      console.warn('requeued platform job', jobId, 'retry=', nextRetry);
      return;
    }

    await markJobFailed(jobId, nextRetry, message);
    await ackJob(jobId);
    await redis.lPush(JOB_DLQ_KEY, jobId);
    console.error('platform job moved to DLQ', jobId, message);
  }
}

async function recoverStaleRunningJobs() {
  const query = `
    SELECT id
    FROM jobs
    WHERE status = 'running'
      AND started_at < now() - ($1::text)::interval
    LIMIT 100
  `;

  const intervalText = `${STALE_RUNNING_SECONDS} seconds`;
  const result = await pool.query(query, [intervalText]);
  for (const row of result.rows) {
    await markJobQueued(row.id, 0);
    await redis.lPush(JOB_QUEUE_KEY, row.id);
    console.warn('recovered stale running job', row.id);
  }
}

async function runPlatformJobs() {
  console.log('platform job queue worker started');
  while (true) {
    const jobId = await redisPlatformQueue.brPopLPush(JOB_QUEUE_KEY, JOB_PROCESSING_KEY, 0);
    if (!jobId) {
      continue;
    }

    await processPlatformJob(jobId);
  }
}

async function processJob(jobId) {
  await pool.query(
    `UPDATE import_jobs SET status = 'running', updated_at = now() WHERE id = $1`,
    [jobId],
  );

  // Minimal simulation for test environment; real importer plugs in here.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  await pool.query(
    `
    UPDATE import_jobs
    SET status = 'done',
        processed_items = total_items,
        failed_items = 0,
        updated_at = now()
    WHERE id = $1
    `,
    [jobId],
  );

  console.log('completed import job', jobId);
}

async function runLegacyImportJobs() {
  console.log('legacy import queue worker started');
  while (true) {
    const data = await redisImportQueue.brPop('aw:import-jobs', 0);
    const jobId = data?.element;
    if (!jobId) continue;

    try {
      await processJob(jobId);
    } catch (err) {
      console.error('job failed', jobId, err.message);
      await pool.query(
        `
        UPDATE import_jobs
        SET status = 'failed',
            failed_items = failed_items + 1,
            error_log = COALESCE(error_log, '') || E'\n' || $2,
            updated_at = now()
        WHERE id = $1
        `,
        [jobId, err.message],
      );
    }
  }
}

async function run() {
  console.log('aw-platform-worker started');

  setInterval(() => {
    recoverStaleRunningJobs().catch((err) => {
      console.error('stale job recovery failed', err.message);
    });
  }, 30_000);

  await Promise.all([
    runPlatformJobs(),
    runLegacyImportJobs(),
  ]);
}

run().catch((err) => {
  console.error('worker fatal', err);
  process.exit(1);
});
