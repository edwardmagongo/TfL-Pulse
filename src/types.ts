export interface RawTflPrediction {
  id: string;
  vehicleId?: string | null;
  naptanId: string;
  lineId: string;
  destinationNaptanId?: string | null;
  destinationName?: string | null;
  timeToStation: number;
  expectedArrival: string;
}

export interface NormalizedPrediction {
  tflPredictionId: string;
  stationNaptanId: string;
  lineId: string;
  vehicleId: string | null;
  destinationNaptanId: string | null;
  destinationName: string | null;
  expectedArrival: Date;
  timeToStation: number;
}

export interface OpenPredictionRow {
  id: string;
  tflPredictionId: string;
  stationNaptanId: string;
  lineId: string;
  vehicleId: string | null;
  destinationNaptanId: string | null;
  destinationName: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSeenEta: Date;
  lastSeenTimeToStation: number | null;
  observationCount: number;
}

export interface PredictionDiff {
  toInsert: NormalizedPrediction[];
  toUpdate: Array<{ rowId: string; prediction: NormalizedPrediction }>;
  toResolve: Array<{ rowId: string }>;
}

export interface DiffResult {
  diff: PredictionDiff;
  duplicateIdGroups: number;
  ambiguousPredictionPairs: number;
}

export interface Station {
  naptanId: string;
  name: string;
}

export type PollOutcome =
  | {
      outcome: 'success';
      stationNaptanId: string;
      predictionsSeen: number;
      duplicateIdGroups: number;
      ambiguousPredictionPairs: number;
    }
  | { outcome: 'failure'; stationNaptanId: string; errorMessage: string };
