// Geometría de la parcela marcada en el mapa. Pura: sin Leaflet ni DOM, así no pesa en el paquete inicial.

export interface LatLon {
  lat: number;
  lon: number;
}
export interface ParcelShape {
  /** Centro de la parcela: el punto, el medio de la línea o el centroide del polígono. */
  center: LatLon;
  /** Hectáreas; `null` con menos de 3 vértices. */
  hectares: number | null;
}

export const MAX_VERTICES = 4;
const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Añade un vértice; con `MAX_VERTICES` ya marcados, el clic siguiente reinicia la parcela. */
export function addVertex(points: LatLon[], p: LatLon): LatLon[] {
  return points.length >= MAX_VERTICES ? [p] : [...points, p];
}

/**
 * Centro y área de 1 a 4 vértices en el orden marcado. Proyección equirrectangular local: el error es
 * despreciable a escala de parcela.
 * shortcut: un polígono con lados cruzados (en «moño») da un área engañosa; mejorar si se permite editar vértices.
 */
export function parcelShape(points: LatLon[]): ParcelShape | null {
  if (!points.length) return null;
  const n = points.length;
  const mean = { lat: points.reduce((a, p) => a + p.lat, 0) / n, lon: points.reduce((a, p) => a + p.lon, 0) / n };
  if (n < 3) return { center: mean, hectares: null };

  // Metros respecto a la media (x al este, y al norte)
  const k = Math.cos(rad(mean.lat));
  const xy = points.map((p) => ({ x: rad(p.lon - mean.lon) * k * EARTH_RADIUS_M, y: rad(p.lat - mean.lat) * EARTH_RADIUS_M }));
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const a = xy[i]!;
    const b = xy[(i + 1) % n]!;
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  const m2 = Math.abs(twiceArea) / 2;
  if (m2 < 1e-6) return { center: mean, hectares: 0 };
  const center = {
    lat: mean.lat + ((cy / (3 * twiceArea)) / EARTH_RADIUS_M) * (180 / Math.PI),
    lon: mean.lon + ((cx / (3 * twiceArea)) / (EARTH_RADIUS_M * k)) * (180 / Math.PI),
  };
  return { center, hectares: m2 / 10_000 };
}
