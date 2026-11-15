import { describe, expect, it, vi } from 'vitest';
import {
  fetchGiovanniWindow,
  monthlyMeans,
  normalizeGiovanni,
  parseGiovanniCsv,
  type Reading,
} from '../../src/services/nasa/giovanni.ts';

// Fixtures sintéticos con el formato del tutorial de GES DISC (bloque clave,valor + Timestamp,<variable>).
// No son una respuesta real: Giovanni in Cloud respondió 500 a toda petición con el token disponible.
const KELVIN = 273.15;
const csv = (unit: string, rows: [string, string][]) =>
  [
    'param_name,Near surface air temperature',
    `unit,${unit}`,
    'lat,-6.875',
    'lon,-79.875',
    'Timestamp,Near surface air temperature',
    ...rows.map(([t, v]) => `${t},${v}`),
  ].join('\n');

/** Lecturas de 3 h de todo un mes, todas con el mismo valor en °C. */
function month(m: string, celsius: number, fraction = 1): Reading[] {
  const n = Math.round(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5), 0)).getUTCDate() * 8 * fraction);
  return Array.from({ length: n }, (_, i) => ({ t: `${m}-${String(1 + Math.floor(i / 8)).padStart(2, '0')} ${String((i % 8) * 3).padStart(2, '0')}:00:00`, v: celsius }));
}
const baseline = (years: number[], f = (y: number) => 20 + 0.1 * (y - 2010)) => years.flatMap((y) => month(`${y}-03`, f(y)));
const YEARS = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019];
const q = { lat: -6.77, lon: -79.84, window: { start: '2025-01-01', end: '2025-03-31' } } as const;
const now = new Date('2026-11-14T12:00:00Z');
const stat = (records: ReturnType<typeof normalizeGiovanni>['records'], name: string) => {
  const d = records.find((r) => r.data.type === 'statistic' && r.data.name === name)?.data;
  return d?.type === 'statistic' ? d : undefined;
};

describe('parseGiovanniCsv', () => {
  it('convierte kelvin a Celsius y marca inválidos como null', () => {
    const out = parseGiovanniCsv(csv('K', [['2025-01-01 03:00:00', String(20 + KELVIN)], ['2025-01-01 06:00:00', '9999'], ['2025-01-01 09:00:00', '']]));
    expect(out).toEqual([
      { t: '2025-01-01 03:00:00', v: 20 },
      { t: '2025-01-01 06:00:00', v: null },
      { t: '2025-01-01 09:00:00', v: null },
    ]);
  });
  it('rechaza unidades desconocidas y cuerpos sin encabezado', () => {
    expect(() => parseGiovanniCsv(csv('degF', []))).toThrow(/Unidad/);
    expect(() => parseGiovanniCsv('')).toThrow(/vacío/);
  });
});

describe('agregación mensual', () => {
  it('un mes exige al menos 80 % de sus lecturas de 3 h', () => {
    const [ok, weak] = monthlyMeans([...month('2025-01', 20), ...month('2025-02', 22, 0.5)]);
    expect(ok).toMatchObject({ month: '2025-01', mean: 20, valid: 248, expected: 248 });
    expect(weak).toMatchObject({ month: '2025-02', mean: null, valid: 112, expected: 224 });
  });
});

