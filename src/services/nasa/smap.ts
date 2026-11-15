import type { ClimateQuery, EvidenceRecord, LocalDate } from '../../domain/contracts.ts';
import { evidenceRecordSchema } from '../../domain/schemas.ts';
import type { ClimateKey } from '../supabase/cache.ts';
import { addDays, cellSmap, coverageOf, daysInclusive } from './grid.ts';

// SMAP L4 SPL4SMGP.008 vía AppEEARS. En la ruta web NO se llama a AppEEARS: la ingesta
// (scripts/ingest-smap.ts) normaliza el CSV de una tarea completada y lo deja en Supabase;
// aquí solo viven las constantes, la clave de caché y el normalizador del CSV.
// Capas, unidades, relleno y rango válido verificados el 2026-11-14 en
// https://appeears.earthdatacloud.nasa.gov/api/product/SPL4SMGP.008 (sin capas de calidad: 404 en /quality).

export const SMAP_PRODUCT = 'SPL4SMGP.008';
export const SMAP_TTL_MS = 24 * 3_600_000;
export const SMAP_USABLE_MS = 7 * 86_400_000;
/** Máxima antigüedad de la última observación válida para una evaluación actual. */
export const SMAP_MAX_OBSERVATION_AGE_DAYS = 10;
export const SMAP_FILL = -9999;
export const SMAP_VALID = { min: 0, max: 0.9 } as const;

export const SMAP_LAYERS = [
  { layer: 'Geophysical_Data_sm_surface', variable: 'Humedad del suelo, superficie (0-5 cm)' },
  { layer: 'Geophysical_Data_sm_rootzone', variable: 'Humedad del suelo, zona radicular (0-100 cm)' },
] as const;
const UNIT = 'm^3/m^3';

export function smapKey(q: ClimateQuery): ClimateKey {
  return {
    source: 'smap',
    productVersion: SMAP_PRODUCT,
    schemaVersion: 1,
    cellId: cellSmap(q.lat, q.lon).cellId,
    windowStart: q.window.start,
    windowEnd: q.window.end,
  };
}

/** Divide una línea CSV respetando comillas dobles. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  return [...out, cur].map((s) => s.trim());
}

/**
 * Normaliza el CSV de resultados de una tarea de puntos de AppEEARS.
 * Columnas reales (bundle del 2026-11-15): `Category,ID,Latitude,Longitude,Date,SMAP_Tile,
 * SPL4SMGP_008_Line_Y_9.00805km,SPL4SMGP_008_Sample_X_9.00805km` y `SPL4SMGP_008_<capa>` por capa,
 * con `Date` como `YYYY-MM-DD hh:mm:ss UTC`. SMAP L4 trae 8 lecturas de 3 h por día: el valor
 * diario es su promedio.
 * Descarta filas de otra celda, el relleno y valores fuera del rango válido: quedan como `null`.
 */
export function normalizeSmap(
  csv: string,
  q: ClimateQuery,
  period: { start: LocalDate; end: LocalDate },
  retrievedAt: Date,
): { records: EvidenceRecord[]; observedUntil: LocalDate | null } {
  const [head, ...lines] = csv.trim().split(/\r?\n/);
  const cols = splitLine(head ?? '');
  const at = (name: string) => cols.findIndex((c) => c.toLowerCase() === name);
  const iDate = at('date');
  if (iDate < 0) throw new Error('CSV de AppEEARS sin columna Date');
  const iLat = at('latitude');
  const iLon = at('longitude');
  const cell = cellSmap(q.lat, q.lon);
  const rows = lines
    .filter(Boolean)
    .map(splitLine)
    .filter((r) => iLat < 0 || iLon < 0 || cellSmap(Number(r[iLat]), Number(r[iLon])).cellId === cell.cellId);

  const days = daysInclusive(period.start, period.end);
  const records: EvidenceRecord[] = [];
  let observedUntil: LocalDate | null = null;

  for (const { layer, variable } of SMAP_LAYERS) {
    const short = layer.replace('Geophysical_Data_', '');
    const iCol = cols.findIndex((c) => c === layer || c.endsWith(`_${short}`));
    if (iCol < 0) throw new Error(`CSV de AppEEARS sin la capa ${short}`);
    const byDate = new Map<string, number[]>();
    for (const r of rows) {
      const v = Number(r[iCol]);
      if (r[iCol] === '' || !Number.isFinite(v) || v === SMAP_FILL || v < SMAP_VALID.min || v > SMAP_VALID.max) continue;
      const d = (r[iDate] ?? '').slice(0, 10);
      byDate.set(d, [...(byDate.get(d) ?? []), v]);
    }
    const points = Array.from({ length: days }, (_, i) => {
      const t = addDays(period.start, i);
      const vs = byDate.get(t);
      return { t, v: vs ? Number((vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(5)) : null };
    });
    const valid = points.filter((p) => p.v !== null);
    const last = valid.at(-1)?.t ?? null;
    if (last && (!observedUntil || last > observedUntil)) observedUntil = last;

    const quality = ['Producto sin capas de calidad; se descartan relleno -9999 y valores fuera de 0-0.9'];
    if (valid.length === 0) quality.push('Sin datos válidos en esta celda y ventana');

    records.push(
      evidenceRecordSchema.parse({
        id: `smap:${short}:${cell.cellId}:${period.start}:${period.end}`,
        source: 'smap',
        dataset: {
          id: SMAP_PRODUCT,
          url: 'https://doi.org/10.5067/T5RUATAQREF8',
          product: 'SMAP L4 humedad de suelo superficie y zona radicular, 9 km',
          version: '008',
        },
        variable,
        unit: UNIT,
        kind: 'modeled_estimate',
        grid: { cellId: cell.cellId, lat: cell.lat, lon: cell.lon, nativeResolution: '9 km (EASE-Grid 2.0)' },
        period,
        retrievedAt: retrievedAt.toISOString(),
        coverage: coverageOf(valid.length, days, quality),
        cache: { origin: 'live', expiresAt: new Date(retrievedAt.getTime() + SMAP_TTL_MS).toISOString() },
        limitations: [
          'Producto modelado y asimilado: un modelo de superficie ajustado con observaciones SMAP; no es medición directa.',
          'Celda de ~9 km: no representa el suelo de la parcela.',
          'Valor diario: promedio de las lecturas disponibles de cada fecha.',
        ],
        data: { type: 'series', step: 'day', points },
      }),
    );
  }
  return { records, observedUntil };
}
