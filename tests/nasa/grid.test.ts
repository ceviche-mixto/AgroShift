import { describe, expect, it } from 'vitest';
import {
  addDays,
  bboxes,
  cellCeres,
  cellFirms,
  cellGldas,
  cellIds,
  cellMerra2,
  cellSmap,
  coverageOf,
  daysInMonth,
  daysInclusive,
  distanceKm,
} from '../../src/services/nasa/grid.ts';

const CASES = [
  { name: 'Chiclayo', lat: -6.77, lon: -79.84 },
  { name: 'India', lat: 12.97, lon: 77.59 },
  { name: 'Kenia', lat: -1.29, lon: 36.82 },
];

describe('celdas por producto', () => {
  it('MERRA-2 y CERES coinciden con los cortes observados en la API de POWER', () => {
    // La API cambia de valor entre -6.8 y -6.7 (corte -6.75) y entre -80.3 y -80.4 / -79.7 y -79.6
    expect(cellMerra2(-6.77, -79.84)).toEqual({ cellId: 'merra2:-7:-80', lat: -7, lon: -80 });
    expect(cellMerra2(-6.7, -79.84).lat).toBe(-6.5);
    expect(cellMerra2(-6.77, -79.6).lon).toBe(-79.375);
    expect(cellCeres(-6.77, -79.84)).toEqual({ cellId: 'ceres1:-6.5:-79.5', lat: -6.5, lon: -79.5 });
    expect(cellCeres(-6.01, -79.0).lon).toBe(-78.5);
  });

  it('GLDAS 0.25 centra en x.125 como el ejemplo de GES DISC', () => {
    expect(cellGldas(45.125, -98.125).cellId).toBe('gldas025:45.125:-98.125');
    expect(cellGldas(-6.77, -79.84)).toMatchObject({ lat: -6.875, lon: -79.875 });
  });

  it('SMAP EASE-Grid 2.0 9 km: el centro está a menos de una celda y es estable', () => {
    for (const c of CASES) {
      const cell = cellSmap(c.lat, c.lon);
      expect(distanceKm(c.lat, c.lon, cell.lat, cell.lon)).toBeLessThan(7);
      expect(cellSmap(cell.lat, cell.lon).cellId).toBe(cell.cellId);
    }
    const corner = cellSmap(89.9, -179.99);
    expect(corner.cellId).toBe('ease2-9km:r0c0');
    expect(corner.lat).toBeCloseTo(84.656, 2);
    expect(cellSmap(-89.9, 179.99).cellId).toBe('ease2-9km:r1623c3855');
  });

  it('celdas vecinas distintas dan ids distintos; FIRMS usa 0.1°', () => {
    expect(cellSmap(-6.77, -79.84).cellId).not.toBe(cellSmap(-6.77, -79.6).cellId);
    expect(cellFirms(-6.77, -79.84).cellId).toBe('firms0.1:-6.8:-79.8');
    expect(cellIds('power', 12.97, 77.59)).toEqual(['merra2:13:77.5', 'ceres1:12.5:77.5']);
    expect(cellIds('complement', 0, 0)).toEqual([]);
  });

  it('la rejilla da la vuelta en el antimeridiano', () => {
    expect(cellMerra2(0, 179.9).lon).toBe(-180);
    expect(cellCeres(0, 179.9).lon).toBe(179.5);
    expect(cellCeres(0, 180).lon).toBe(-179.5);
  });
});

describe('geometría y fechas', () => {
  it('distancia haversine', () => {
    expect(distanceKm(0, 0, 0, 1)).toBeCloseTo(111.19, 1);
    expect(distanceKm(-6.77, -79.84, -6.77, -79.84)).toBe(0);
  });

  it('divide el rectángulo en el antimeridiano', () => {
    expect(bboxes(0, 0, 15)).toHaveLength(1);
    const east = bboxes(0, 179.95, 15);
    expect(east).toHaveLength(2);
    expect(east[0]?.[2]).toBe(180);
    expect(east[1]?.[0]).toBe(-180);
    const west = bboxes(0, -179.95, 15);
    expect(west).toHaveLength(2);
    expect(west[0]?.[0]).toBeGreaterThan(170);
  });

  it('fechas calendario', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(daysInclusive('2025-01-01', '2025-12-31')).toBe(365);
    expect(daysInclusive('2025-02-01', '2025-01-01')).toBe(0);
    expect(daysInMonth('2024-02')).toBe(29);
  });

  it('cobertura', () => {
    expect(coverageOf(0, 5).status).toBe('none');
    expect(coverageOf(3, 5).status).toBe('partial');
    expect(coverageOf(5, 5).status).toBe('complete');
  });
});
