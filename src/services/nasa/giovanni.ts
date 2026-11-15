import type { ClimateQuery, EvidenceRecord, LocalDate } from '../../domain/contracts.ts';
import { evidenceRecordSchema } from '../../domain/schemas.ts';
import { serverEnv } from '../env.ts';
import type { ClimateKey } from '../supabase/cache.ts';
import { fetchText, type FetchOptions } from './fetch.ts';
import { addDays, cellGldas, coverageOf, daysInMonth } from './grid.ts';

// Giovanni in Cloud (NASA GES DISC) `GET /timeseries`, serie GLDAS Noah 0.25° 3-hourly v2.1.
// En la ruta web NO se llama al servicio: la ingesta (scripts/ingest-giovanni.ts) agrega por mes,
// calcula anomalía y tendencia y deja el resultado en Supabase. Aquí viven el cliente, el
// análisis del CSV y los cálculos. Formato real del CSV (verificado 2026-11-15): bloque `clave,valor`
// (prod_name, doi, unit, undef, lat, lon, resolución…), línea en blanco y `Timestamp (UTC),Data` con
// instantes `YYYY-MM-DD hh:mm`. Autenticación (probado 2026-11-15): el servicio lee la cabecera `authorizationtoken`, no
// `Authorization: Bearer` (que da 500). Rechazó el token de Earthdata Login con 401: exige el token
// de su propio `GET /signin` (OAuth con usuario y contraseña de Earthdata), como en el tutorial.

const ENDPOINT = 'https://api.giovanni.earthdata.nasa.gov/timeseries';
const SIGNIN = 'https://api.giovanni.earthdata.nasa.gov/signin';
const URS_HOST = 'urs.earthdata.nasa.gov';
export const GIOVANNI_VARIABLE = 'GLDAS_NOAH025_3H_2_1_Tair_f_inst';
export const GIOVANNI_METHOD_VERSION = 'gic-monthly-v1';
/** Agregados cerrados: 30 días de vigencia y hasta 180 días como instantánea previa. */
export const GIOVANNI_TTL_MS = 30 * 86_400_000;
export const GIOVANNI_USABLE_MS = 180 * 86_400_000;
/** Un agregado mensual es antecedente histórico: el último mes aceptado no puede tener más de 90 días. */
export const GIOVANNI_MAX_OBSERVATION_AGE_DAYS = 90;

/** Periodo base: 10 años completos de GLDAS 2.1 (la serie empieza en 2000). */
export const BASELINE = { start: '2010-01-01', end: '2019-12-31' } as const;
/** Mínimo de años base con el mes válido para calcular anomalía o tendencia. */
export const MIN_BASELINE_YEARS = 8;
/** Un mes cuenta solo con al menos 80 % de sus lecturas de 3 h. */
export const MIN_MONTH_FRACTION = 0.8;
const BASE_YEARS = Number(BASELINE.end.slice(0, 4)) - Number(BASELINE.start.slice(0, 4)) + 1;
const READS_PER_DAY = 8;
// Rango físico creíble de Tair en kelvin; fuera de él es relleno o error del producto.
const TAIR_K = { min: 180, max: 340 } as const;

export function giovanniKey(q: ClimateQuery): ClimateKey {
  return {
    source: 'giovanni',
    productVersion: GIOVANNI_VARIABLE,
    schemaVersion: 1,
    cellId: cellGldas(q.lat, q.lon).cellId,
    windowStart: q.window.start,
    windowEnd: q.window.end,
  };
}

export interface GiovanniOptions extends Pick<FetchOptions, 'fetch' | 'signal' | 'deadlineAt' | 'random'> {
  token?: string;
}

/**
 * Token de sesión de Giovanni. `GET /signin` redirige por OAuth a Earthdata Login y vuelve a
 * `/gettoken`. Las credenciales se envían solo al host de Earthdata Login. La cuenta debe haber
 * autorizado antes la aplicación Giovanni en su perfil de Earthdata.
 */
