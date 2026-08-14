import { z } from 'zod';
import type { NormalizedPrediction } from './types';

const RawPredictionSchema = z.object({
  id: z.string().min(1),
  naptanId: z.string().min(1),
  lineId: z.string().min(1),
  vehicleId: z.string().nullish(),
  destinationNaptanId: z.string().nullish(),
  destinationName: z.string().nullish(),
  timeToStation: z.number(),
  expectedArrival: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date'),
});

export interface NormalizeResult {
  normalized: NormalizedPrediction[];
  skipped: number;
}

export function normalize(raw: unknown[]): NormalizeResult {
  const normalized: NormalizedPrediction[] = [];
  let skipped = 0;

  for (const item of raw) {
    const parsed = RawPredictionSchema.safeParse(item);
    if (!parsed.success) {
      skipped++;
      continue;
    }

    const p = parsed.data;
    normalized.push({
      tflPredictionId: p.id,
      stationNaptanId: p.naptanId,
      lineId: p.lineId,
      vehicleId: p.vehicleId ?? null,
      destinationNaptanId: p.destinationNaptanId ?? null,
      destinationName: p.destinationName ?? null,
      expectedArrival: new Date(p.expectedArrival),
      timeToStation: p.timeToStation,
    });
  }

  return { normalized, skipped };
}
