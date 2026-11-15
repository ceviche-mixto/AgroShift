import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FarmInput } from '../../src/domain/contracts.ts';
import { analyzeResponseSchema } from '../../src/domain/schemas.ts';
import { referenceWindow as serverWindow } from '../../src/services/analysis.ts';
import { analyzeFarm, CLIENT_TIMEOUT_MS, type AnalyzeOptions, type AnalyzeSuccess } from '../../src/services/browser/analyze.ts';
import { loadLocalSnapshots, LOCAL_SNAPSHOT_URLS, referenceWindow } from '../../src/services/browser/local.ts';
import { createStorage } from '../../src/services/browser/storage.ts';
import { CASES, farm, json, NOW, OUTSIDE, responseFor, serveData, SNAPSHOTS } from './fixtures.ts';

const chiclayo = farm(CASES[0].lat, CASES[0].lon);
const india = farm(CASES[1].lat, CASES[1].lon);
const kenia = farm(CASES[2].lat, CASES[2].lon);
const memory = () => createStorage({ indexedDB: null, localStorage: null, now: () => NOW });
const idb = () => createStorage({ indexedDB: new IDBFactory(), localStorage: null, now: () => NOW });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | null;
/** fetch simulado: la ruta /api/analyze la decide `api`; los JSON científicos salen de disco. */
function fakeFetch(api: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const res = url.includes('/api/analyze') ? await api(url, init) : serveData(url);
    if (!res) throw new TypeError('Failed to fetch');
    return res;
  });
  return Object.assign(fn as unknown as typeof fetch, { calls });
}
const offline = () => fakeFetch(() => null);
const opts = (f: typeof fetch, extra: AnalyzeOptions = {}): AnalyzeOptions => ({ fetch: f, now: () => NOW, storage: memory(), ...extra });
const result = (o: Awaited<ReturnType<typeof analyzeFarm>>): AnalyzeSuccess => {
  if (o.kind !== 'result') throw new Error(`se esperaba result y llegó ${o.kind}`);
  return o;
};
/** Fetch que solo termina cuando se llama a `finish`; rechaza si se cancela. */
function slow(honorAbort = true) {
  let finish!: (r: Response) => void;
  const aborted = { value: false };
  const fn = vi.fn((_u: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      finish = resolve;
      init?.signal?.addEventListener('abort', () => {
        aborted.value = true;
        if (honorAbort) reject(new DOMException('abortado', 'AbortError'));
      });
    });
  });
  return { fetch: fn as unknown as typeof fetch, finish: (r: Response) => finish(r), aborted };
}

afterEach(() => vi.useRealTimers());

