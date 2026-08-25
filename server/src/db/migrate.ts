import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '../../../db/migrations');

async function adminClient(database?: string): Promise<pg.Client> {
  const url = new URL(env.ADMIN_DATABASE_URL);
  if (database) url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

async function ensureDatabase(reset: boolean): Promise<void> {
  const admin = await adminClient();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [env.DATABASE_NAME]);
    if (exists.rowCount && reset) {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [env.DATABASE_NAME],
      );
      await admin.query(`DROP DATABASE ${pg.escapeIdentifier(env.DATABASE_NAME)}`);
      console.log(`[migrate] dropped database ${env.DATABASE_NAME}`);
    }
    const stillExists = reset ? { rowCount: 0 } : exists;
    if (!stillExists.rowCount) {
      await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(env.DATABASE_NAME)}`);
      console.log(`[migrate] created database ${env.DATABASE_NAME}`);
    }
  } finally {
    await admin.end();
  }
}

/** 애플리케이션 로그인 계정. NOINHERIT 이므로 SET ROLE 없이는 무권한. */
async function ensureAppRole(client: pg.Client): Promise<void> {
  const pw = pg.escapeLiteral(env.APP_DB_PASSWORD);
  const user = pg.escapeIdentifier(env.APP_DB_USER);
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [env.APP_DB_USER]);
  if (exists.rowCount) {
    await client.query(`ALTER ROLE ${user} LOGIN NOINHERIT PASSWORD ${pw}`);
  } else {
    await client.query(`CREATE ROLE ${user} LOGIN NOINHERIT PASSWORD ${pw}`);
  }
  await client.query(
    `GRANT rfcip_head_office, rfcip_field_manager, rfcip_external TO ${user}`,
  );
  await client.query(
    `GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(env.DATABASE_NAME)} TO ${user}`,
  );
}

export async function migrate(reset = false): Promise<string[]> {
  await ensureDatabase(reset);
  const client = await adminClient(env.DATABASE_NAME);
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migration (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM public.schema_migration WHERE filename = $1', [file]);
      if (done.rowCount) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migration(filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] FAILED ${file}`);
        throw err;
      }
    }
    // 역할이 만들어진 뒤에 애플리케이션 계정을 연결한다.
    await ensureAppRole(client);
  } finally {
    await client.end();
  }
  return applied;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const reset = process.argv.includes('--reset');
  migrate(reset)
    .then((a) => { console.log(`[migrate] done (${a.length} applied)`); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
