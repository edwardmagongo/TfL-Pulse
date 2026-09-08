import { Pool } from 'pg';
import { runPollCycle, isRunFailure } from '../src/ingest';
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
    const outcomes = await runPollCycle(pool);
    for (const outcome of outcomes) {
      if (outcome.outcome === 'success') {
        console.log(
          `[ok] ${outcome.stationNaptanId}: ${outcome.predictionsSeen} predictions, ` +
            `${outcome.duplicateIdGroups} duplicate-id groups`,
        );
      } else {
        console.error(`[fail] ${outcome.stationNaptanId}: ${outcome.errorMessage}`);
      }
    }
    // Partial failures still print [fail] above and are recorded in poll_runs; only a run in which
    // every station failed exits non-zero. See isRunFailure().
    process.exitCode = isRunFailure(outcomes) ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Unhandled error in poll run:', error);
  process.exitCode = 1;
});
