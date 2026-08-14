import type { Pool } from 'pg';
import { fetchArrivals, STATIONS } from './tfl-client';
import { normalize } from './normalize';
import { computeDiff } from './matcher';
import { getOpenPredictions, applyDiff, recordPollSuccess, recordPollFailure } from './db';
import type { PollOutcome, Station } from './types';

export async function pollStation(pool: Pool, station: Station): Promise<PollOutcome> {
  const pollTimestamp = new Date();

  let raw;
  try {
    raw = await fetchArrivals(station.naptanId);
  } catch (error) {
    const errorMessage = (error as Error).message;
    let client;
    try {
      client = await pool.connect();
    } catch (connectError) {
      console.error(
        `[tfl-pulse] ${station.naptanId}: failed to acquire a client to record poll failure after original fetch error "${errorMessage}"`,
        connectError,
      );
      return { outcome: 'failure', stationNaptanId: station.naptanId, errorMessage };
    }
    try {
      await recordPollFailure(client, station.naptanId, errorMessage, pollTimestamp);
    } catch (secondaryError) {
      console.error(
        `[tfl-pulse] ${station.naptanId}: failed to record poll failure after original fetch error "${errorMessage}"`,
        secondaryError,
      );
    } finally {
      client.release();
    }
    return { outcome: 'failure', stationNaptanId: station.naptanId, errorMessage };
  }

  const { normalized, skipped } = normalize(raw);
  if (skipped > 0) {
    console.warn(`[tfl-pulse] ${station.naptanId}: skipped ${skipped} malformed prediction(s)`);
  }
  // The write key must always match the read key used by getOpenPredictions(station.naptanId):
  // override each prediction's stationNaptanId with the station we actually polled, rather than
  // trusting TfL's per-prediction naptanId field, so a row can never be written under one key and
  // become unreadable under another.
  for (const prediction of normalized) {
    prediction.stationNaptanId = station.naptanId;
  }

  let client;
  try {
    client = await pool.connect();
  } catch (connectError) {
    const errorMessage = (connectError as Error).message;
    console.error(`[tfl-pulse] ${station.naptanId}: failed to acquire a client for polling`, connectError);
    return { outcome: 'failure', stationNaptanId: station.naptanId, errorMessage };
  }
  try {
    await client.query('BEGIN');
    const openRows = await getOpenPredictions(client, station.naptanId);
    const { diff, duplicateIdGroups, ambiguousPredictionPairs } = computeDiff(openRows, normalized);
    await applyDiff(client, diff, pollTimestamp);
    await recordPollSuccess(
      client,
      station.naptanId,
      normalized.length,
      duplicateIdGroups,
      ambiguousPredictionPairs,
      pollTimestamp,
    );
    await client.query('COMMIT');
    return {
      outcome: 'success',
      stationNaptanId: station.naptanId,
      predictionsSeen: normalized.length,
      duplicateIdGroups,
      ambiguousPredictionPairs,
    };
  } catch (error) {
    const errorMessage = (error as Error).message;
    try {
      await client.query('ROLLBACK');
      await recordPollFailure(client, station.naptanId, errorMessage, pollTimestamp);
    } catch (secondaryError) {
      console.error(
        `[tfl-pulse] ${station.naptanId}: failed to roll back/record poll failure after original error "${errorMessage}"`,
        secondaryError,
      );
    }
    return { outcome: 'failure', stationNaptanId: station.naptanId, errorMessage };
  } finally {
    client.release();
  }
}

export async function runPollCycle(pool: Pool, stations: Station[] = STATIONS): Promise<PollOutcome[]> {
  const outcomes: PollOutcome[] = [];
  for (const station of stations) {
    outcomes.push(await pollStation(pool, station));
  }
  return outcomes;
}
