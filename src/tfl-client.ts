import type { RawTflPrediction, Station } from './types';

export const STATIONS: Station[] = [
  { naptanId: '940GZZLUKSX', name: "King's Cross St Pancras" },
  { naptanId: '940GZZLUOXC', name: 'Oxford Circus' },
  { naptanId: '940GZZLULVT', name: 'Liverpool Street' },
  { naptanId: '940GZZLUWLO', name: 'Waterloo' },
  { naptanId: '940GZZLUVIC', name: 'Victoria' },
  { naptanId: '940GZZLUSTD', name: 'Stratford' },
];

const DEFAULT_RETRY_DELAY_MS = 2000;

export async function fetchArrivals(
  naptanId: string,
  retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
): Promise<RawTflPrediction[]> {
  try {
    return await fetchOnce(naptanId);
  } catch {
    await sleep(retryDelayMs);
    try {
      return await fetchOnce(naptanId);
    } catch (secondError) {
      throw new Error(
        `TfL fetch failed for station ${naptanId} after 1 retry: ${(secondError as Error).message}`,
      );
    }
  }
}

async function fetchOnce(naptanId: string): Promise<RawTflPrediction[]> {
  const response = await fetch(`https://api.tfl.gov.uk/StopPoint/${naptanId}/Arrivals`);
  if (!response.ok) {
    throw new Error(`TfL API returned HTTP ${response.status}`);
  }
  return (await response.json()) as RawTflPrediction[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
