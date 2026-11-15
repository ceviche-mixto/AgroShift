import type { ClimateQuery, EvidenceRecord, LocalDate } from '../../domain/contracts.ts';
import { evidenceRecordSchema } from '../../domain/schemas.ts';
import { serverEnv } from '../env.ts';
import type { ClimateKey } from '../supabase/cache.ts';
import { fetchText, type FetchOptions } from './fetch.ts';
import { addDays, bboxes, cellFirms, coverageOf, dateOf, daysInclusive, distanceKm } from './grid.ts';

// NASA FIRMS, API de área. La clave viaja en la ruta de la URL: la URL nunca se registra,
// no sale en errores y no se devuelve. Verificado contra la API real (CSV, VIIRS_NOAA20_NRT).

const BASE = 'https://firms.modaps.eosdis.nasa.gov/api';
export const FIRMS_SOURCE = 'VIIRS_NOAA20_NRT';
/** Días UTC consultados: ayer y hoy, para cubrir las últimas 24 h. */
const DAY_RANGE = 2;
/** Radio desde el centro de la celda de 0,1° (~11 km). */
export const FIRMS_RADIUS_KM = 15;
export const FIRMS_TTL_MS = 15 * 60_000;
/** Uso máximo como última lectura guardada (siempre con su fecha); una alerta activa exige datos de hasta 1 h. */
export const FIRMS_USABLE_MS = 24 * 3_600_000;
/** Una alerta activa exige recuperación de hasta 1 h y una detección de las últimas 24 h. */
export const FIRMS_ALERT_MAX_RETRIEVAL_MS = 3_600_000;
export const FIRMS_ALERT_MAX_DETECTION_MS = 24 * 3_600_000;
const MAX_ITEMS = 500;

export function firmsPeriod(now: Date): { start: LocalDate; end: LocalDate } {
  return { start: addDays(dateOf(now), 1 - DAY_RANGE), end: dateOf(now) };
}

export function firmsKey(q: ClimateQuery, now: Date): ClimateKey {
  const period = firmsPeriod(now);
  return {
    source: 'firms',
    productVersion: FIRMS_SOURCE,
    schemaVersion: 1,
    cellId: cellFirms(q.lat, q.lon).cellId,
    windowStart: period.start,
    windowEnd: period.end,
  };
}

/** Separa un CSV en filas por nombre de columna. Cualquier otra cosa (p. ej. un aviso de error) es inválida. */
function parseCsv(text: string, firstColumn: string): Record<string, string>[] {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  if (!head?.startsWith(firstColumn)) throw new Error('Respuesta FIRMS no válida');
  const cols = head.split(',');
  return lines.filter(Boolean).map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i] ?? `c${i}`, v])));
}

const CONFIDENCE = { l: 'low', n: 'nominal', h: 'high' } as const;

