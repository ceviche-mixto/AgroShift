import L from 'leaflet';
import leafletCss from 'leaflet/dist/leaflet.css?url';
import mapCss from './parcel-map.css?url';
import { addVertex, MAX_VERTICES, parcelShape, type LatLon, type ParcelShape } from '../domain/parcel.ts';

// Chunk aparte: FarmFlow lo carga con import() cuando el mapa del paso 1 entra en pantalla.
// No importa nada de Supabase, NASA ni del paquete inicial salvo la geometría pura.

type Text = { mapa: string; zoomMas: string; zoomMenos: string; atribucion: string };

export interface ParcelMapOptions {
  el: HTMLElement;
  /** Coordenadas ya escritas (centro inicial); `null` = vista del mundo. */
  start: LatLon | null;
  text: Text;
  /** Esquinas ya marcadas (borrador restaurado al cambiar de idioma). */
  initial?: LatLon[];
  onChange: (points: LatLon[], shape: ParcelShape | null) => void;
}
export interface ParcelMap {
  points(): LatLon[];
  shape(): ParcelShape | null;
  clear(): void;
  markCenter(): void;
  /** Tras mostrar de nuevo el contenedor: recalcula el tamaño y, sin vértices, recentra. */
  refresh(start: LatLon | null): void;
}

// Hoja de estilos por URL y no importada: así Astro no la mete como <link> bloqueante en la página inicial.
for (const href of [leafletCss, mapCss]) {
  if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
  }
}

const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const WORLD: [number, number] = [10, 0];
const FIELD_ZOOM = 16;

export function mountParcelMap({ el, start, text, initial, onChange }: ParcelMapOptions): ParcelMap {
  const map = L.map(el, { zoomControl: false, worldCopyJump: true, minZoom: 2, maxBounds: [[-90, -540], [90, 540]] });
  map.setView(start ? [start.lat, start.lon] : WORLD, start ? FIELD_ZOOM : 2);
  L.control.zoom({ zoomInTitle: text.zoomMas, zoomOutTitle: text.zoomMenos }).addTo(map);
  L.tileLayer(TILES, { maxZoom: 19, attribution: text.atribucion }).addTo(map);
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', text.mapa);

  let points: LatLon[] = [];
  const layer = L.layerGroup().addTo(map);
  const dot = (p: L.LatLngExpression, fill: string, radius: number) =>
    L.circleMarker(p, { radius, color: '#ffffff', weight: 3, fillColor: fill, fillOpacity: 1, interactive: false });

  function paint() {
    layer.clearLayers();
    const ll = points.map((p): L.LatLngTuple => [p.lat, p.lon]);
    if (ll.length >= 3) L.polygon(ll, { color: '#ffd400', weight: 3, fillOpacity: 0.2, interactive: false }).addTo(layer);
    else if (ll.length === 2) L.polyline(ll, { color: '#ffd400', weight: 3, interactive: false }).addTo(layer);
    for (const p of ll) dot(p, '#2d5a27', 8).addTo(layer);
    const shape = parcelShape(points);
    if (shape && points.length > 1) dot([shape.center.lat, shape.center.lon], '#ffd400', 6).addTo(layer);
    onChange(points, shape);
  }

  const add = (p: L.LatLng) => {
    const w = p.wrap();
    points = addVertex(points, { lat: w.lat, lon: w.lng });
    paint();
  };
  map.on('click', (e: L.LeafletMouseEvent) => add(e.latlng));

  // Enter marca el centro del mapa (teclado) y no debe avanzar el formulario; los demás Enter (botones de zoom) tampoco.
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && e.target === el) {
      e.preventDefault();
      add(map.getCenter());
    }
  });

  if (initial?.length) {
    points = initial.slice(0, MAX_VERTICES);
    paint();
  }

  return {
    points: () => points,
    shape: () => parcelShape(points),
    clear() {
      points = [];
      paint();
    },
    markCenter: () => add(map.getCenter()),
    refresh(s) {
      map.invalidateSize();
      if (!points.length && s) map.setView([s.lat, s.lon], Math.max(map.getZoom(), FIELD_ZOOM));
    },
  };
}
