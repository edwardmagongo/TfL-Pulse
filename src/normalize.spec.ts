import { normalize } from './normalize';

const validPrediction = {
  id: 'abc123',
  vehicleId: '001',
  naptanId: '940GZZLUKSX',
  lineId: 'circle',
  destinationNaptanId: '940GZZLUERC',
  destinationName: 'Edgware Road',
  timeToStation: 120,
  expectedArrival: '2026-08-09T14:18:55Z',
};

describe('normalize', () => {
  it('maps a valid prediction to the normalized shape', () => {
    const { normalized, skipped } = normalize([validPrediction]);

    expect(skipped).toBe(0);
    expect(normalized).toEqual([
      {
        tflPredictionId: 'abc123',
        stationNaptanId: '940GZZLUKSX',
        lineId: 'circle',
        vehicleId: '001',
        destinationNaptanId: '940GZZLUERC',
        destinationName: 'Edgware Road',
        expectedArrival: new Date('2026-08-09T14:18:55Z'),
        timeToStation: 120,
      },
    ]);
  });

  it('defaults optional fields to null when absent', () => {
    const { normalized } = normalize([
      { id: 'x', naptanId: 'n1', lineId: 'circle', timeToStation: 1, expectedArrival: '2026-08-09T14:18:55Z' },
    ]);

    expect(normalized[0].vehicleId).toBeNull();
    expect(normalized[0].destinationNaptanId).toBeNull();
    expect(normalized[0].destinationName).toBeNull();
  });

  it('skips a prediction missing a required field, without affecting the rest of the batch', () => {
    const missingLineId = { ...validPrediction, lineId: undefined };
    const { normalized, skipped } = normalize([missingLineId, validPrediction]);

    expect(skipped).toBe(1);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].tflPredictionId).toBe('abc123');
  });

  it('skips a prediction with an unparseable expectedArrival', () => {
    const badDate = { ...validPrediction, expectedArrival: 'not-a-date' };
    const { normalized, skipped } = normalize([badDate]);

    expect(skipped).toBe(1);
    expect(normalized).toHaveLength(0);
  });

  it('skips a prediction with a non-numeric timeToStation', () => {
    const badTime = { ...validPrediction, timeToStation: 'soon' };
    const { skipped } = normalize([badTime]);

    expect(skipped).toBe(1);
  });
});
