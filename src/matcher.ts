import type { DiffResult, NormalizedPrediction, OpenPredictionRow } from './types';

export function computeDiff(
  openRows: OpenPredictionRow[],
  fetched: NormalizedPrediction[],
): DiffResult {
  const toInsert: NormalizedPrediction[] = [];
  const toUpdate: Array<{ rowId: string; prediction: NormalizedPrediction }> = [];
  const toResolve: Array<{ rowId: string }> = [];
  let duplicateIdGroups = 0;
  let ambiguousPredictionPairs = 0;

  const openById = groupBy(openRows, (r) => r.tflPredictionId);
  const fetchedById = groupBy(fetched, (p) => p.tflPredictionId);
  const allIds = new Set<string>([...openById.keys(), ...fetchedById.keys()]);

  for (const id of allIds) {
    const openGroup = [...(openById.get(id) ?? [])].sort(
      (a, b) => a.lastSeenEta.getTime() - b.lastSeenEta.getTime(),
    );
    const fetchedGroup = [...(fetchedById.get(id) ?? [])].sort(
      (a, b) => a.expectedArrival.getTime() - b.expectedArrival.getTime(),
    );

    if (fetchedGroup.length > 1) {
      duplicateIdGroups++;
    }

    const pairCount = Math.min(openGroup.length, fetchedGroup.length);
    const isAmbiguousGroup = openGroup.length > 1 || fetchedGroup.length > 1;
    if (isAmbiguousGroup) {
      ambiguousPredictionPairs += pairCount;
    }

    for (let i = 0; i < pairCount; i++) {
      toUpdate.push({ rowId: openGroup[i].id, prediction: fetchedGroup[i] });
    }
    for (let i = pairCount; i < fetchedGroup.length; i++) {
      toInsert.push(fetchedGroup[i]);
    }
    for (let i = pairCount; i < openGroup.length; i++) {
      toResolve.push({ rowId: openGroup[i].id });
    }
  }

  return { diff: { toInsert, toUpdate, toResolve }, duplicateIdGroups, ambiguousPredictionPairs };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = map.get(k);
    if (existing) {
      existing.push(item);
    } else {
      map.set(k, [item]);
    }
  }
  return map;
}
