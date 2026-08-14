import type { PoolClient } from 'pg';
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