export async function giovanniToken(opts: GiovanniOptions = {}): Promise<string> {
  const user = serverEnv('EARTHDATA_USERNAME');
  const pass = serverEnv('EARTHDATA_PASSWORD');
  if (!user || !pass) throw new Error('Faltan EARTHDATA_USERNAME y EARTHDATA_PASSWORD (Giovanni /signin)');
  const basic = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  let url = SIGNIN;
  for (let hop = 0; hop < 5; hop++) {
    const headers: Record<string, string> = new URL(url).host === URS_HOST ? { Authorization: basic } : {};
    const res = await (opts.fetch ?? fetch)(url, { redirect: 'manual', signal: opts.signal, headers });
    const location = res.headers.get('location');
    if (!location) {
      // Respuesta real (2026-11-15): JSON `{ expires_in, token }`. El tutorial muestra un texto entre comillas.
      const body = (await res.text()).trim();
      let token: unknown = body;
      try {
        const json: unknown = JSON.parse(body);
        token = typeof json === 'string' ? json : (json as { token?: unknown } | null)?.token;
      } catch {}
      if (!res.ok || typeof token !== 'string' || !/^[^\s<>{}]{20,}$/.test(token)) {
        throw new Error(`Giovanni /signin: HTTP ${res.status} sin token`);
      }
      return token;
    }
    const next = new URL(location, url);
    const denied = next.searchParams.get('error');
    if (denied) {
      const why = (next.searchParams.get('error_msg') ?? denied).split(user).join('').slice(0, 160);
      throw new Error(`Earthdata Login: ${why}`);
    }
    url = next.href;
  }
  throw new Error('Giovanni /signin: demasiadas redirecciones');
}

/** Descarga una ventana acotada (UTC) para el centro de la celda. Solo para ingesta. */
export async function fetchGiovanniWindow(lat: number, lon: number, start: LocalDate, end: LocalDate, opts: GiovanniOptions = {}) {
  const token = opts.token ?? (await giovanniToken(opts));
  const cell = cellGldas(lat, lon);
  const url = `${ENDPOINT}?${new URLSearchParams({
    data: GIOVANNI_VARIABLE,
    location: `[${cell.lat},${cell.lon}]`,
    time: `${start}T00:00:00/${end}T23:59:59`,
  })}`;
  return fetchText(url, { ...opts, headers: { authorizationtoken: token }, secrets: [token] });
}

export interface Reading {
  /** Instante UTC `YYYY-MM-DD hh:mm`. */
  t: string;
  /** Grados Celsius, o `null` si falta o es inválido. */
  v: number | null;
}

/** Analiza el CSV de Giovanni y convierte kelvin a Celsius. Lanza si la unidad no es K o C. */
export function parseGiovanniCsv(text: string): Reading[] {
  const lines = text.trim().split(/\r?\n/);
  const iHead = lines.findIndex((l) => /^timestamp[^,]*,/i.test(l));
  if (iHead < 0) throw new Error('CSV de Giovanni vacío o inválido');
  const meta = Object.fromEntries(
    lines.slice(0, iHead).map((l) => [l.slice(0, l.indexOf(',')).trim(), l.slice(l.indexOf(',') + 1).trim()]),
  );
  const unit = meta.unit;
  if (unit !== 'K' && unit !== 'C') throw new Error(`Unidad de Giovanni no admitida: ${(unit ?? 'ausente').slice(0, 20)}`);
  return lines
    .slice(iHead + 1)
    .filter(Boolean)
    .map((l) => {
      const [t = '', raw = ''] = l.split(',');
      const k = unit === 'K' ? Number(raw) : Number(raw) + 273.15;
      const ok = raw.trim() !== '' && Number.isFinite(k) && k >= TAIR_K.min && k <= TAIR_K.max;
      return { t: t.trim().replace('T', ' ').slice(0, 19), v: ok ? Number((k - 273.15).toFixed(3)) : null };
    });
}