describe('red disponible', () => {
  it('POST /api/analyze, valida, devuelve origin network y guarda instantánea y último plan', async () => {
    const res = responseFor(chiclayo);
    const f = fakeFetch(() => json(200, res));
    const storage = idb();
    const out = result(await analyzeFarm(chiclayo, opts(f, { storage })));
    expect(out).toMatchObject({ origin: 'network', stale: false, savedAt: NOW.toISOString() });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ url: '/api/analyze' });
    expect(f.calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual(chiclayo);
    expect((await storage.getSnapshot(chiclayo))?.response).toEqual(res);
    expect((await storage.loadLast())?.input).toEqual(chiclayo);
  });

  it('entrega primero la caché local (con edad y vigencia) y luego actualiza con la red', async () => {
    const storage = idb();
    const old = responseFor(chiclayo);
    await storage.putSnapshot(chiclayo, old, new Date(NOW.getTime() - 25 * 3_600_000).toISOString());
    const fresh = { ...responseFor(chiclayo), explain: 'ctx' };
    const seen: string[] = [];
    const out = await analyzeFarm(
      chiclayo,
      opts(fakeFetch(() => json(200, fresh)), {
        storage,
        onCached: (c) => seen.push(`${c.origin}:${c.stale}:${c.savedAt}`),
      }),
    );
    expect(seen).toEqual([`cache:true:${new Date(NOW.getTime() - 25 * 3_600_000).toISOString()}`]);
    expect(result(out)).toMatchObject({ origin: 'network', stale: false });
    expect(result(out).response.explain).toBe('ctx');
  });

  it('dato de menos de 24 h es fresco', async () => {
    const storage = memory();
    await storage.putSnapshot(chiclayo, responseFor(chiclayo), new Date(NOW.getTime() - 23 * 3_600_000).toISOString());
    const seen: AnalyzeSuccess[] = [];
    await analyzeFarm(chiclayo, opts(offline(), { storage, onCached: (c) => seen.push(c) }));
    expect(seen[0]).toMatchObject({ origin: 'cache', stale: false });
  });

  it('la caché de otra parcela no se entrega', async () => {
    const storage = memory();
    await storage.putSnapshot(india, responseFor(india));
    await storage.saveLast(india, responseFor(india));
    const onCached = vi.fn();
    const out = await analyzeFarm(chiclayo, opts(offline(), { storage, onCached }));
    expect(onCached).not.toHaveBeenCalled();
    expect(result(out).origin).toBe('local'); // cómputo con SU celda, no con la de India
    expect(result(out).response.result.climate.query).toMatchObject({ lat: chiclayo.location.lat, lon: chiclayo.location.lon });
  });

  it('400 → invalid con los issues del contrato', async () => {
    const issues = [{ path: 'location.lat', code: 'too_big' }];
    const out = await analyzeFarm(chiclayo, opts(fakeFetch(() => json(400, { contractVersion: 1, status: 'invalid_input', issues }))));
    expect(out).toEqual({ kind: 'invalid', issues });
  });

  it('entrada inválida en el cliente: invalid sin tocar la red', async () => {
    const f = fakeFetch(() => json(200, {}));
    const out = await analyzeFarm({ ...chiclayo, goal: 'otra' } as unknown as FarmInput, opts(f));
    expect(out.kind).toBe('invalid');
    expect(f.calls).toHaveLength(0);
  });

  it('429 → rate_limited con Retry-After o, sin cabecera, con el cuerpo', async () => {
    const body = { contractVersion: 1, status: 'rate_limited', retryAfterSeconds: 42 };
    expect(await analyzeFarm(chiclayo, opts(fakeFetch(() => json(429, body, { 'retry-after': '17' }))))).toEqual({ kind: 'rate_limited', retryAfterSeconds: 17 });
    expect(await analyzeFarm(chiclayo, opts(fakeFetch(() => json(429, body))))).toEqual({ kind: 'rate_limited', retryAfterSeconds: 42 });
    expect(await analyzeFarm(chiclayo, opts(fakeFetch(() => new Response('', { status: 429 }))))).toEqual({ kind: 'rate_limited', retryAfterSeconds: 60 });
  });
});

describe('dos envíos seguidos y respuestas tardías', () => {
  it('cancela el vuelo anterior y solo se presenta el último', async () => {
    const a = slow();
    const storage = memory();
    const first = analyzeFarm(chiclayo, opts(a.fetch, { storage }));
    const second = analyzeFarm(india, opts(fakeFetch(() => json(200, responseFor(india))), { storage }));
    expect(await first).toEqual({ kind: 'superseded' });
    expect(a.aborted.value).toBe(true);
    expect(result(await second).response.result.climate.query).toMatchObject({ lat: india.location.lat });
    expect(await storage.getSnapshot(chiclayo)).toBeNull();
    expect((await storage.loadLast())?.input).toEqual(india);
  });

  it('una respuesta antigua que llega tarde (sin respetar el abort) se descarta y no se guarda', async () => {
    const a = slow(false);
    const storage = memory();
    const onCached = vi.fn();
    const first = analyzeFarm(chiclayo, opts(a.fetch, { storage, onCached }));
    await vi.waitFor(() => expect(a.fetch).toHaveBeenCalled());
    const second = await analyzeFarm(india, opts(fakeFetch(() => json(200, responseFor(india))), { storage }));
    expect(second.kind).toBe('result');
    a.finish(json(200, responseFor(chiclayo))); // llega tarde
    expect(await first).toEqual({ kind: 'superseded' });
    expect(onCached).not.toHaveBeenCalled();
    expect(await storage.getSnapshot(chiclayo)).toBeNull();
    expect((await storage.loadLast())?.input).toEqual(india);
  });

  it('un 429 o un fallo tardío de la solicitud superada tampoco se presenta', async () => {
    const a = slow(false);
    const first = analyzeFarm(chiclayo, opts(a.fetch));
    await vi.waitFor(() => expect(a.fetch).toHaveBeenCalled());
    await analyzeFarm(india, opts(offline()));
    a.finish(json(429, { contractVersion: 1, status: 'rate_limited', retryAfterSeconds: 5 }));
    expect(await first).toEqual({ kind: 'superseded' });
  });
});

