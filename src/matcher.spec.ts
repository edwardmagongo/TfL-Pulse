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

describe('computeDiff — ambiguous shared-id case (invariants 5, 6)', () => {
  it('pairs two open rows and two fetched predictions sharing an id positionally by expectedArrival', () => {
    const openEarly = openRow({ id: 'open-early', lastSeenEta: new Date('2026-08-09T12:05:00Z') });
    const openLate = openRow({ id: 'open-late', lastSeenEta: new Date('2026-08-09T12:25:00Z') });
    const fetchedEarly = fetched({ expectedArrival: new Date('2026-08-09T12:20:00Z') });
    const fetchedLate = fetched({ expectedArrival: new Date('2026-08-09T12:40:00Z') });

    // Fed in scrambled order deliberately — the matcher must sort, not rely on input order.
    const result = computeDiff([openLate, openEarly], [fetchedLate, fetchedEarly]);

    expect(result.diff.toUpdate).toEqual([
      { rowId: 'open-early', prediction: fetchedEarly },
      { rowId: 'open-late', prediction: fetchedLate },
    ]);
    expect(result.diff.toInsert).toEqual([]);
    expect(result.diff.toResolve).toEqual([]);
  });

  it('never produces a many-to-one match: a fetched prediction group of 3 against 1 open row updates one and inserts two', () => {
    const open = openRow({ id: 'only-open' });
    const f1 = fetched({ expectedArrival: new Date('2026-08-09T12:10:00Z') });
    const f2 = fetched({ expectedArrival: new Date('2026-08-09T12:20:00Z') });
    const f3 = fetched({ expectedArrival: new Date('2026-08-09T12:30:00Z') });

    const result = computeDiff([open], [f3, f1, f2]);

    expect(result.diff.toUpdate).toEqual([{ rowId: 'only-open', prediction: f1 }]);
    expect(result.diff.toInsert).toEqual([f2, f3]);
    expect(result.diff.toResolve).toEqual([]);
    // Every fetched prediction and every open row appears in at most one bucket:
    const totalHandled =
      2 * result.diff.toUpdate.length + result.diff.toInsert.length + result.diff.toResolve.length;
    expect(totalHandled).toBe(4); // Each update = 2 items (row + prediction); 2*1 + 2 + 0 = 4
  });

  it('counts duplicateIdGroups and ambiguousPredictionPairs correctly for a real ambiguous poll', () => {
    const openEarly = openRow({ id: 'open-early', lastSeenEta: new Date('2026-08-09T12:05:00Z') });
    const openLate = openRow({ id: 'open-late', lastSeenEta: new Date('2026-08-09T12:25:00Z') });
    const fetchedEarly = fetched({ expectedArrival: new Date('2026-08-09T12:20:00Z') });
    const fetchedLate = fetched({ expectedArrival: new Date('2026-08-09T12:40:00Z') });
    const unrelated = fetched({ tflPredictionId: 'Z', expectedArrival: new Date('2026-08-09T13:00:00Z') });

    const result = computeDiff([openEarly, openLate], [fetchedEarly, fetchedLate, unrelated]);

    // One ambiguous group (id "A", size 2) plus one ordinary singleton group (id "Z").
    expect(result.duplicateIdGroups).toBe(1);
    expect(result.ambiguousPredictionPairs).toBe(2);
  });
});
