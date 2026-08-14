import { startTestDatabase, stopTestDatabase, TestDatabase } from './test-helpers/postgres';
import { pollStation } from './ingest';
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
