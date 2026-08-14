import { readFileSync } from 'fs';
import { join } from 'path';
import { startTestDatabase, stopTestDatabase, TestDatabase } from './test-helpers/postgres';
import { pollStation, runPollCycle } from './ingest';
import * as tflClient from './tfl-client';
import * as dbModule from './db';

jest.mock('./tfl-client', () => ({
  ...jest.requireActual('./tfl-client'),
  fetchArrivals: jest.fn(),
}));

jest.mock('./db', () => {
  const actual = jest.requireActual('./db');
  return {
    ...actual,
    getOpenPredictions: jest.fn(actual.getOpenPredictions),
    recordPollFailure: jest.fn(actual.recordPollFailure),
  };
});

const actualDb = jest.requireActual('./db');
const mockFetchArrivals = tflClient.fetchArrivals as jest.Mock;
const mockGetOpenPredictions = dbModule.getOpenPredictions as jest.Mock;
const mockRecordPollFailure = dbModule.recordPollFailure as jest.Mock;
const station = { naptanId: 'station-A', name: 'Test Station' };

describe('pollStation', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE arrival_predictions, poll_runs');
    mockFetchArrivals.mockReset();
    mockGetOpenPredictions.mockReset().mockImplementation(actualDb.getOpenPredictions);
    mockRecordPollFailure.mockReset().mockImplementation(actualDb.recordPollFailure);
  });

  it('a successful fetch inserts new predictions and records success (invariant 2)', async () => {
    mockFetchArrivals.mockResolvedValue([
      { id: 'p1', naptanId: 'station-A', lineId: 'circle', timeToStation: 60, expectedArrival: '2026-08-09T12:10:00Z' },
    ]);

    const outcome = await pollStation(db.pool, station);

    expect(outcome).toMatchObject({ outcome: 'success', stationNaptanId: 'station-A', predictionsSeen: 1 });
    const rows = await db.pool.query('SELECT * FROM arrival_predictions');
    expect(rows.rows).toHaveLength(1);
    const runs = await db.pool.query('SELECT * FROM poll_runs');
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0].outcome).toBe('success');
  });

  it('a failed fetch (after the client\'s own retry) leaves predictions completely untouched and records failure (invariant 1)', async () => {
    // Seed one open prediction that must survive this failed poll unchanged.
    await db.pool.query(
      `INSERT INTO arrival_predictions
        (tfl_prediction_id, station_naptan_id, line_id, first_seen_at, last_seen_at, last_seen_eta, status)
       VALUES ('existing', 'station-A', 'circle', '2026-08-09T12:00:00Z', '2026-08-09T12:00:00Z', '2026-08-09T12:05:00Z', 'open')`,
    );
    mockFetchArrivals.mockRejectedValue(new Error('TfL fetch failed for station station-A after 1 retry: HTTP 503'));

    const outcome = await pollStation(db.pool, station);

    expect(outcome.outcome).toBe('failure');
    const rows = await db.pool.query('SELECT * FROM arrival_predictions');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].last_seen_at).toEqual(new Date('2026-08-09T12:00:00Z'));
    expect(rows.rows[0].status).toBe('open'); // not resolved by the failed poll
    const runs = await db.pool.query('SELECT * FROM poll_runs');
    expect(runs.rows[0].outcome).toBe('failure');
  });

  it('malformed predictions from a successful fetch are skipped, valid ones still ingested', async () => {
    mockFetchArrivals.mockResolvedValue([
      { id: 'good', naptanId: 'station-A', lineId: 'circle', timeToStation: 60, expectedArrival: '2026-08-09T12:10:00Z' },
      { id: 'bad', naptanId: 'station-A' }, // missing lineId, timeToStation, expectedArrival
    ]);

    const outcome = await pollStation(db.pool, station);

    expect(outcome).toMatchObject({ outcome: 'success', predictionsSeen: 1 });
    const rows = await db.pool.query('SELECT * FROM arrival_predictions');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].tfl_prediction_id).toBe('good');
  });

  it('resolves a failure outcome (rather than rejecting) when the rollback/failure-recording path itself throws (invariant 10)', async () => {
    mockFetchArrivals.mockResolvedValue([
      { id: 'p1', naptanId: 'station-A', lineId: 'circle', timeToStation: 60, expectedArrival: '2026-08-09T12:10:00Z' },
    ]);
    // Primary failure: something inside the open transaction throws.
    mockGetOpenPredictions.mockRejectedValueOnce(new Error('primary failure: could not read open predictions'));
    // Secondary failure: recordPollFailure (called from the catch block) also throws.
    mockRecordPollFailure.mockRejectedValueOnce(new Error('secondary failure: could not write poll_runs'));

    const outcome = await pollStation(db.pool, station);

    expect(outcome).toEqual({
      outcome: 'failure',
      stationNaptanId: 'station-A',
      errorMessage: 'primary failure: could not read open predictions',
    });
  });

  it('resolves a failure outcome (rather than rejecting) when the initial fetch fails and recordPollFailure also throws (invariant 10)', async () => {
    // Primary failure: fetchArrivals itself throws, before any transaction is opened.
    mockFetchArrivals.mockRejectedValue(new Error('primary failure: TfL fetch failed for station station-A'));
    // Secondary failure: recordPollFailure (called from the fetch-failure branch) also throws.
    mockRecordPollFailure.mockRejectedValueOnce(new Error('secondary failure: could not write poll_runs'));

    const outcome = await pollStation(db.pool, station);

    expect(outcome).toEqual({
      outcome: 'failure',
      stationNaptanId: 'station-A',
      errorMessage: 'primary failure: TfL fetch failed for station station-A',
    });
  });
});

