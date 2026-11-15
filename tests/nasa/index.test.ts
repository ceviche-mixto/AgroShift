import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClimateQuery, EvidenceRecord } from '../../src/domain/contracts.ts';
import { climateEvidenceSchema } from '../../src/domain/schemas.ts';
import { SNAPSHOTS } from '../../src/services/nasa/fallback.ts';
import { activeFirmsAlert } from '../../src/services/nasa/firms.ts';
import { getClimateEvidence, PROVIDERS, type Cache, type Provider } from '../../src/services/nasa/index.ts';
import type { ClimateKey } from '../../src/services/supabase/cache.ts';

// Todo hermético: la red y Supabase se sustituyen por dobles en memoria.

const HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';
const AVAIL = 'data_id,min_date,max_date\nVIIRS_NOAA20_NRT,2026-08-01,2026-11-15';
const POWER = JSON.stringify({
  properties: {
    parameter: {
      PRECTOTCORR: { '20251230': 0.4, '20251231': 0.1, '20260101': 0.2, '20260102': 0.3 },
      T2M: { '20251230': 21.1, '20251231': 21.3, '20260101': 21.5, '20260102': -999 },
    },
  },
  header: { api: { version: 'v2.10.3' }, sources: ['MERRA2'], fill_value: -999.0, time_standard: 'LST' },
  parameters: { PRECTOTCORR: { units: 'mm/day' }, T2M: { units: 'C' } },
});
const q: ClimateQuery = { lat: -6.77, lon: -79.84, window: { start: '2025-12-30', end: '2026-01-02' } };
const t0 = new Date('2026-01-02T12:00:00Z');
const at = (ms: number) => () => new Date(t0.getTime() + ms);
const MIN = 60_000;
const DAY = 86_400_000;

