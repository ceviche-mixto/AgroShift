import type { Coverage, LocalDate, Source } from '../../domain/contracts.ts';

// Celdas deterministas por producto, distancia y aritmética de fechas calendario.
// Sin red ni reloj: todo es función pura.

export interface Cell {
  cellId: string;
  /** Centro de la celda, no la parcela. */
  lat: number;
  lon: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const num = (x: number) => String(Number(x.toFixed(4)));

/** Rejilla regular de paso `dLat` x `dLon` con centros en `off + k * paso`. */
function regular(prefix: string, lat: number, lon: number, dLat: number, dLon: number, offLat: number, offLon: number): Cell {
  const latC = clamp(Math.round((lat - offLat) / dLat) * dLat + offLat, -90 + offLat, 90 - offLat);
  let lonC = Math.round((lon - offLon) / dLon) * dLon + offLon;
  if (lonC >= 180 + offLon) lonC -= 360; // la rejilla da la vuelta en el antimeridiano
  return { cellId: `${prefix}:${num(latC)}:${num(lonC)}`, lat: Number(num(latC)), lon: Number(num(lonC)) };
}

/** MERRA-2 (meteorología de POWER): puntos cada 0,5° de latitud y 0,625° de longitud desde -90 y -180. */
export const cellMerra2 = (lat: number, lon: number): Cell => regular('merra2', lat, lon, 0.5, 0.625, 0, 0);
/** CERES SYN1deg (radiación de POWER): celdas de 1° con centro en .5. */
export const cellCeres = (lat: number, lon: number): Cell => regular('ceres1', lat, lon, 1, 1, 0.5, 0.5);
/** GLDAS Noah 0.25°: centros en x.125, x.375, x.625, x.875. */
export const cellGldas = (lat: number, lon: number): Cell => regular('gldas025', lat, lon, 0.25, 0.25, 0.125, 0.125);
/** Consulta FIRMS: celda de 0,1° (~11 km) para agrupar. */
export const cellFirms = (lat: number, lon: number): Cell => regular('firms0.1', lat, lon, 0.1, 0.1, 0, 0);

// EASE-Grid 2.0 global cilíndrica de áreas iguales, 9 km (SMAP L4): 3856 columnas x 1624 filas, WGS84.
const A = 6378137;
const E2 = 0.006694379990141;
const E = Math.sqrt(E2);
const SMAP_COLS = 3856;
const SMAP_ROWS = 1624;
const SMAP_SIZE = 9008.055210146;
const K0 = Math.cos(Math.PI / 6) / Math.sqrt(1 - E2 * 0.25);
const qOf = (phi: number) => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - Math.log((1 - E * s) / (1 + E * s)) / (2 * E));
};
const Q_POLE = qOf(Math.PI / 2);

function latFromY(y: number): number {
  const q = (2 * K0 * y) / A;
  let phi = Math.asin(clamp(q / Q_POLE, -1, 1));
  for (let i = 0; i < 8; i++) {
    const s = Math.sin(phi);
    const w = 1 - E2 * s * s;
    phi += ((w * w) / (2 * Math.cos(phi))) * (q / (1 - E2) - s / w + Math.log((1 - E * s) / (1 + E * s)) / (2 * E));
  }
  return (phi * 180) / Math.PI;
}

export function cellSmap(lat: number, lon: number): Cell {
  const x = A * K0 * ((lon * Math.PI) / 180);
  const y = (A * qOf((clamp(lat, -89.9999, 89.9999) * Math.PI) / 180)) / (2 * K0);
  const col = clamp(Math.floor((x + (SMAP_COLS * SMAP_SIZE) / 2) / SMAP_SIZE), 0, SMAP_COLS - 1);
  const row = clamp(Math.floor(((SMAP_ROWS * SMAP_SIZE) / 2 - y) / SMAP_SIZE), 0, SMAP_ROWS - 1);
  const xc = (col + 0.5) * SMAP_SIZE - (SMAP_COLS * SMAP_SIZE) / 2;
  const yc = (SMAP_ROWS * SMAP_SIZE) / 2 - (row + 0.5) * SMAP_SIZE;
  return {
    cellId: `ease2-9km:r${row}c${col}`,
    lat: Number(latFromY(yc).toFixed(4)),
    lon: Number(((xc / (A * K0)) * (180 / Math.PI)).toFixed(4)),
  };
}

/** Celdas de producto que usa cada fuente para esta coordenada. Los complementos no tienen rejilla fija. */
export function cellIds(source: Source, lat: number, lon: number): string[] {
  if (source === 'power') return [cellMerra2(lat, lon).cellId, cellCeres(lat, lon).cellId];
  if (source === 'smap') return [cellSmap(lat, lon).cellId];
  if (source === 'giovanni') return [cellGldas(lat, lon).cellId];
  if (source === 'firms') return [cellFirms(lat, lon).cellId];
  return [];
}

/** Distancia ortodrómica en km (haversine). */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Rectángulos [oeste, sur, este, norte] que cubren `radiusKm` alrededor de un punto.
 * Divide en dos cuando cruza el antimeridiano.
 */
export function bboxes(lat: number, lon: number, radiusKm: number): [number, number, number, number][] {
  const dLat = radiusKm / 111.195;
  const dLon = Math.min(180, radiusKm / (111.195 * Math.max(0.01, Math.cos((lat * Math.PI) / 180))));
  const s = clamp(lat - dLat, -90, 90);
  const n = clamp(lat + dLat, -90, 90);
  if (dLon >= 180) return [[-180, s, 180, n]];
  const w = lon - dLon;
  const e = lon + dLon;
  if (w < -180) return [[w + 360, s, 180, n], [-180, s, e, n]];
  if (e > 180) return [[w, s, 180, n], [-180, s, e - 360, n]];
  return [[w, s, e, n]];
}

// ---------- Fechas calendario (YYYY-MM-DD) ----------

const DAY_MS = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);

export const dateOf = (t: Date): LocalDate => t.toISOString().slice(0, 10);
export const addDays = (d: string, n: number): LocalDate => dateOf(new Date(ms(d) + n * DAY_MS));
/** Días entre dos fechas, ambas incluidas. 0 si `b` es anterior a `a`. */
export const daysInclusive = (a: string, b: string): number => Math.max(0, Math.round((ms(b) - ms(a)) / DAY_MS) + 1);
export const daysInMonth = (month: string): number =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** Cobertura a partir de conteos: completa, parcial o ninguna. */
export function coverageOf(validCount: number, expectedCount: number, quality: string[] = []): Coverage {
  const status = validCount === 0 ? 'none' : validCount >= expectedCount ? 'complete' : 'partial';
  return { status, validCount, expectedCount, quality };
}
