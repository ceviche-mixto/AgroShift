import { describe, expect, it, vi } from 'vitest';
import { evidenceRecordSchema } from '../../src/domain/schemas.ts';
import { fetchPower, normalizePower, powerCellId, POWER_VARIABLES } from '../../src/services/nasa/power.ts';

// Forma real de la respuesta de POWER v2.10.3 (ver NASA POWER Daily API), recortada a 5 días.
const response = (over: Record<string, Record<string, number>> = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-79.84, -6.77, 33.93] },
  properties: {
    parameter: {
      PRECTOTCORR: { '20251230': 0.4, '20251231': 0.1, '20260101': -999, '20260102': -999 },
      T2M: { '20251230': 21.1, '20251231': 21.3, '20260101': 21.5, '20260102': -999 },
      T2M_MIN: { '20251230': 19.1, '20251231': 19.3, '20260101': 19.5, '20260102': -999 },
      T2M_MAX: { '20251230': 23.1, '20251231': 23.3, '20260101': 23.5, '20260102': -999 },
      RH2M: { '20251230': 90, '20251231': 91, '20260101': 92, '20260102': -999 },
      ALLSKY_SFC_SW_DWN: { '20251230': 15.1, '20251231': 16.2, '20260101': -999, '20260102': -999 },
      ...over,
    },
  },
  header: { api: { version: 'v2.10.3', name: 'POWER Daily API' }, sources: ['MERRA2', 'SYN1DEG'], fill_value: -999.0, time_standard: 'LST' },
  parameters: {
    PRECTOTCORR: { units: 'mm/day' },
    T2M: { units: 'C' },
    T2M_MIN: { units: 'C' },
    T2M_MAX: { units: 'C' },
    RH2M: { units: '%' },
    ALLSKY_SFC_SW_DWN: { units: 'MJ/m^2/day' },
  },
});
const q = { lat: -6.77, lon: -79.84, window: { start: '2025-12-30', end: '2026-01-02' } } as const;
const now = new Date('2026-01-02T12:00:00Z');

describe('normalizePower', () => {
  const { records, observedUntil } = normalizePower(response(), q, q.window, now);
  const byVar = Object.fromEntries(records.map((r) => [r.variable, r]));
  const values = (v: string) => (byVar[v]?.data.type === 'series' ? byVar[v].data.points.map((p) => p.v) : []);

  it('entrega las variables con unidades de la respuesta', () => {
    expect(records.map((r) => r.variable)).toEqual([...POWER_VARIABLES]);
    expect(byVar.PRECTOTCORR?.unit).toBe('mm/day');
    expect(byVar.T2M?.unit).toBe('C');
    expect(byVar.RH2M?.unit).toBe('%');
    expect(byVar.ALLSKY_SFC_SW_DWN?.unit).toBe('MJ/m^2/day');
    for (const r of records) expect(evidenceRecordSchema.safeParse(r).success).toBe(true);
  });

  it('el relleno -999 es null, nunca 0, y se declara en la cobertura', () => {
    expect(values('PRECTOTCORR')).toEqual([0.4, 0.1, null, null]);
    expect(values('T2M')).toEqual([21.1, 21.3, 21.5, null]);
    expect(byVar.PRECTOTCORR?.coverage).toMatchObject({ status: 'partial', validCount: 2, expectedCount: 4 });
    expect(byVar.PRECTOTCORR?.coverage.quality.join('|')).toContain('Sin dato posterior a 2025-12-31');
    expect(observedUntil).toBe('2026-01-01');
  });

  it('cada variable conserva la resolución y la celda de su rejilla', () => {
    expect(byVar.T2M?.grid).toMatchObject({ cellId: 'merra2:-7:-80', nativeResolution: '0.5° x 0.625°' });
    expect(byVar.ALLSKY_SFC_SW_DWN?.grid).toMatchObject({ cellId: 'ceres1:-6.5:-79.5', nativeResolution: '1° x 1°' });
    expect(powerCellId(-6.77, -79.84)).toBe('merra2:-7:-80|ceres1:-6.5:-79.5');
    expect(byVar.T2M?.dataset.version).toBe('v2.10.3');
    expect(byVar.T2M?.kind).toBe('modeled_estimate');
  });

  it('una variable ausente o sin unidad se omite sin inventarla', () => {
    const raw = response();
    delete (raw.properties.parameter as Record<string, unknown>).RH2M;
    delete (raw.parameters as Record<string, unknown>).T2M_MAX;
    const out = normalizePower(raw, q, q.window, now).records.map((r) => r.variable);
    expect(out).toEqual(['PRECTOTCORR', 'T2M', 'T2M_MIN', 'ALLSKY_SFC_SW_DWN']);
  });

  it('rechaza una respuesta con otra forma', () => {
    expect(() => normalizePower({ properties: {} }, q, q.window, now)).toThrow();
  });
});

describe('fetchPower', () => {
  it('pide community=AG, fechas YYYYMMDD y las seis variables, y recorta a hoy', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(response())));
    const out = await fetchPower({ ...q, window: { start: '2025-12-30', end: '2026-12-31' } }, { fetch: f, now });
    const url = new URL(f.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/temporal/daily/point');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      community: 'AG',
      parameters: POWER_VARIABLES.join(','),
      latitude: '-6.77',
      longitude: '-79.84',
      start: '20251230',
      end: '20260102',
      format: 'JSON',
    });
    expect(out.records[0]?.period).toEqual({ start: '2025-12-30', end: '2026-01-02' });
  });

  it('una ventana futura no consulta', async () => {
    const f = vi.fn();
    const out = await fetchPower({ ...q, window: { start: '2027-01-01', end: '2027-01-31' } }, { fetch: f, now });
    expect(out.records).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});