describe('anomalía y tendencia', () => {
  const win = [...month('2025-01', 24), ...month('2025-02', 23, 0.5), ...month('2025-03', 21.5)];

  it('son reproducibles: mismo mes frente a la referencia, y con unidades', () => {
    const { records, observedUntil } = normalizeGiovanni(win, baseline(YEARS), q, '2025-03', now);
    expect(stat(records, 'anomaly')).toMatchObject({ value: 1.05, sampleCount: 10, minSampleCount: 8, baseline: { start: '2010-01-01', end: '2019-12-31' }, methodVersion: 'gic-monthly-v1' });
    expect(stat(records, 'trend')?.value).toBe(1); // recta exacta: 0.1 °C/año = 1 °C/década
    expect(records.filter((r) => r.data.type === 'statistic').map((r) => r.unit)).toEqual(['C', 'C/decada']);
    expect(records.find((r) => r.data.type === 'statistic')?.period).toEqual({ start: '2025-03-01', end: '2025-03-31' });
    expect(observedUntil).toBe('2025-03-31');
    expect(normalizeGiovanni(win, baseline(YEARS), q, '2025-03', now).records).toEqual(records);
  });

  it('serie mensual con meses insuficientes explícitos', () => {
    const { records } = normalizeGiovanni(win, baseline(YEARS), q, '2025-03', now);
    const series = records.find((r) => r.data.type === 'series');
    expect(series?.data.type === 'series' && series.data.points).toEqual([
      { t: '2025-01', v: 24 },
      { t: '2025-02', v: null },
      { t: '2025-03', v: 21.5 },
    ]);
    expect(series?.coverage).toMatchObject({ status: 'partial', validCount: 2, expectedCount: 3 });
    expect(series?.coverage.quality.join(' ')).toContain('2025-02 (112/224)');
    expect(series?.unit).toBe('C');
    expect(series?.dataset).toMatchObject({ id: 'GLDAS_NOAH025_3H_2_1', version: '2.1' });
  });

  it('una serie insuficiente queda marcada: valor null con la muestra a la vista', () => {
    const { records } = normalizeGiovanni(win, baseline(YEARS.slice(0, 5)), q, '2025-03', now);
    expect(stat(records, 'anomaly')).toMatchObject({ value: null, sampleCount: 5, minSampleCount: 8 });
    expect(stat(records, 'trend')).toMatchObject({ value: null, sampleCount: 5 });
  });

  it('años base con el mes incompleto no cuentan, y un mes objetivo incompleto no produce anomalía', () => {
    const base = [...baseline(YEARS.slice(0, 7)), ...month('2017-03', 99, 0.3), ...month('2018-03', 99, 0.3), ...month('2019-03', 99, 0.3)];
    expect(stat(normalizeGiovanni(win, base, q, '2025-03', now).records, 'anomaly')).toMatchObject({ value: null, sampleCount: 7 });
    expect(stat(normalizeGiovanni(win, baseline(YEARS), q, '2025-02', now).records, 'anomaly')?.value).toBeNull();
  });
});

describe('fetchGiovanniWindow', () => {
  it('usa GET /timeseries con la cabecera authorizationtoken y el centro de la celda, y no filtra el token', async () => {
    const f = vi.fn().mockResolvedValue(new Response(csv('K', [])));
    await fetchGiovanniWindow(-6.77, -79.84, '2025-01-01', '2025-01-31', { token: 'TOKEN-SECRETO', fetch: f });
    const [url, init] = f.mock.calls[0]!;
    const u = new URL(url as string);
    expect(u.origin + u.pathname).toBe('https://api.giovanni.earthdata.nasa.gov/timeseries');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      data: 'GLDAS_NOAH025_3H_2_1_Tair_f_inst',
      location: '[-6.875,-79.875]',
      time: '2025-01-01T00:00:00/2025-01-31T23:59:59',
    });
    expect((init as { headers: Record<string, string> }).headers).toEqual({ authorizationtoken: 'TOKEN-SECRETO' });

    const bad = vi.fn().mockResolvedValue(new Response('{"message":null}', { status: 500 }));
    const err = (await fetchGiovanniWindow(-6.77, -79.84, '2025-01-01', '2025-01-31', { token: 'TOKEN-SECRETO', fetch: bad, deadlineAt: Date.now() }).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('HTTP 500');
  });

  it('sin token falla claro', async () => {
    const saved = process.env.EARTHDATA_TOKEN;
    delete process.env.EARTHDATA_TOKEN;
    delete process.env.EARTHDATA_USERNAME;
    try {
      await expect(fetchGiovanniWindow(0, 0, '2025-01-01', '2025-01-02')).rejects.toThrow('Faltan EARTHDATA_USERNAME');
    } finally {
      if (saved !== undefined) process.env.EARTHDATA_TOKEN = saved;
    }
  });
});
