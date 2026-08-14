import { startTestDatabase, stopTestDatabase, TestDatabase } from './postgres';

describe('startTestDatabase', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  it('applies the schema: both tables exist with expected columns', async () => {
    const tables = await db.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['arrival_predictions', 'poll_runs']);

    const columns = await db.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'arrival_predictions' ORDER BY column_name`,
    );
    expect(columns.rows.map((r) => r.column_name)).toContain('observation_count');
  });

  it('creates the partial open-lookup index', async () => {
    const indexes = await db.pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'arrival_predictions'`,
    );
    expect(indexes.rows.map((r) => r.indexname)).toContain('idx_predictions_open_lookup');
  });
});
