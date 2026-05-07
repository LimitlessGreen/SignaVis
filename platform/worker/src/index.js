import { Pool } from 'pg';
import { createClient } from 'redis';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('redis error', err.message));

await redis.connect();

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

async function run() {
  console.log('aw-platform-worker started');
  while (true) {
    const data = await redis.brPop('aw:import-jobs', 0);
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

run().catch((err) => {
  console.error('worker fatal', err);
  process.exit(1);
});