export interface MonthMean {
  month: string;
  /** `null` si el mes tiene menos de 80 % de sus lecturas. */
  mean: number | null;
  valid: number;
  expected: number;
}

/** Media mensual con cobertura explícita. */
export function monthlyMeans(readings: Reading[]): MonthMean[] {
  const byMonth = new Map<string, number[]>();
  for (const r of readings) {
    const m = r.t.slice(0, 7);
    byMonth.set(m, r.v === null ? (byMonth.get(m) ?? []) : [...(byMonth.get(m) ?? []), r.v]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, vs]) => {
      const expected = daysInMonth(month) * READS_PER_DAY;
      const enough = vs.length / expected >= MIN_MONTH_FRACTION;
      return { month, mean: enough ? Number((vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(3)) : null, valid: vs.length, expected };
    });
}

/** Pendiente de mínimos cuadrados de y sobre x. */
function slope(xs: number[], ys: number[]): number {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  return xs.reduce((s, x, i) => s + (x - mx) * ((ys[i] ?? 0) - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
}

/**
 * Serie mensual de la ventana más anomalía y tendencia del mes objetivo frente al mismo mes
 * del periodo base. `baselineReadings` trae al menos ese mes de cada año base.
 * Anomalía = media del mes objetivo menos media del mismo mes en el periodo base.
 * Tendencia = pendiente (°C por década) de ese mes entre los años base y el año objetivo.
 * Ambas son `null` si hay menos de MIN_BASELINE_YEARS años comparables.
 */
export function normalizeGiovanni(
  windowReadings: Reading[],
  baselineReadings: Reading[],
  q: ClimateQuery,
  targetMonth: string,
  retrievedAt: Date,
): { records: EvidenceRecord[]; observedUntil: LocalDate | null } {
  const cell = cellGldas(q.lat, q.lon);
  const months = monthlyMeans(windowReadings).filter((m) => m.month >= q.window.start.slice(0, 7) && m.month <= q.window.end.slice(0, 7));
  const target = months.find((m) => m.month === targetMonth);
  const mm = targetMonth.slice(5);
  const baseYears = monthlyMeans(baselineReadings).filter(
    (m) => m.month.slice(5) === mm && m.month.slice(0, 4) >= BASELINE.start.slice(0, 4) && m.month.slice(0, 4) <= BASELINE.end.slice(0, 4) && m.mean !== null,
  );
  const sample = baseYears.length;
  const targetMean = target?.mean ?? null;
  const comparable = sample >= MIN_BASELINE_YEARS && targetMean !== null;
  const baseMean = baseYears.reduce((a, m) => a + (m.mean ?? 0), 0) / (sample || 1);
  const anomaly = comparable ? Number((targetMean - baseMean).toFixed(3)) : null;
  const years = baseYears.map((m) => ({ x: Number(m.month.slice(0, 4)), y: m.mean ?? 0 }));
  if (targetMean !== null) years.push({ x: Number(targetMonth.slice(0, 4)), y: targetMean });
  const trend = comparable ? Number((slope(years.map((p) => p.x), years.map((p) => p.y)) * 10).toFixed(3)) : null;

  const common = {
    source: 'giovanni' as const,
    dataset: {
      id: 'GLDAS_NOAH025_3H_2_1',
      url: 'https://doi.org/10.5067/E7TYRXPJKWOQ',
      product: 'GLDAS Noah Land Surface Model L4 3-hourly 0.25 deg',
      version: '2.1',
    },
    kind: 'modeled_estimate' as const,
    grid: { cellId: cell.cellId, lat: cell.lat, lon: cell.lon, nativeResolution: '0.25° x 0.25°' },
    retrievedAt: retrievedAt.toISOString(),
    cache: { origin: 'live' as const, expiresAt: new Date(retrievedAt.getTime() + GIOVANNI_TTL_MS).toISOString() },
  };
  const limitations = [
    'Modelo de superficie terrestre forzado con observaciones (GLDAS Noah 2.1): estimación en una celda de 0.25°, no medición de la parcela.',
    'La anomalía es un antecedente histórico frente al periodo base, no un pronóstico.',
    'La tendencia es indicativa: usa un solo mes del año y pocos años.',
  ];
  const monthStart = `${targetMonth}-01`;
  const monthEnd = `${targetMonth}-${String(daysInMonth(targetMonth)).padStart(2, '0')}`;
  const stat = (name: 'anomaly' | 'trend', value: number | null, unit: string, method: string) =>
    evidenceRecordSchema.parse({
      ...common,
      id: `giovanni:Tair_f_inst:${name}:${cell.cellId}:${targetMonth}`,
      variable: name === 'anomaly' ? `Anomalía de temperatura del aire, ${targetMonth}` : `Tendencia de temperatura del aire, mes ${mm}`,
      unit,
      period: { start: monthStart, end: monthEnd },
      coverage: coverageOf(sample + (targetMean !== null ? 1 : 0), BASE_YEARS + 1, [
        `Años base válidos: ${sample} de ${BASE_YEARS}`,
        ...(targetMean === null ? ['Mes objetivo sin cobertura suficiente'] : []),
      ]),
      limitations,
      data: {
        type: 'statistic',
        name,
        value,
        method,
        methodVersion: GIOVANNI_METHOD_VERSION,
        baseline: BASELINE,
        sampleCount: sample,
        minSampleCount: MIN_BASELINE_YEARS,
      },
    });

  const [y1, m1, y2, m2] = [q.window.start.slice(0, 4), q.window.start.slice(5, 7), q.window.end.slice(0, 4), q.window.end.slice(5, 7)].map(Number) as [number, number, number, number];
  const windowMonths = (y2 - y1) * 12 + m2 - m1 + 1;
  const all = Array.from({ length: windowMonths }, (_, i) => {
    const n = y1 * 12 + (m1 - 1) + i;
    const month = `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
    return months.find((m) => m.month === month) ?? { month, mean: null, valid: 0, expected: daysInMonth(month) * READS_PER_DAY };
  });
  const points = all.map((m) => ({ t: m.month, v: m.mean }));
  const weak = all.filter((m) => m.mean === null).map((m) => `${m.month} (${m.valid}/${m.expected})`);
  const validMonths = all.filter((m) => m.mean !== null);
  const series = evidenceRecordSchema.parse({
    ...common,
    id: `giovanni:Tair_f_inst:monthly:${cell.cellId}:${q.window.start}:${q.window.end}`,
    variable: 'Temperatura del aire cerca de la superficie, media mensual',
    unit: 'C',
    period: q.window,
    coverage: coverageOf(validMonths.length, windowMonths, [
      'Mes válido con al menos 80 % de lecturas de 3 h; fechas en UTC',
      ...(weak.length ? [`Meses sin cobertura suficiente (lecturas válidas/esperadas): ${weak.join(', ')}`.slice(0, 200)] : []),
    ]),
    limitations,
    data: { type: 'series', step: 'month', points },
  });

  const lastValid = validMonths.at(-1)?.month;
  const observedUntil = lastValid ? addDays(`${lastValid}-01`, daysInMonth(lastValid) - 1) : null;
  return {
    records: [
      series,
      stat('anomaly', anomaly, 'C', `Media del mes objetivo menos media del mismo mes en ${BASELINE.start.slice(0, 4)}-${BASELINE.end.slice(0, 4)}; exige ${MIN_BASELINE_YEARS} años base válidos`),
      stat('trend', trend, 'C/decada', `Pendiente de mínimos cuadrados del mes ${mm} entre los años base y el año objetivo, por década; exige ${MIN_BASELINE_YEARS} años válidos`),
    ],
    observedUntil,
  };
}
