import { describe, expect, it } from 'vitest';
import { addVertex, MAX_VERTICES, parcelShape, type LatLon } from '../../src/domain/parcel.ts';

/** Rectángulo de `wM` x `hM` metros con esquina suroeste en (lat, lon). */
function rect(lat: number, lon: number, wM: number, hM: number): LatLon[] {
  const dLat = (hM / 6_371_008.8) * (180 / Math.PI);
  const dLon = (wM / (6_371_008.8 * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
  return [
    { lat, lon },
    { lat, lon: lon + dLon },
    { lat: lat + dLat, lon: lon + dLon },
    { lat: lat + dLat, lon },
  ];
}

describe('parcelShape', () => {
  it('sin vértices no hay parcela', () => expect(parcelShape([])).toBeNull());

  it('un punto es su propio centro y no tiene área', () => {
    expect(parcelShape([{ lat: -6.77, lon: -79.84 }])).toEqual({ center: { lat: -6.77, lon: -79.84 }, hectares: null });
  });

  it('dos puntos: punto medio, sin área', () => {
    const s = parcelShape([{ lat: 10, lon: 20 }, { lat: 12, lon: 22 }])!;
    expect(s.center).toEqual({ lat: 11, lon: 21 });
    expect(s.hectares).toBeNull();
  });

  it.each([
    [-6.77, -79.84],
    [12.97, 77.59],
    [52.1, 5.1],
  ])('rectángulo de 100 x 200 m ≈ 2 ha en %s,%s, con el centro en el medio', (lat, lon) => {
    const pts = rect(lat, lon, 100, 200);
    const s = parcelShape(pts)!;
    expect(s.hectares).toBeCloseTo(2, 1);
    const mean = { lat: (pts[0]!.lat + pts[2]!.lat) / 2, lon: (pts[0]!.lon + pts[2]!.lon) / 2 };
    expect(s.center.lat).toBeCloseTo(mean.lat, 6);
    expect(s.center.lon).toBeCloseTo(mean.lon, 6);
  });

  it('triángulo: el centroide queda a un tercio de la altura', () => {
    const s = parcelShape([{ lat: 0, lon: 0 }, { lat: 0, lon: 0.003 }, { lat: 0.003, lon: 0 }])!;
    expect(s.center.lat).toBeCloseTo(0.001, 5);
    expect(s.center.lon).toBeCloseTo(0.001, 5);
    expect(s.hectares!).toBeGreaterThan(0);
  });

  it('el sentido horario o antihorario da la misma área', () => {
    const pts = rect(10, 10, 80, 80);
    expect(parcelShape([...pts].reverse())!.hectares).toBeCloseTo(parcelShape(pts)!.hectares!, 8);
  });

  it('puntos en línea: área 0, no NaN', () => {
    const s = parcelShape([{ lat: 1, lon: 1 }, { lat: 1, lon: 1.001 }, { lat: 1, lon: 1.002 }])!;
    expect(s.hectares).toBe(0);
    expect(Number.isFinite(s.center.lat)).toBe(true);
  });
});

describe('addVertex', () => {
  it('suma hasta el máximo y el clic siguiente reinicia', () => {
    let pts: LatLon[] = [];
    for (let i = 0; i < MAX_VERTICES; i++) pts = addVertex(pts, { lat: i, lon: i });
    expect(pts).toHaveLength(MAX_VERTICES);
    expect(addVertex(pts, { lat: 9, lon: 9 })).toEqual([{ lat: 9, lon: 9 }]);
  });
});