/** Normaliza las respuestas de área (una por rectángulo) y la disponibilidad. Pura. */
export function normalizeFirms(
  areaCsvs: string[],
  availabilityCsv: string,
  q: ClimateQuery,
  period: { start: LocalDate; end: LocalDate },
  retrievedAt: Date,
): { records: EvidenceRecord[]; observedUntil: LocalDate } {
  const cell = cellFirms(q.lat, q.lon);
  const maxDate = parseCsv(availabilityCsv, 'data_id').find((r) => r.data_id === FIRMS_SOURCE)?.max_date;
  if (!maxDate) throw new Error('FIRMS sin disponibilidad para la fuente');

  const rows = areaCsvs.flatMap((c) => parseCsv(c, 'latitude'));
  const items = rows
    .map((r) => {
      const hhmm = (r.acq_time ?? '').padStart(4, '0');
      return {
        acquiredAt: `${r.acq_date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`,
        confidence: CONFIDENCE[(r.confidence ?? '') as keyof typeof CONFIDENCE] ?? ('unknown' as const),
        distanceKm: Number(distanceKm(cell.lat, cell.lon, Number(r.latitude), Number(r.longitude)).toFixed(1)),
      };
    })
    .filter((i) => i.distanceKm <= FIRMS_RADIUS_KM && !Number.isNaN(Date.parse(i.acquiredAt)))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const days = daysInclusive(period.start, period.end);
  const covered = daysInclusive(period.start, maxDate < period.end ? maxDate : period.end);
  const quality = [`Datos del proveedor disponibles hasta ${maxDate}`];
  if (items.length > MAX_ITEMS) quality.push(`Se conservan las ${MAX_ITEMS} detecciones más cercanas`);

  const record = evidenceRecordSchema.parse({
    id: `firms:${FIRMS_SOURCE}:${cell.cellId}:${period.start}:${period.end}`,
    source: 'firms',
    dataset: {
      id: FIRMS_SOURCE,
      url: 'https://firms.modaps.eosdis.nasa.gov/api/area/',
      product: 'FIRMS VIIRS NOAA-20, tiempo casi real',
      version: rows[0]?.version ?? 'NRT',
    },
    variable: 'Focos de calor',
    unit: 'detecciones',
    kind: 'observation',
    grid: { cellId: cell.cellId, lat: cell.lat, lon: cell.lon, nativeResolution: 'VIIRS 375 m, consulta en celda de 0.1°' },
    period,
    retrievedAt: retrievedAt.toISOString(),
    coverage: coverageOf(covered, days, quality),
    cache: { origin: 'live', expiresAt: new Date(retrievedAt.getTime() + FIRMS_TTL_MS).toISOString() },
    limitations: [
      'Es una detección térmica satelital puntual: un posible foco de calor, no un incendio confirmado.',
      'Sin detecciones no descarta fuego: nubes y los pasos del satélite pueden ocultarlo.',
      `Alcance: hasta ${FIRMS_RADIUS_KM} km del centro de una celda de 0.1°, ${DAY_RANGE} días UTC.`,
    ],
    data: { type: 'detections', items: items.slice(0, MAX_ITEMS) },
  });
  return { records: [record], observedUntil: period.end };
}

/**
 * ¿Hay alerta activa? Exige recuperación de hasta 1 h y detecciones de las últimas 24 h.
 * Con datos más viejos no hay alerta actual, aunque el registro tenga detecciones.
 */
export function activeFirmsAlert(record: EvidenceRecord, now: Date) {
  const t = now.getTime();
  const fresh = t - Date.parse(record.retrievedAt) <= FIRMS_ALERT_MAX_RETRIEVAL_MS;
  const items =
    fresh && record.source === 'firms' && record.data.type === 'detections'
      ? record.data.items.filter((i) => {
          const age = t - Date.parse(i.acquiredAt);
          return age >= 0 && age <= FIRMS_ALERT_MAX_DETECTION_MS;
        })
      : [];
  return { active: items.length > 0, items };
}

export interface FirmsOptions extends Pick<FetchOptions, 'fetch' | 'signal' | 'deadlineAt' | 'random'> {
  now?: Date;
  /** Para pruebas; por defecto se lee FIRMS_MAP_KEY. */
  mapKey?: string;
}

/** Consulta FIRMS en vivo: rectángulo acotado (dividido en el antimeridiano) y disponibilidad. */
export async function fetchFirms(q: ClimateQuery, opts: FirmsOptions = {}) {
  const mapKey = opts.mapKey ?? serverEnv('FIRMS_MAP_KEY');
  if (!mapKey) throw new Error('FIRMS_MAP_KEY ausente');
  const now = opts.now ?? new Date();
  const period = firmsPeriod(now);
  const cell = cellFirms(q.lat, q.lon);
  const get = (path: string) => fetchText(`${BASE}/${path}`, { ...opts, secrets: [mapKey] });
  const [availability, ...areas] = await Promise.all([
    get(`data_availability/csv/${mapKey}/${FIRMS_SOURCE}`),
    ...bboxes(cell.lat, cell.lon, FIRMS_RADIUS_KM).map((b) =>
      get(`area/csv/${mapKey}/${FIRMS_SOURCE}/${b.map((n) => n.toFixed(4)).join(',')}/${DAY_RANGE}/${period.start}`),
    ),
  ]);
  return normalizeFirms(areas, availability, q, period, now);
}
