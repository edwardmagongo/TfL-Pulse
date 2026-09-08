import { Pool, type PoolClient } from 'pg';
import { startTestDatabase, stopTestDatabase, TestDatabase } from './test-helpers/postgres';
import {
  getOpenPredictions,
  applyDiff,
  recordPollSuccess,
  recordPollFailure,
  attachPoolErrorHandler,
} from './db';
import type { NormalizedPrediction, PredictionDiff } from './types';

describe('db', () => {
  let db: TestDatabase;
  let client: PoolClient;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  beforeEach(async () => {
    client = await db.pool.connect();
    await client.query('TRUNCATE arrival_predictions, poll_runs');
  });

  afterEach(() => {
    client.release();
  });

  describe('getOpenPredictions', () => {
    it('returns only open rows for the given station', async () => {
      await client.query(
        `INSERT INTO arrival_predictions
          (tfl_prediction_id, station_naptan_id, line_id, first_seen_at, last_seen_at, last_seen_eta, status)
         VALUES
          ('open-here', 'station-A', 'circle', now(), now(), now(), 'open'),
          ('resolved-here', 'station-A', 'circle', now(), now(), now(), 'resolved'),
          ('open-elsewhere', 'station-B', 'circle', now(), now(), now(), 'open')`,
      );

      const rows = await getOpenPredictions(client, 'station-A');

      expect(rows).toHaveLength(1);
      expect(rows[0].tflPredictionId).toBe('open-here');
    });
  });

  describe('applyDiff', () => {
    const pollTimestamp = new Date('2026-08-09T12:30:00Z');

    it('inserts a new prediction with first_seen_at = last_seen_at = pollTimestamp, observation_count = 1', async () => {
      const prediction: NormalizedPrediction = {
        tflPredictionId: 'new-1',
        stationNaptanId: 'station-A',
        lineId: 'circle',
        vehicleId: '001',
        destinationNaptanId: 'dest',
        destinationName: 'Somewhere',
        expectedArrival: new Date('2026-08-09T12:40:00Z'),
        timeToStation: 600,
      };
      const diff: PredictionDiff = { toInsert: [prediction], toUpdate: [], toResolve: [] };

      await applyDiff(client, diff, pollTimestamp);

      const rows = await getOpenPredictions(client, 'station-A');
      expect(rows).toHaveLength(1);
      expect(rows[0].firstSeenAt).toEqual(pollTimestamp);
      expect(rows[0].lastSeenAt).toEqual(pollTimestamp);
      expect(rows[0].observationCount).toBe(1);
    });

    it('updates a matched row: refreshes last_seen_at/eta and increments observation_count, leaves first_seen_at alone (invariant 8)', async () => {
      const insertResult = await client.query(
        `INSERT INTO arrival_predictions
          (tfl_prediction_id, station_naptan_id, line_id, first_seen_at, last_seen_at, last_seen_eta, observation_count, status)
         VALUES ('existing', 'station-A', 'circle', '2026-08-09T12:00:00Z', '2026-08-09T12:00:00Z', '2026-08-09T12:10:00Z', 1, 'open')
         RETURNING id`,
      );
      const rowId = insertResult.rows[0].id;
      const prediction: NormalizedPrediction = {
        tflPredictionId: 'existing',
        stationNaptanId: 'station-A',
        lineId: 'circle',
        vehicleId: null,
        destinationNaptanId: null,
        destinationName: null,
        expectedArrival: new Date('2026-08-09T12:35:00Z'),
        timeToStation: 300,
      };
      const diff: PredictionDiff = {
        toInsert: [],
        toUpdate: [{ rowId, prediction }],
        toResolve: [],
      };

      await applyDiff(client, diff, pollTimestamp);

      const rows = await getOpenPredictions(client, 'station-A');
      expect(rows[0].firstSeenAt).toEqual(new Date('2026-08-09T12:00:00Z'));
      expect(rows[0].lastSeenAt).toEqual(pollTimestamp);
      expect(rows[0].lastSeenEta).toEqual(new Date('2026-08-09T12:35:00Z'));
      expect(rows[0].observationCount).toBe(2);
    });

    it('resolves a row: sets status and resolved_at, leaves last_seen_at/eta untouched (invariant 9 setup)', async () => {
      const lastSeenAt = new Date('2026-08-09T12:00:00Z');
      const insertResult = await client.query(
        `INSERT INTO arrival_predictions
          (tfl_prediction_id, station_naptan_id, line_id, first_seen_at, last_seen_at, last_seen_eta, status)
         VALUES ('to-resolve', 'station-A', 'circle', $1, $1, $1, 'open')
         RETURNING id`,
        [lastSeenAt],
      );
      const rowId = insertResult.rows[0].id;
      const diff: PredictionDiff = { toInsert: [], toUpdate: [], toResolve: [{ rowId }] };

      await applyDiff(client, diff, pollTimestamp);

      const result = await client.query('SELECT * FROM arrival_predictions WHERE id = $1', [rowId]);
      const row = result.rows[0];
      expect(row.status).toBe('resolved');
      expect(new Date(row.resolved_at).getTime()).toBe(pollTimestamp.getTime());
      expect(new Date(row.last_seen_at).getTime()).toBe(lastSeenAt.getTime());
      // invariant 9: resolved_at strictly later than last_seen_at
      expect(new Date(row.resolved_at).getTime()).toBeGreaterThan(new Date(row.last_seen_at).getTime());

      const openRows = await getOpenPredictions(client, 'station-A');
      expect(openRows).toHaveLength(0);
    });
  });

  describe('poll_runs recording', () => {
    let db: TestDatabase;
    let client: PoolClient;

    beforeAll(async () => {
      db = await startTestDatabase();
    });

    afterAll(async () => {
      await stopTestDatabase(db);
    });

    beforeEach(async () => {
      client = await db.pool.connect();
      await client.query('TRUNCATE arrival_predictions, poll_runs');
    });

    afterEach(() => {
      client.release();
    });

    it('recordPollSuccess writes a success row with all counts', async () => {
      const polledAt = new Date('2026-08-09T12:30:00Z');
      await recordPollSuccess(client, 'station-A', 42, 2, 3, polledAt);

      const result = await client.query('SELECT * FROM poll_runs');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        station_naptan_id: 'station-A',
        outcome: 'success',
        predictions_seen: 42,
        duplicate_id_groups: 2,
        ambiguous_prediction_pairs: 3,
        error_message: null,
      });
    });

    it('recordPollFailure writes a failure row with the error message and null counts', async () => {
      const polledAt = new Date('2026-08-09T12:30:00Z');
      await recordPollFailure(client, 'station-A', 'TfL API returned HTTP 503', polledAt);

      const result = await client.query('SELECT * FROM poll_runs');
      expect(result.rows[0]).toMatchObject({
        station_naptan_id: 'station-A',
        outcome: 'failure',
        error_message: 'TfL API returned HTTP 503',
        predictions_seen: null,
      });
    });
  });
});