describe('runPollCycle — station independence (invariant 10)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE arrival_predictions, poll_runs');
    mockFetchArrivals.mockReset();
  });

  it('one station failing does not block or roll back another station\'s already-committed work', async () => {
    const stationA = { naptanId: 'station-A', name: 'A' };
    const stationB = { naptanId: 'station-B', name: 'B' };

    mockFetchArrivals.mockImplementation(async (naptanId: string) => {
      if (naptanId === 'station-A') {
        return [{ id: 'p1', naptanId: 'station-A', lineId: 'circle', timeToStation: 60, expectedArrival: '2026-08-09T12:10:00Z' }];
      }
      throw new Error('TfL fetch failed for station station-B after 1 retry: HTTP 503');
    });

    const outcomes = await runPollCycle(db.pool, [stationA, stationB]);

    expect(outcomes[0]).toMatchObject({ outcome: 'success', stationNaptanId: 'station-A' });
    expect(outcomes[1]).toMatchObject({ outcome: 'failure', stationNaptanId: 'station-B' });

    const aRows = await db.pool.query(`SELECT * FROM arrival_predictions WHERE station_naptan_id = 'station-A'`);
    expect(aRows.rows).toHaveLength(1); // A's insert committed despite B's failure
  });
});

describe('ingest against real captured TfL fixtures', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE arrival_predictions, poll_runs');
    mockFetchArrivals.mockReset();
  });

  it('ingests two real consecutive polls of King\'s Cross, correctly resolving the real ambiguous-id case (invariants 2, 5, 6, 10)', async () => {
    const poll1 = JSON.parse(
      readFileSync(join(__dirname, '..', 'fixtures', 'kings-cross-arrivals-poll-1.json'), 'utf-8'),
    );
    const poll2 = JSON.parse(
      readFileSync(join(__dirname, '..', 'fixtures', 'kings-cross-arrivals-poll-2.json'), 'utf-8'),
    );
    const kingsCross = { naptanId: '940GZZLUKSX', name: "King's Cross St Pancras" };

    mockFetchArrivals.mockResolvedValueOnce(poll1);
    const first = await pollStation(db.pool, kingsCross);
    expect(first.outcome).toBe('success');

    mockFetchArrivals.mockResolvedValueOnce(poll2);
    const second = await pollStation(db.pool, kingsCross);
    expect(second.outcome).toBe('success');

    // The fixtures are real: 73 predictions per poll, 67 matched by id between them (verified
    // separately), 5 of which shared an ambiguous id in one snapshot.
    if (second.outcome === 'success') {
      expect(second.duplicateIdGroups).toBeGreaterThanOrEqual(1);
      expect(second.ambiguousPredictionPairs).toBeGreaterThanOrEqual(1);
    }

    // No row is ever both open and resolved, and every resolved row's resolved_at is after its last_seen_at.
    const allRows = await db.pool.query('SELECT * FROM arrival_predictions');
    // Note: these two real captured fixtures happen to have identical prediction-ID occurrence counts
    // between poll 1 and poll 2, so no row ever resolves in this particular test. The loop below is
    // present for defense-in-depth but currently does not exercise any iterations. Invariant 9
    // (resolved_at strictly after last_seen_at) is independently verified by the applyDiff resolve
    // test in src/db.spec.ts (Task 7), a real Postgres integration test.
    for (const row of allRows.rows) {
      if (row.status === 'resolved') {
        expect(new Date(row.resolved_at).getTime()).toBeGreaterThan(new Date(row.last_seen_at).getTime());
      }
    }
  });

  it('reprocessing the identical poll-1 snapshot twice does not duplicate rows (invariant 7)', async () => {
    const poll1 = JSON.parse(
      readFileSync(join(__dirname, '..', 'fixtures', 'kings-cross-arrivals-poll-1.json'), 'utf-8'),
    );
    const kingsCross = { naptanId: '940GZZLUKSX', name: "King's Cross St Pancras" };

    mockFetchArrivals.mockResolvedValue(poll1);

    await pollStation(db.pool, kingsCross);
    const afterFirst = await db.pool.query('SELECT count(*)::int AS count FROM arrival_predictions');

    await pollStation(db.pool, kingsCross);
    const afterSecond = await db.pool.query('SELECT count(*)::int AS count FROM arrival_predictions');

    expect(afterSecond.rows[0].count).toBe(afterFirst.rows[0].count);
  });
});
