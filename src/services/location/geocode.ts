import { z } from 'zod';

// Búsqueda de localidades por texto con Open-Meteo Geocoding (datos GeoNames, CC BY 4.0).
// Uso gratuito no comercial, sin clave; hay que atribuir la fuente. Solo servidor: el navegador
// pregunta a /api/location y nunca ve al proveedor. El texto buscado es el nombre de un lugar público.

export const GEOCODE_DEADLINE_MS = 6_000;
export const GEOCODE_ATTRIBUTION = 'Búsqueda de localidades: GeoNames, a través de Open-Meteo (CC BY 4.0).';
const ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const MAX_PLACES = 5;
const CACHE_TTL_MS = 24 * 3_600_000;
const CACHE_MAX = 200;

export const placeQuerySchema = z.string().trim().min(2).max(80);

export interface Place {
  name: string;
  /** Departamento o provincia y país, para distinguir localidades con el mismo nombre. */
  detail: string;
  lat: number;
  lon: number;
}
export type PlaceSearch = { status: 'ok'; places: Place[] } | { status: 'unavailable' };

const providerSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        admin1: z.string().max(120).optional(),
        admin2: z.string().max(120).optional(),
        country: z.string().max(120).optional(),
      }),
    )
    .optional(),
});

// shortcut: caché en memoria por instancia (se vacía al llenarse); pasar a Supabase si hace falta compartirla.
const cache = new Map<string, { places: Place[]; expires: number }>();

export function clearGeocodeCache(): void {
  cache.clear();
}

const normalize = (q: string) => q.normalize('NFC').toLocaleLowerCase('es');

export interface GeocodeDeps {
  fetch?: typeof fetch;
  now?: () => number;
  deadlineMs?: number;
}

/** Nunca lanza: un fallo del proveedor devuelve `unavailable` para que la persona use coordenadas. */
export async function searchPlaces(query: string, deps: GeocodeDeps = {}): Promise<PlaceSearch> {
  const now = (deps.now ?? Date.now)();
  const key = normalize(query);
  const hit = cache.get(key);
  if (hit && hit.expires > now) return { status: 'ok', places: hit.places };

  try {
    const url = `${ENDPOINT}?${new URLSearchParams({ name: query, count: String(MAX_PLACES), language: 'es', format: 'json' })}`;
    const res = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(deps.deadlineMs ?? GEOCODE_DEADLINE_MS) });
    if (!res.ok) return { status: 'unavailable' };
    const parsed = providerSchema.parse(await res.json());
    const seen = new Set<string>();
    const places = (parsed.results ?? []).flatMap((r) => {
      const detail = [...new Set([r.admin2, r.admin1, r.country].filter((x): x is string => !!x))].join(', ');
      const place = { name: r.name, detail, lat: Number(r.latitude.toFixed(4)), lon: Number(r.longitude.toFixed(4)) };
      const id = `${place.name}|${place.detail}|${place.lat}|${place.lon}`;
      if (seen.has(id)) return [];
      seen.add(id);
      return [place];
    });
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { places, expires: now + CACHE_TTL_MS });
    return { status: 'ok', places };
  } catch {
    return { status: 'unavailable' };
  }
}