// Regression coverage for the production crash mode: pg's Pool is an EventEmitter, and pg-pool
// emits 'error' on it whenever a connected client's socket drops (client.js's `end` handler ->
// makeIdleListener -> pool.emit('error')). An 'error' emit with no listener makes Node throw an
// uncaught exception, which killed the whole poll run before any station's failure could be
// recorded. See the first test below for the unguarded behavior this exists to prevent.
describe('attachPoolErrorHandler', () => {
  it('an unguarded pool throws on a dropped-connection error event (the hazard being fixed)', async () => {
    const pool = new Pool();
    try {
      expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).toThrow(
        'Connection terminated unexpectedly',
      );
    } finally {
      await pool.end();
    }
  });

  it('a guarded pool logs the dropped connection instead of throwing', async () => {
    const pool = new Pool();
    const log = jest.fn();
    attachPoolErrorHandler(pool, log);

    try {
      const error = new Error('Connection terminated unexpectedly');
      expect(() => pool.emit('error', error)).not.toThrow();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][1]).toBe(error);
    } finally {
      await pool.end();
    }
  });

  it('stays attached across repeated drops, so a run survives more than one', async () => {
    const pool = new Pool();
    const log = jest.fn();
    attachPoolErrorHandler(pool, log);

    try {
      expect(() => {
        pool.emit('error', new Error('first drop'));
        pool.emit('error', new Error('second drop'));
      }).not.toThrow();
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      await pool.end();
    }
  });
});
