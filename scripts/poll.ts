import { Pool } from 'pg';
import { runPollCycle } from '../src/ingest';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString });
  try {
    const outcomes = await runPollCycle(pool);
    let anyFailed = false;
    for (const outcome of outcomes) {
      if (outcome.outcome === 'success') {
        console.log(
          `[ok] ${outcome.stationNaptanId}: ${outcome.predictionsSeen} predictions, ` +
            `${outcome.duplicateIdGroups} duplicate-id groups`,
        );
      } else {
        anyFailed = true;
        console.error(`[fail] ${outcome.stationNaptanId}: ${outcome.errorMessage}`);
      }
    }
    process.exitCode = anyFailed ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Unhandled error in poll run:', error);
  process.exitCode = 1;
});