type Mode = 'ok' | '500' | 'hang';
function network(mode: { power: Mode; firms: Mode }, firmsRow = '') {
  return vi.fn(async (u: string | URL | Request) => {
    const url = String(u);
    const m = url.includes('power.larc') ? mode.power : mode.firms;
    if (m === 'hang') return new Promise<Response>(() => {});
    if (m === '500') return new Response('x', { status: 500 });
    if (url.includes('power.larc')) return new Response(POWER);
    return new Response(url.includes('data_availability') ? AVAIL : [HEADER, firmsRow].filter(Boolean).join('\n'));
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function memoryCache() {
  const rows = new Map<string, { records: EvidenceRecord[]; retrievedAt: string; expiresAt: string; usableUntil: string; lease?: string }>();
  const id = (k: ClimateKey) => JSON.stringify(k);
  const cache: Cache = {
    read: async (key, now = new Date()) => {
      const r = rows.get(id(key));
      if (!r?.usableUntil || now.getTime() >= Date.parse(r.usableUntil)) return null;
      return { records: r.records, retrievedAt: r.retrievedAt, expiresAt: r.expiresAt, fresh: now.getTime() < Date.parse(r.expiresAt), ageSeconds: Math.floor((now.getTime() - Date.parse(r.retrievedAt)) / 1000) };
    },
    acquire: async (key) => {
      const r = rows.get(id(key));
      if (r?.lease) return null;
      rows.set(id(key), { ...(r ?? { records: [], retrievedAt: '', expiresAt: '', usableUntil: '' }), lease: 'x' });
      return { id: 1, holder: id(key) };
    },
    publish: async (lease, e) => {
      rows.set(lease.holder, { records: e.records, retrievedAt: e.retrievedAt, expiresAt: e.expiresAt, usableUntil: e.usableUntil });
      return true;
    },
    release: async (lease) => {
      const r = rows.get(lease.holder);
      if (r) delete r.lease;
      return true;
    },
  };
  return { cache, rows };
}

const stateOf = (e: Awaited<ReturnType<typeof getClimateEvidence>>, s: string) => e.sources.find((x) => x.source === s);
const origins = (e: Awaited<ReturnType<typeof getClimateEvidence>>, s: string) => [...new Set(e.records.filter((r) => r.source === s).map((r) => r.cache.origin))];

let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.FIRMS_MAP_KEY;
  process.env.FIRMS_MAP_KEY = 'TEST-KEY';
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.FIRMS_MAP_KEY;
  else process.env.FIRMS_MAP_KEY = savedKey;
});
afterEach(() => vi.useRealTimers());

describe('parámetros por fuente', () => {
  it('TTL y uso máximo iniciales', () => {
    const p = Object.fromEntries(PROVIDERS.map((x) => [x.source, x]));
    expect(p.power).toMatchObject({ ttlMs: 24 * 3_600_000, usableMs: 7 * DAY, maxObservationAgeDays: 10 });
    expect(p.smap).toMatchObject({ ttlMs: 24 * 3_600_000, usableMs: 7 * DAY, maxObservationAgeDays: 10 });
    expect(p.giovanni).toMatchObject({ ttlMs: 30 * DAY, usableMs: 180 * DAY, maxObservationAgeDays: 90 });
    expect(p.firms).toMatchObject({ ttlMs: 15 * MIN, usableMs: 60 * MIN });
    expect(p.smap?.live).toBeUndefined();
    expect(p.giovanni?.live).toBeUndefined();
  });
});

describe('getClimateEvidence', () => {
  it('una fuente lenta no bloquea a las demás: vence a los 6 s y deja pasar lo válido', async () => {
    vi.useFakeTimers({ now: t0 });
    const { cache } = memoryCache();
    const p = getClimateEvidence(q, { fetch: network({ power: 'ok', firms: 'hang' }), cache, snapshots: [], now: at(0) });
    await vi.advanceTimersByTimeAsync(5999);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const ev = await p;
    expect(stateOf(ev, 'firms')).toMatchObject({ state: 'unavailable', detail: 'plazo_agotado' });
    expect(stateOf(ev, 'power')?.state).toBe('partial');
    expect(ev.records.filter((r) => r.source === 'power')).toHaveLength(2);
    expect(stateOf(ev, 'smap')).toMatchObject({ state: 'insufficient_coverage' });
    expect(climateEvidenceSchema.safeParse(ev).success).toBe(true);
  });

  it('una fuente caída (HTTP 500) deja pasar a las demás', async () => {
    const { cache } = memoryCache();
    const ev = await getClimateEvidence(q, { fetch: network({ power: '500', firms: 'ok' }), cache, snapshots: [], now: at(0), random: () => 0, deadlineMs: 50 });
    expect(stateOf(ev, 'power')).toMatchObject({ state: 'unavailable', ageSeconds: null });
    expect(ev.records.some((r) => r.source === 'power')).toBe(false);
    expect(stateOf(ev, 'firms')?.state).toBe('available');
    expect(ev.records.some((r) => r.source === 'firms')).toBe(true);
  });

  it('una repetición usa la caché compartida sin volver a consultar', async () => {
    const { cache } = memoryCache();
    const net = network({ power: 'ok', firms: 'ok' });
    const first = await getClimateEvidence(q, { fetch: net, cache, snapshots: [], now: at(0) });
    expect(origins(first, 'power')).toEqual(['live']);
    const calls = net.mock.calls.length;
    const second = await getClimateEvidence(q, { fetch: net, cache, snapshots: [], now: at(5 * MIN) });
    expect(net.mock.calls.length).toBe(calls);
    expect(origins(second, 'power')).toEqual(['shared_cache']);
    expect(origins(second, 'firms')).toEqual(['shared_cache']);
    expect(stateOf(second, 'power')?.ageSeconds).toBe(300);
  });

  it('vencida la vigencia y con el proveedor caído, usa la instantánea previa con su edad', async () => {
    const { cache } = memoryCache();
    await getClimateEvidence(q, { fetch: network({ power: 'ok', firms: 'ok' }), cache, snapshots: [], now: at(0) });
    const ev = await getClimateEvidence(q, { fetch: network({ power: '500', firms: 'ok' }), cache, snapshots: [], now: at(2 * DAY), random: () => 0, deadlineMs: 50 });
    expect(origins(ev, 'power')).toEqual(['stale_snapshot']);
    expect(stateOf(ev, 'power')).toMatchObject({ state: 'stale', ageSeconds: 2 * 86400, detail: 'instantanea_previa' });
    // pasado el uso máximo (7 días) ya no se usa
    const old = await getClimateEvidence(q, { fetch: network({ power: '500', firms: 'ok' }), cache, snapshots: [], now: at(8 * DAY), random: () => 0, deadlineMs: 50 });
    expect(stateOf(old, 'power')?.state).toBe('unavailable');
  });

  it('el JSON local solo se acepta con la misma celda y ventana; fuera de cobertura se descarta', async () => {
    const down = network({ power: '500', firms: '500' });
    const { cache } = memoryCache();
    const demo = { lat: -6.77, lon: -79.84, window: { start: '2025-01-01', end: '2025-12-31' } };
    const base = { fetch: down, cache, snapshots: SNAPSHOTS, now: at(0), random: () => 0, deadlineMs: 50 };

    const hit = await getClimateEvidence(demo, base);
    expect(origins(hit, 'power')).toEqual(['local_snapshot']);
    expect(hit.records.filter((r) => r.source === 'power')).toHaveLength(6);
    expect(stateOf(hit, 'power')).toMatchObject({ state: 'stale', detail: 'respaldo_local' });
    // otra celda MERRA-2 y CERES: descartado
    const otherCell = await getClimateEvidence({ ...demo, lat: -5.0 }, base);
    expect(stateOf(otherCell, 'power')).toMatchObject({ state: 'unavailable' });
    expect(otherCell.records.some((r) => r.source === 'power')).toBe(false);
    // misma celda, otra ventana: descartado
    const otherWindow = await getClimateEvidence({ ...demo, window: { start: '2025-01-01', end: '2025-12-30' } }, base);
    expect(otherWindow.records.some((r) => r.source === 'power')).toBe(false);
    // India y Kenia tienen su propio respaldo
    const india = await getClimateEvidence({ lat: 12.97, lon: 77.59, window: demo.window }, base);
    expect(india.records.filter((r) => r.source === 'power' && r.grid.cellId.startsWith('merra2:13:'))).toHaveLength(5);
  });

  it('no emite una alerta FIRMS antigua como actual', async () => {
    const { cache } = memoryCache();
    const row = '-6.8,-79.8,333,0.4,0.4,2026-01-02,800,N20,VIIRS,n,2.0NRT,300,4.6,D';
    const first = await getClimateEvidence(q, { fetch: network({ power: 'ok', firms: 'ok' }, row), cache, snapshots: [], now: at(0) });
    const rec = first.records.find((r) => r.source === 'firms')!;
    expect(activeFirmsAlert(rec, t0).active).toBe(true);

    const down = network({ power: 'ok', firms: '500' });
    const later = await getClimateEvidence(q, { fetch: down, cache, snapshots: [], now: at(40 * MIN), random: () => 0, deadlineMs: 50 });
    const stale = later.records.find((r) => r.source === 'firms')!;
    expect(stateOf(later, 'firms')?.state).toBe('stale');
    expect(activeFirmsAlert(stale, at(40 * MIN)()).active).toBe(true); // recuperación de hace 40 min: aún cabe
    expect(activeFirmsAlert(stale, at(61 * MIN)()).active).toBe(false);

    const gone = await getClimateEvidence(q, { fetch: down, cache, snapshots: [], now: at(90 * MIN), random: () => 0, deadlineMs: 50 });
    expect(gone.records.some((r) => r.source === 'firms')).toBe(false);
    expect(stateOf(gone, 'firms')?.state).toBe('unavailable');
  });

  it('Supabase caído: consulta en vivo sin caché', async () => {
    const boom = async () => {
      throw new Error('supabase caído');
    };
    const cache: Cache = { read: boom, acquire: boom, publish: boom, release: boom };
    const ev = await getClimateEvidence(q, { fetch: network({ power: 'ok', firms: 'ok' }), cache, snapshots: [], now: at(0) });
    expect(origins(ev, 'power')).toEqual(['live']);
    expect(stateOf(ev, 'power')?.state).toBe('partial');
  });

  it('si otra instancia tiene la concesión no consulta y sirve lo previo', async () => {
    const { cache } = memoryCache();
    await getClimateEvidence(q, { fetch: network({ power: 'ok', firms: 'ok' }), cache, snapshots: [], now: at(0) });
    const busy: Cache = { ...cache, acquire: async () => null };
    const net = network({ power: 'ok', firms: 'ok' });
    const ev = await getClimateEvidence(q, { fetch: net, cache: busy, snapshots: [], now: at(2 * DAY) });
    expect(net).not.toHaveBeenCalled();
    expect(origins(ev, 'power')).toEqual(['stale_snapshot']);
    // Sin dato previo: la fuente queda no disponible con motivo, para que el cliente reintente
    const miss = await getClimateEvidence(q, { fetch: net, cache: { ...busy, read: async () => null }, snapshots: [], now: at(2 * DAY) });
    expect(net).not.toHaveBeenCalled();
    expect(miss.sources.find((x) => x.source === 'power')).toMatchObject({ state: 'unavailable', detail: 'refresco_en_curso' });
  });

  it('un complemento verificado pasa por el mismo camino de procedencia', async () => {
    const { cache } = memoryCache();
    const net = network({ power: 'ok', firms: 'ok' });
    const base = await getClimateEvidence(q, { fetch: net, cache, snapshots: [], now: at(0) });
    const seed = base.records.find((r) => r.source === 'power')!;
    const complement: Provider = {
      source: 'complement',
      key: () => ({ source: 'complement', productVersion: 'local-1', schemaVersion: 1, cellId: 'local:cell', windowStart: q.window.start, windowEnd: q.window.end }),
      ttlMs: DAY,
      usableMs: DAY,
      maxObservationAgeDays: null,
      live: async () => ({ records: [{ ...seed, id: 'complement:x', source: 'complement' }], observedUntil: null }),
    };
    const ev = await getClimateEvidence(q, { fetch: net, cache, snapshots: [], now: at(0), providers: [complement] });
    expect(stateOf(ev, 'complement')?.state).toBe('available');
    expect(ev.records.filter((r) => r.source === 'complement')).toHaveLength(1);
  });

  it('una observación demasiado antigua para una evaluación actual marca la fuente como vencida', async () => {
    const { cache } = memoryCache();
    // ahora = 30 días después del último dato: la ventana pide el presente pero el dato es viejo
    const late = { ...q, window: { start: '2025-12-30', end: '2026-02-01' } };
    const ev = await getClimateEvidence(late, { fetch: network({ power: 'ok', firms: 'ok' }), cache, snapshots: [], now: at(30 * DAY) });
    expect(stateOf(ev, 'power')).toMatchObject({ state: 'stale', detail: 'observacion_antigua' });
  });
});