describe('red lenta', () => {
  it('a los 8 s cancela la solicitud y calcula con el JSON científico local', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = slow();
    // La descarga de los JSON locales va por un fetch aparte, como la sirve el service worker
    const out = analyzeFarm(india, opts(a.fetch, { loadLocalSnapshots: async () => SNAPSHOTS }));
    let settled = false;
    void out.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(a.aborted.value).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.aborted.value).toBe(true);
    const r = result(await out);
    expect(CLIENT_TIMEOUT_MS).toBe(8_000);
    expect(r.origin).toBe('local');
  });

  it('a los 8 s prefiere el plan guardado compatible', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const storage = memory();
    await storage.savePlan(india, responseFor(india), 'Mi lote');
    const a = slow();
    const out = analyzeFarm(india, opts(a.fetch, { storage }));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(result(await out)).toMatchObject({ origin: 'saved', stale: false });
  });
});

describe('sin red', () => {
  it('red caída con instantánea de la misma parcela: la devuelve como cache', async () => {
    const storage = memory();
    await storage.putSnapshot(kenia, responseFor(kenia), '2026-11-01T00:00:00Z');
    const out = result(await analyzeFarm(kenia, opts(offline(), { storage })));
    expect(out).toMatchObject({ origin: 'cache', savedAt: '2026-11-01T00:00:00Z', stale: true });
  });

  it('red caída con plan guardado compatible: origin saved; si es de otra parcela no sirve', async () => {
    const storage = memory();
    await storage.savePlan(chiclayo, responseFor(chiclayo), 'Norte');
    expect(result(await analyzeFarm(chiclayo, opts(offline(), { storage }))).origin).toBe('saved');
    const other = await analyzeFarm(OUTSIDE, opts(offline(), { storage }));
    expect(other).toEqual({ kind: 'offline_no_data' });
  });

  it('5xx o cuerpo inválido cuentan como fallo de red', async () => {
    const storage = memory();
    await storage.savePlan(chiclayo, responseFor(chiclayo));
    expect(result(await analyzeFarm(chiclayo, opts(fakeFetch(() => new Response('boom', { status: 503 })), { storage }))).origin).toBe('saved');
    expect(result(await analyzeFarm(chiclayo, opts(fakeFetch(() => json(200, { result: 'nope' })), { storage }))).origin).toBe('saved');
  });

  it.each([
    ['Chiclayo', chiclayo],
    ['India', india],
    ['Kenia', kenia],
  ])('sin plan guardado calcula %s con la instantánea real (siembra 2027)', async (_n, input) => {
    const f = offline();
    const out = result(await analyzeFarm(input, opts(f))); // descarga /data/nasa/*.json con el mismo fetch
    expect(f.calls.map((c) => c.url)).toEqual(['/api/analyze', ...LOCAL_SNAPSHOT_URLS]);
    expect(out).toMatchObject({ origin: 'local', stale: false, savedAt: NOW.toISOString() });
    const { response } = out;
    expect(analyzeResponseSchema.safeParse(response).success).toBe(true);
    expect(response.alerts).toEqual([]);
    expect(response.explain).toBeNull();
    expect(response.result.status).not.toBe('insufficient_evidence');
    const { climate } = response.result;
    expect(climate.query.window).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(climate.records.length).toBeGreaterThan(0);
    expect(climate.records.every((r) => r.cache.origin === 'local_snapshot')).toBe(true);
    expect(climate.sources.find((s) => s.source === 'power')).toMatchObject({ state: 'stale', detail: 'respaldo_local' });
    expect(climate.sources.find((s) => s.source === 'firms')).toMatchObject({ state: 'insufficient_coverage', ageSeconds: null });
  });

  it('fuera de las celdas locales: offline_no_data', async () => {
    expect(await analyzeFarm(OUTSIDE, opts(offline()))).toEqual({ kind: 'offline_no_data' });
  });

  it('misma celda pero otra ventana (año distinto): offline_no_data', async () => {
    const later = () => new Date('2027-03-01T00:00:00Z'); // ventana 2026: las instantáneas son de 2025
    expect(await analyzeFarm(chiclayo, opts(offline(), { now: later }))).toEqual({ kind: 'offline_no_data' });
  });

  it('sin poder descargar el JSON local: offline_no_data', async () => {
    const f = fakeFetch(() => null);
    const out = await analyzeFarm(chiclayo, opts(f, { loadLocalSnapshots: () => loadLocalSnapshots(async () => Promise.reject(new TypeError('offline'))) }));
    expect(out).toEqual({ kind: 'offline_no_data' });
  });

  it('la ventana local es la misma que usa el servidor', () => {
    for (const d of ['2026-01-01T00:00:00Z', '2026-11-15T12:00:00Z', '2030-12-31T23:59:59Z']) {
      expect(referenceWindow(new Date(d))).toEqual(serverWindow(new Date(d)));
    }
  });
});
