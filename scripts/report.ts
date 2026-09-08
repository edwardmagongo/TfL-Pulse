import { Pool } from 'pg';
import { attachPoolErrorHandler } from '../src/db';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString });
  attachPoolErrorHandler(pool);
  try {
    const stationCount = await pool.query(
      `SELECT count(DISTINCT station_naptan_id)::int AS count FROM poll_runs`,
    );
    const pollGaps = await pool.query(
      `SELECT avg(extract(epoch FROM gap))::float AS mean_seconds
       FROM (
         SELECT polled_at - lag(polled_at) OVER (PARTITION BY station_naptan_id ORDER BY polled_at) AS gap
         FROM poll_runs
       ) gaps
       WHERE gap IS NOT NULL`,
    );
    const meanGapMinutes = pollGaps.rows[0].mean_seconds != null ? pollGaps.rows[0].mean_seconds / 60 : null;

    const pollStats = await pool.query(
      `SELECT outcome, count(*)::int AS count FROM poll_runs GROUP BY outcome`,
    );
    const successCount = pollStats.rows.find((r) => r.outcome === 'success')?.count ?? 0;
    const failureCount = pollStats.rows.find((r) => r.outcome === 'failure')?.count ?? 0;
    const totalPolls = successCount + failureCount;
    const pct = (n: number) => (totalPolls > 0 ? ((n / totalPolls) * 100).toFixed(1) : '0.0');

    const predictionsIngested = await pool.query(`SELECT count(*)::int AS count FROM arrival_predictions`);
    const lifecycles = await pool.query(
      `SELECT count(*)::int AS count FROM arrival_predictions WHERE status = 'resolved'`,
    );
    const meanObservations = await pool.query(`SELECT avg(observation_count)::float AS mean FROM arrival_predictions`);
    const duplicateIdGroups = await pool.query(
      `SELECT coalesce(sum(duplicate_id_groups), 0)::int AS total FROM poll_runs WHERE outcome = 'success'`,
    );
    const ambiguousPairs = await pool.query(
      `SELECT coalesce(sum(ambiguous_prediction_pairs), 0)::int AS total FROM poll_runs WHERE outcome = 'success'`,
    );

    console.log(`Stations:                    ${stationCount.rows[0].count}`);
    console.log(
      `Poll frequency (observed):   ${meanGapMinutes != null ? `~${meanGapMinutes.toFixed(1)} min (mean gap between polls)` : 'n/a (fewer than 2 polls recorded)'}`,
    );
    console.log(`Successful polls:            ${pct(successCount)}% (${successCount}/${totalPolls})`);
    console.log(`Failed polls:                ${pct(failureCount)}% (${failureCount}/${totalPolls})`);
    console.log(`Predictions ingested:        ${predictionsIngested.rows[0].count}`);
    console.log(`Resolved prediction lifecycles: ${lifecycles.rows[0].count}`);
    console.log(`Mean observations/life:      ${(meanObservations.rows[0].mean ?? 0).toFixed(1)}`);
    console.log(`Duplicate-ID groups:         ${duplicateIdGroups.rows[0].total}`);
    console.log(`Ambiguous prediction pairs:  ${ambiguousPairs.rows[0].total}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
