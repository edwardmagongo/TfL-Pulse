import { computeDiff } from './matcher';
import type { NormalizedPrediction, OpenPredictionRow } from './types';

function fetched(overrides: Partial<NormalizedPrediction> = {}): NormalizedPrediction {
  return {
    tflPredictionId: 'A',
    stationNaptanId: '940GZZLUKSX',
    lineId: 'circle',
    vehicleId: '001',
    destinationNaptanId: 'dest1',
    destinationName: 'Edgware Road',
    expectedArrival: new Date('2026-08-09T12:20:00Z'),
    timeToStation: 300,
    ...overrides,
  };
}

function openRow(overrides: Partial<OpenPredictionRow> = {}): OpenPredictionRow {
  return {
    id: 'row-1',
    tflPredictionId: 'A',
    stationNaptanId: '940GZZLUKSX',
    lineId: 'circle',
    vehicleId: '001',
    destinationNaptanId: 'dest1',
    destinationName: 'Edgware Road',
    firstSeenAt: new Date('2026-08-09T12:00:00Z'),
    lastSeenAt: new Date('2026-08-09T12:05:00Z'),
    lastSeenEta: new Date('2026-08-09T12:05:00Z'),
    lastSeenTimeToStation: 300,
    observationCount: 1,
    ...overrides,
  };
}

describe('computeDiff — basic 1:1 cases', () => {
  it('a fetched id with no matching open row is a new insert', () => {
    const result = computeDiff([], [fetched()]);

    expect(result.diff.toInsert).toEqual([fetched()]);
    expect(result.diff.toUpdate).toEqual([]);
    expect(result.diff.toResolve).toEqual([]);
    expect(result.duplicateIdGroups).toBe(0);
    expect(result.ambiguousPredictionPairs).toBe(0);
  });

  it('a fetched id matching one open row is an update, not an insert', () => {
    const result = computeDiff([openRow()], [fetched()]);

    expect(result.diff.toInsert).toEqual([]);
    expect(result.diff.toResolve).toEqual([]);
    expect(result.diff.toUpdate).toEqual([{ rowId: 'row-1', prediction: fetched() }]);
  });

  it('an open row with no matching fetched id is resolved', () => {
    const result = computeDiff([openRow()], []);

    expect(result.diff.toResolve).toEqual([{ rowId: 'row-1' }]);
    expect(result.diff.toInsert).toEqual([]);
    expect(result.diff.toUpdate).toEqual([]);
  });

  it('handles multiple independent ids in one poll correctly', () => {
    const openB = openRow({ id: 'row-b', tflPredictionId: 'B' });
    const fetchedA = fetched({ tflPredictionId: 'A' });
    // B is open but not fetched (resolves); A is fetched but not open (inserts)
    const result = computeDiff([openB], [fetchedA]);

    expect(result.diff.toInsert).toEqual([fetchedA]);
    expect(result.diff.toResolve).toEqual([{ rowId: 'row-b' }]);
  });
});
