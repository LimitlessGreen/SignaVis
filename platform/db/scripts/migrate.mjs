import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

function assertDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  return url;
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles() {
  const names = await fs.readdir(MIGRATIONS_DIR);
  return names
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

async function getAppliedMigrations(client) {
  const result = await client.query('SELECT id FROM schema_migrations ORDER BY id');
  return new Set(result.rows.map((row) => row.id));
}

async function printStatus(client) {
  const files = await listMigrationFiles();
  const applied = await getAppliedMigrations(client);
  for (const file of files) {
    const state = applied.has(file) ? 'applied' : 'pending';
    console.log(`${state.padEnd(8)} ${file}`);
  }
}

async function applyMigrations(client) {
  const files = await listMigrationFiles();
  const applied = await getAppliedMigrations(client);

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sqlPath = path.join(MIGRATIONS_DIR, file);
    const sql = await fs.readFile(sqlPath, 'utf8');

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied  ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`failed migration ${file}: ${err.message}`);
    }
  }

  console.log('migration run completed');
}

async function main() {
  const databaseUrl = assertDatabaseUrl();
  const statusOnly = process.argv.includes('--status');

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    if (statusOnly) {
      await printStatus(client);
    } else {
      await applyMigrations(client);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
