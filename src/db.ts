import type { Pool, PoolClient } from 'pg';
import type { OpenPredictionRow, PredictionDiff } from './types';

export async function getOpenPredictions(
  client: PoolClient,
  stationNaptanId: string,
): Promise<OpenPredictionRow[]> {
  const result = await client.query(
    `SELECT id, tfl_prediction_id, station_naptan_id, line_id, vehicle_id,
            destination_naptan_id, destination_name, first_seen_at, last_seen_at,
            last_seen_eta, last_seen_time_to_station, observation_count
     FROM arrival_predictions
     WHERE station_naptan_id = $1 AND status = 'open'`,
    [stationNaptanId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    tflPredictionId: row.tfl_prediction_id,
    stationNaptanId: row.station_naptan_id,
    lineId: row.line_id,
    vehicleId: row.vehicle_id,
    destinationNaptanId: row.destination_naptan_id,
    destinationName: row.destination_name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastSeenEta: row.last_seen_eta,
    lastSeenTimeToStation: row.last_seen_time_to_station,
    observationCount: row.observation_count,
  }));
}

export async function applyDiff(
  client: PoolClient,
  diff: PredictionDiff,
  pollTimestamp: Date,
): Promise<void> {
  for (const prediction of diff.toInsert) {
    await client.query(
      `INSERT INTO arrival_predictions
        (tfl_prediction_id, station_naptan_id, line_id, vehicle_id, destination_naptan_id,
         destination_name, first_seen_at, last_seen_at, last_seen_eta, last_seen_time_to_station,
         observation_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, 1, 'open')`,
      [
        prediction.tflPredictionId,
        prediction.stationNaptanId,
        prediction.lineId,
        prediction.vehicleId,
        prediction.destinationNaptanId,
        prediction.destinationName,
        pollTimestamp,
        prediction.expectedArrival,
        prediction.timeToStation,
      ],
    );
  }

  for (const { rowId, prediction } of diff.toUpdate) {
    await client.query(
      `UPDATE arrival_predictions
       SET last_seen_at = $1, last_seen_eta = $2, last_seen_time_to_station = $3,
           observation_count = observation_count + 1
       WHERE id = $4`,
      [pollTimestamp, prediction.expectedArrival, prediction.timeToStation, rowId],
    );
  }

  for (const { rowId } of diff.toResolve) {
    await client.query(
      `UPDATE arrival_predictions SET status = 'resolved', resolved_at = $1 WHERE id = $2`,
      [pollTimestamp, rowId],
    );
  }
}

export async function recordPollSuccess(
  client: PoolClient,
  stationNaptanId: string,
  predictionsSeen: number,
  duplicateIdGroups: number,
  ambiguousPredictionPairs: number,
  polledAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO poll_runs
      (station_naptan_id, polled_at, outcome, predictions_seen, duplicate_id_groups, ambiguous_prediction_pairs)
     VALUES ($1, $2, 'success', $3, $4, $5)`,
    [stationNaptanId, polledAt, predictionsSeen, duplicateIdGroups, ambiguousPredictionPairs],
  );
}

export async function recordPollFailure(
  client: PoolClient,
  stationNaptanId: string,
  errorMessage: string,
  polledAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO poll_runs (station_naptan_id, polled_at, outcome, error_message)
     VALUES ($1, $2, 'failure', $3)`,
    [stationNaptanId, polledAt, errorMessage],
  );
}

export type PoolErrorLogger = (message: string, error: Error) => void;

/**
 * pg's Pool is an EventEmitter, and pg-pool emits 'error' on it whenever a *connected* client's
 * socket drops — including while that client sits idle between stations. Node throws an uncaught
 * exception on an 'error' emit with no listener, so a database-side disconnect used to kill the
 * whole poll run outright: the process died on the same tick, before pollStation()'s own catch
 * could roll back, record the failure in poll_runs, or let the remaining stations run.
 *
 * Attaching a listener downgrades that to a logged event. pg-pool has already evicted the dead
 * client by the time it emits, so the next station just gets a fresh one, and an in-flight query
 * still rejects into pollStation()'s normal per-station failure path.
 */
export function attachPoolErrorHandler(pool: Pool, log: PoolErrorLogger = console.error): void {
  pool.on('error', (error: Error) => {
    log('[tfl-pulse] database connection dropped; pool evicted the client and will reconnect', error);
  });
}

export interface HeldClient {
  client: PoolClient;
  /** Returns the client to the pool, discarding it if its connection died while held. */
  release: () => void;
}

/**
 * Checks a client out of the pool with an 'error' listener attached for as long as it is held.
 *
 * pg-pool removes a client's own 'error' listener for exactly the window in which it is checked
 * out (see _acquireClient in pg-pool), on the assumption that errors will surface through the
 * query in flight. When the socket dies with no query in flight — between statements of a
 * transaction, or while the caller is doing CPU work such as computeDiff — there is nothing to
 * reject, so pg emits 'error' on a Client with no listeners and Node turns that into an uncaught
 * exception that kills the process. attachPoolErrorHandler() cannot help: the pool-level event
 * fires only for idle clients, and this client is not idle.
 *
 * With a listener attached the drop is logged instead, and the next query on the dead client
 * rejects normally, so it reaches the caller's existing error handling as an ordinary failure.
 */
export async function acquireClient(
  pool: Pool,
  label: string,
  log: PoolErrorLogger = console.error,
): Promise<HeldClient> {
  const client = await pool.connect();
  let connectionError: Error | undefined;

  const onError = (error: Error) => {
    connectionError = error;
    log(`[tfl-pulse] ${label}: database connection dropped while the client was checked out`, error);
  };
  client.on('error', onError);

  return {
    client,
    release: () => {
      client.removeListener('error', onError);
      // Handing the error to release() tells pg-pool to destroy this client rather than return a
      // dead connection to the pool for the next caller to pick up.
      client.release(connectionError);
    },
  };
}
