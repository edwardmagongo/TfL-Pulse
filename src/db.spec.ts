import type { PoolClient } from 'pg';
import { startTestDatabase, stopTestDatabase, TestDatabase } from './test-helpers/postgres';
import { getOpenPredictions, applyDiff } from './db';
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
});
