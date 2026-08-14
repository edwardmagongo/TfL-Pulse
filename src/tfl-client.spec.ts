import { fetchArrivals, STATIONS } from './tfl-client';

describe('STATIONS', () => {
  it('has exactly the 6 verified stations', () => {
    expect(STATIONS).toEqual([
      { naptanId: '940GZZLUKSX', name: "King's Cross St Pancras" },
      { naptanId: '940GZZLUOXC', name: 'Oxford Circus' },
      { naptanId: '940GZZLULVT', name: 'Liverpool Street' },
      { naptanId: '940GZZLUWLO', name: 'Waterloo' },
      { naptanId: '940GZZLUVIC', name: 'Victoria' },
      { naptanId: '940GZZLUSTD', name: 'Stratford' },
    ]);
  });
});

describe('fetchArrivals', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the parsed predictions on a successful first call', async () => {
    const predictions = [{ id: '1', naptanId: '940GZZLUKSX', lineId: 'circle', timeToStation: 60, expectedArrival: '2026-08-09T12:00:00Z' }];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => predictions,
    }) as unknown as typeof fetch;

    const result = await fetchArrivals('940GZZLUKSX', 0);

    expect(result).toEqual(predictions);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('https://api.tfl.gov.uk/StopPoint/940GZZLUKSX/Arrivals');
  });

  it('retries exactly once after a failure, and succeeds if the retry works', async () => {
    const predictions = [{ id: '1', naptanId: '940GZZLUKSX', lineId: 'circle', timeToStation: 60, expectedArrival: '2026-08-09T12:00:00Z' }];
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => predictions }) as unknown as typeof fetch;

    const result = await fetchArrivals('940GZZLUKSX', 0);

    expect(result).toEqual(predictions);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws after the retry also fails — never a third attempt', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;

    await expect(fetchArrivals('940GZZLUKSX', 0)).rejects.toThrow(
      /TfL fetch failed for station 940GZZLUKSX after 1 retry/,
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
