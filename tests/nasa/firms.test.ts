import { describe, expect, it, vi } from 'vitest';
import { activeFirmsAlert, fetchFirms, firmsPeriod, normalizeFirms } from '../../src/services/nasa/firms.ts';

const HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';
const row = (lat: number, lon: number, date: string, time: string, conf: string) =>
  `${lat},${lon},333,0.4,0.4,${date},${time},N20,VIIRS,${conf},2.0NRT,300,4.6,D`;
const AVAIL = (max: string) => `data_id,min_date,max_date\nVIIRS_NOAA20_NRT,2026-08-01,${max}`;
const q = { lat: -6.77, lon: -79.84, window: { start: '2025-01-01', end: '2025-12-31' } } as const;
const now = new Date('2026-11-14T12:00:00Z');
const period = firmsPeriod(now);

describe('normalizeFirms', () => {
  it('conserva hora UTC, confianza y distancia, y filtra por distancia a la celda', () => {
    const csv = [HEADER, row(-6.81, -79.8, '2026-11-14', '824', 'n'), row(-6.9, -79.8, '2026-11-13', '1847', 'h'), row(-7.5, -79.8, '2026-11-14', '900', 'h')].join('\n');
    const { records } = normalizeFirms([csv], AVAIL('2026-11-14'), q, period, now);
    const rec = records[0]!;
    const items = rec.data.type === 'detections' ? rec.data.items : [];
    expect(items).toHaveLength(2); // el de -7.5 está a ~55 km
    expect(items.map((i) => i.acquiredAt).sort()).toEqual(['2026-11-13T18:47:00Z', '2026-11-14T08:24:00Z']);
    expect(items.every((i) => i.distanceKm >= 0 && i.distanceKm <= 15)).toBe(true);
    expect(items.map((i) => i.confidence).sort()).toEqual(['high', 'nominal']);
    expect(rec.coverage.status).toBe('complete');
    expect(rec.dataset).toMatchObject({ id: 'VIIRS_NOAA20_NRT', version: '2.0NRT' });
    expect(rec.limitations.join(' ')).toMatch(/posible foco de calor/);
  });

  it('respuesta válida y reciente sin detecciones: lista vacía y cobertura completa', () => {
    const { records } = normalizeFirms([HEADER], AVAIL('2026-11-14'), q, period, now);
    expect(records[0]?.data).toEqual({ type: 'detections', items: [] });
    expect(records[0]?.coverage).toMatchObject({ status: 'complete', validCount: 2, expectedCount: 2 });
  });

  it('datos vencidos del proveedor quedan en la cobertura, no como "sin fuego"', () => {
    const old = normalizeFirms([HEADER], AVAIL('2026-11-13'), q, period, now).records[0]!;
    expect(old.coverage).toMatchObject({ status: 'partial', validCount: 1, expectedCount: 2 });
    const dead = normalizeFirms([HEADER], AVAIL('2026-11-01'), q, period, now).records[0]!;
    expect(dead.coverage.status).toBe('none');
  });

  it('un cuerpo que no es CSV de FIRMS es inválido y no se repite', () => {
    expect(() => normalizeFirms(['Invalid MAP_KEY.'], AVAIL('2026-11-14'), q, period, now)).toThrow('Respuesta FIRMS no válida');
    expect(() => normalizeFirms([HEADER], 'nope', q, period, now)).toThrow();
  });
});

describe('alerta activa', () => {
  const rec = (retrieved: string, date: string, hhmm: string) =>
    normalizeFirms([[HEADER, row(-6.8, -79.8, date, hhmm, 'n')].join('\n')], AVAIL('2026-11-14'), q, period, new Date(retrieved)).records[0]!;

  it('exige recuperación de hasta 1 h y detección de las últimas 24 h', () => {
    const r = rec('2026-11-14T11:30:00Z', '2026-11-14', '824');
    expect(activeFirmsAlert(r, now).active).toBe(true);
    expect(activeFirmsAlert(r, new Date('2026-11-14T12:31:00Z')).active).toBe(false); // recuperación de hace 61 min
    expect(activeFirmsAlert(r, new Date('2026-11-15T08:25:00Z')).active).toBe(false); // detección de hace más de 24 h
  });

  it('una detección de hace más de 24 h no es actual aunque el dato sea reciente', () => {
    const r = rec('2026-11-14T11:59:00Z', '2026-11-13', '1100');
    expect(activeFirmsAlert(r, now)).toEqual({ active: false, items: [] });
  });
});

describe('fetchFirms', () => {
  const KEY = 'CLAVE-SECRETA-123';
  const ok = (body: string) => new Response(body);
  const route = (u: string | URL | Request) => ok(String(u).includes('data_availability') ? AVAIL('2026-11-14') : HEADER);

  it('consulta área y disponibilidad con la clave en la ruta', async () => {
    const f = vi.fn(async (u: string | URL | Request) => route(u));
    const { records } = await fetchFirms(q, { fetch: f as unknown as typeof fetch, now, mapKey: KEY });
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes(`/area/csv/${KEY}/VIIRS_NOAA20_NRT/`) && u.endsWith('/2/2026-11-13'))).toBe(true);
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  it('divide la consulta en el antimeridiano', async () => {
    const f = vi.fn(async (u: string | URL | Request) => route(u));
    await fetchFirms({ ...q, lat: -17.7, lon: 179.95 }, { fetch: f as unknown as typeof fetch, now, mapKey: KEY });
    expect(f.mock.calls.filter((c) => String(c[0]).includes('/area/'))).toHaveLength(2);
  });

  it('fuente caída: el error no filtra la clave ni la URL', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError(`fetch failed https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/x`));
    const err = (await fetchFirms(q, { fetch: f, now, mapKey: KEY, deadlineAt: Date.now() }).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('Fallo de red');
    expect(`${err.message}${err.stack}`).not.toContain(KEY);
  });

  it('HTTP 500 y respuesta con aviso de clave inválida', async () => {
    const e500 = (await fetchFirms(q, { fetch: vi.fn().mockResolvedValue(new Response('x', { status: 500 })), now, mapKey: KEY, deadlineAt: Date.now() }).catch((e: Error) => e)) as Error;
    expect(e500.message).toBe('HTTP 500');
    const bad = (await fetchFirms(q, { fetch: vi.fn(async () => ok(`Invalid MAP_KEY ${KEY}`)), now, mapKey: KEY }).catch((e: Error) => e)) as Error;
    expect(bad.message).toBe('Respuesta FIRMS no válida');
  });

  it('sin clave configurada falla con un mensaje claro', async () => {
    const saved = process.env.FIRMS_MAP_KEY;
    delete process.env.FIRMS_MAP_KEY;
    try {
      await expect(fetchFirms(q, { now })).rejects.toThrow('FIRMS_MAP_KEY ausente');
    } finally {
      if (saved !== undefined) process.env.FIRMS_MAP_KEY = saved;
    }
  });
});
