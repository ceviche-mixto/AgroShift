import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../src/pages/api/location.ts';
import { clearGeocodeCache, searchPlaces } from '../../src/services/location/geocode.ts';

// Hermético: el proveedor se sustituye por un doble. La forma de la respuesta es la real de Open-Meteo.

const chiclayo = {
  results: [
    { id: 1, name: 'Chiclayo', latitude: -6.77008, longitude: -79.85495, country: 'Perú', admin1: 'Departamento de Lambayeque', admin2: 'Provincia de Chiclayo' },
    { id: 2, name: 'Chiclayo', latitude: -7.9, longitude: -77.28333, country: 'Perú', admin1: 'Departamento de San Martín', admin2: 'Provincia de Mariscal Cáceres' },
    { id: 3, name: 'Chiclayo', latitude: -7.9, longitude: -77.28333, country: 'Perú', admin1: 'Departamento de San Martín', admin2: 'Provincia de Mariscal Cáceres' },
  ],
};
const provider = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

beforeEach(() => clearGeocodeCache());

describe('searchPlaces', () => {
  it('devuelve localidades distintas con detalle y coordenadas redondeadas', async () => {
    const found = await searchPlaces('Chiclayo', { fetch: provider(chiclayo) });
    expect(found).toEqual({
      status: 'ok',
      places: [
        { name: 'Chiclayo', detail: 'Provincia de Chiclayo, Departamento de Lambayeque, Perú', lat: -6.7701, lon: -79.855 },
        { name: 'Chiclayo', detail: 'Provincia de Mariscal Cáceres, Departamento de San Martín, Perú', lat: -7.9, lon: -77.2833 },
      ],
    });
  });

  it('sin coincidencias el proveedor omite `results` y la lista queda vacía', async () => {
    expect(await searchPlaces('zzzz', { fetch: provider({ generationtime_ms: 0.1 }) })).toEqual({ status: 'ok', places: [] });
  });

  it('repetir la búsqueda usa la caché, sin importar mayúsculas', async () => {
    const f = provider(chiclayo);
    await searchPlaces('Chiclayo', { fetch: f });
    await searchPlaces('chiclayo', { fetch: f });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('la caché vence a las 24 h', async () => {
    const f = provider(chiclayo);
    await searchPlaces('Chiclayo', { fetch: f, now: () => 0 });
    await searchPlaces('Chiclayo', { fetch: f, now: () => 25 * 3_600_000 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('proveedor caído, respuesta inválida o plazo vencido: unavailable, sin lanzar ni cachear', async () => {
    expect(await searchPlaces('a1', { fetch: provider({}, 500) })).toEqual({ status: 'unavailable' });
    expect(await searchPlaces('a2', { fetch: provider({ results: [{ name: 'X', latitude: 999, longitude: 0 }] }) })).toEqual({ status: 'unavailable' });
    const slow = vi.fn((_u: unknown, init?: RequestInit) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('abort'))))) as unknown as typeof fetch;
    expect(await searchPlaces('a3', { fetch: slow, deadlineMs: 20 })).toEqual({ status: 'unavailable' });
    const f = provider(chiclayo);
    await searchPlaces('a1', { fetch: f });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/location', () => {
  const call = (body: unknown) =>
    POST({ request: new Request('http://localhost/api/location', { method: 'POST', body: JSON.stringify(body) }) } as Parameters<typeof POST>[0]) as Promise<Response>;

  it('rechaza cuerpos inválidos con 400 y sin cachear', async () => {
    for (const body of [{}, { q: '' }, { q: 'a' }, { q: 'x'.repeat(81) }, { q: 'Lima', extra: 1 }, { q: 5 }]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });
});
