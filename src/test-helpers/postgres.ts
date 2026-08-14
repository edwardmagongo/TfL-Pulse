import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface TestDatabase {
  pool: Pool;
  container: StartedPostgreSqlContainer;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const schema = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf-8');
  await pool.query(schema);
  return { pool, container };
}

export async function stopTestDatabase(db: TestDatabase): Promise<void> {
  await db.pool.end();
  await db.container.stop();
}
