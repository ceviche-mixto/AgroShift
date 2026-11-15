import { z } from 'zod';
import type { ClimateQuery, EvidenceRecord, LocalDate } from '../../domain/contracts.ts';
import { evidenceRecordSchema } from '../../domain/schemas.ts';
import type { ClimateKey } from '../supabase/cache.ts';
import { fetchJson, type FetchOptions } from './fetch.ts';
import { addDays, cellCeres, cellMerra2, coverageOf, dateOf, daysInclusive } from './grid.ts';

// NASA POWER Daily API (servicio público). Verificado contra la respuesta real v2.10.3:
// `header.fill_value` marca faltantes, `parameters[x].units` da las unidades y las fechas
// están en hora local solar (LST). La clave NASA_API_KEY no se usa: POWER no la pide.

const ENDPOINT = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const DOCS = 'https://power.larc.nasa.gov/docs/services/api/temporal/daily/';

export const POWER_VARIABLES = ['PRECTOTCORR', 'T2M', 'T2M_MIN', 'T2M_MAX', 'RH2M', 'ALLSKY_SFC_SW_DWN'] as const;
/** Versión estable de la clave de caché (la versión real de la API viaja en cada registro). */
export const POWER_PRODUCT_VERSION = 'daily-api-v2';
export const POWER_TTL_MS = 24 * 3_600_000;
/** Uso máximo como instantánea previa tras la recuperación. */
export const POWER_USABLE_MS = 7 * 86_400_000;
/** Máxima antigüedad de la última observación válida para una evaluación actual. */
export const POWER_MAX_OBSERVATION_AGE_DAYS = 10;
const MAX_POINTS = 1000;

const responseSchema = z.object({
  properties: z.object({ parameter: z.record(z.string(), z.record(z.string(), z.number())) }),
  header: z.object({
    api: z.object({ version: z.string() }),
    fill_value: z.number(),
    time_standard: z.string(),
    sources: z.array(z.string()),
  }),
  parameters: z.record(z.string(), z.object({ units: z.string() })),
});

/** Celda de caché de POWER: cada variable usa su rejilla (MERRA-2 o CERES), así que la clave lleva ambas. */
export function powerCellId(lat: number, lon: number): string {
  return `${cellMerra2(lat, lon).cellId}|${cellCeres(lat, lon).cellId}`;
}

export function powerKey(q: ClimateQuery): ClimateKey {
  return {
    source: 'power',
    productVersion: POWER_PRODUCT_VERSION,
    schemaVersion: 1,
    cellId: powerCellId(q.lat, q.lon),
    windowStart: q.window.start,
    windowEnd: q.window.end,
  };
}

/** Normaliza una respuesta de POWER. Pura: no toca la red ni el reloj. */
export function normalizePower(
  raw: unknown,
  q: ClimateQuery,
  period: { start: LocalDate; end: LocalDate },
  retrievedAt: Date,
): { records: EvidenceRecord[]; observedUntil: LocalDate | null } {
  const res = responseSchema.parse(raw);
  const days = daysInclusive(period.start, period.end);
  const records: EvidenceRecord[] = [];
  let observedUntil: LocalDate | null = null;

  for (const name of POWER_VARIABLES) {
    const values = res.properties.parameter[name];
    const unit = res.parameters[name]?.units;
    if (!values || !unit) continue; // sin datos o sin unidad verificada: no se inventa

    const solar = name === 'ALLSKY_SFC_SW_DWN';
    const cell = solar ? cellCeres(q.lat, q.lon) : cellMerra2(q.lat, q.lon);
    const points = Array.from({ length: days }, (_, i) => {
      const t = addDays(period.start, i);
      const v = values[t.replaceAll('-', '')];
      return { t, v: v === undefined || v === res.header.fill_value ? null : v };
    });
    const valid = points.filter((p) => p.v !== null);
    const last = valid.at(-1)?.t ?? null;
    if (last && (!observedUntil || last > observedUntil)) observedUntil = last;

    const quality = [`Fuentes: ${res.header.sources.join(', ')}`, `Fecha en hora ${res.header.time_standard}`];
    if (last && last < period.end) quality.push(`Sin dato posterior a ${last} (latencia del proveedor)`);
    const gaps = points.filter((p) => p.v === null && (!last || p.t < last)).length;
    if (gaps > 0) quality.push(`${gaps} días con relleno del proveedor`);
    if (period.start > q.window.start && days === MAX_POINTS) quality.push(`Ventana recortada a ${MAX_POINTS} días`);

    records.push(
      evidenceRecordSchema.parse({
        id: `power:${name}:${cell.cellId}:${period.start}:${period.end}`,
        source: 'power',
        dataset: { id: 'NASA/POWER Daily', url: DOCS, product: 'POWER Daily API, comunidad AG', version: res.header.api.version },
        variable: name,
        unit,
        kind: 'modeled_estimate',
        grid: {
          cellId: cell.cellId,
          lat: cell.lat,
          lon: cell.lon,
          nativeResolution: solar ? '1° x 1°' : '0.5° x 0.625°',
        },
        period,
        retrievedAt: retrievedAt.toISOString(),
        coverage: coverageOf(valid.length, days, quality),
        cache: { origin: 'live', expiresAt: new Date(retrievedAt.getTime() + POWER_TTL_MS).toISOString() },
        limitations: [
          'Estimación de reanálisis y satélite para una celda; no es una medición en la parcela.',
          'Los días más recientes pueden ser provisionales y cambiar.',
        ],
        data: { type: 'series', step: 'day', points },
      }),
    );
  }
  return { records, observedUntil };
}

export interface PowerOptions extends Pick<FetchOptions, 'fetch' | 'signal' | 'deadlineAt' | 'random'> {
  now?: Date;
}

/** Consulta POWER en vivo. Recorta la ventana a hoy (UTC) y a 1000 días. */
export async function fetchPower(q: ClimateQuery, opts: PowerOptions = {}) {
  const now = opts.now ?? new Date();
  const end = q.window.end < dateOf(now) ? q.window.end : dateOf(now);
  const start = q.window.start > addDays(end, 1 - MAX_POINTS) ? q.window.start : addDays(end, 1 - MAX_POINTS);
  if (start > end) return { records: [] as EvidenceRecord[], observedUntil: null };
  const url = `${ENDPOINT}?${new URLSearchParams({
    community: 'AG',
    parameters: POWER_VARIABLES.join(','),
    latitude: String(q.lat),
    longitude: String(q.lon),
    start: start.replaceAll('-', ''),
    end: end.replaceAll('-', ''),
    format: 'JSON',
  })}`;
  const raw = await fetchJson(url, opts);
  return normalizePower(raw, q, { start, end }, now);
}
