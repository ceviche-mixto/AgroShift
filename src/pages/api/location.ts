import type { APIRoute } from 'astro';
import { z } from 'zod';
import { privateJson, readJsonBody } from '../../services/http.ts';
import { GEOCODE_ATTRIBUTION, placeQuerySchema, searchPlaces } from '../../services/location/geocode.ts';
import { consumeBudget } from '../../services/supabase/cache.ts';

export const prerender = false;

const bodySchema = z.strictObject({ q: placeQuerySchema });
/** Búsquedas por minuto entre todas las instancias: el proveedor gratuito limita a 600. */
const BUDGET = { intervalSeconds: 60, limit: 300 } as const;

export const POST: APIRoute = async ({ request }) => {
  const body = bodySchema.safeParse(await readJsonBody(request, 512));
  if (!body.success) return privateJson(400, { status: 'invalid_input' });
  // Si el contador compartido no responde, la búsqueda sigue: la caché y el plazo limitan el daño
  const allowed = await consumeBudget('geocode', BUDGET.intervalSeconds, BUDGET.limit).catch(() => true);
  if (!allowed) return privateJson(429, { status: 'rate_limited', retryAfterSeconds: BUDGET.intervalSeconds }, { 'Retry-After': String(BUDGET.intervalSeconds) });
  const found = await searchPlaces(body.data.q);
  // Sin texto del agricultor en logs
  console.info(`[location] ${found.status}`);
  if (found.status === 'unavailable') return privateJson(503, { status: 'unavailable' });
  return privateJson(200, { status: 'ok', places: found.places, attribution: GEOCODE_ATTRIBUTION });
};
