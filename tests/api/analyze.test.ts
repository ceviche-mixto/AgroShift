import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClimateEvidence, EvidenceRecord, FarmInput, Finding, Plan } from '../../src/domain/contracts.ts';
import { analyzeResponseSchema } from '../../src/domain/schemas.ts';
import { POST } from '../../src/pages/api/analyze.ts';
import { analyze, compactEvidence, referenceWindow, type AnalyzeDeps } from '../../src/services/analysis.ts';
import { verifyContext } from '../../src/services/bedrock/context.ts';
import { SNAPSHOTS } from '../../src/services/nasa/fallback.ts';
import { getClimateEvidence, type Cache, type Provider } from '../../src/services/nasa/index.ts';

// Hermético: proveedores, caché compartida, presupuesto y motor se sustituyen por dobles.

const now = new Date('2026-11-14T12:00:00Z');
const window = referenceWindow(now);
const input: FarmInput = {
  location: { lat: -6.77, lon: -79.84, origin: 'gps', accuracyM: 30 },
  crop: { status: 'known', stage: 'last_harvested', name: 'Arroz del lote de Juana' },
  goal: 'save_water',
  water: 'limited',
  planting: { status: 'known', date: '2026-12-01', precision: 'month' },
};

const record = (source: 'power' | 'firms', retrievedAt = now.toISOString()): EvidenceRecord => ({
  id: `${source}:test`,
  source,
  dataset: { id: 'TEST', url: 'https://example.org/', product: 'Producto de prueba', version: '1' },
  variable: source === 'power' ? 'T2M' : 'Focos de calor',
  unit: source === 'power' ? 'C' : 'detecciones',
  kind: source === 'power' ? 'modeled_estimate' : 'observation',
  grid: { cellId: `${source}:celda`, lat: -7, lon: -80, nativeResolution: '0.5°' },
  period: source === 'power' ? window : { start: '2026-11-13', end: '2026-11-14' },
  retrievedAt,
  coverage: { status: 'complete', validCount: 2, expectedCount: 2, quality: [] },
  cache: { origin: 'live', expiresAt: null },
  limitations: [],
  data:
    source === 'power'
      ? { type: 'series', step: 'day', points: [{ t: '2025-01-01', v: 24 }, { t: '2025-01-02', v: 26 }, { t: '2025-02-01', v: null }] }
      : { type: 'detections', items: [{ acquiredAt: '2026-11-14T06:00:00Z', confidence: 'nominal', distanceKm: 4.2 }] },
});

const provider = (source: 'power' | 'firms', live: Provider['live']): Provider => ({
  source,
  key: (q) => ({ source, productVersion: 'test', schemaVersion: 1, cellId: `${source}:celda`, windowStart: q.window.start, windowEnd: q.window.end }),
  ttlMs: 60_000,
  usableMs: 60_000,
  maxObservationAgeDays: null,
  live,
});
const working = [
  provider('power', async () => ({ records: [record('power')], observedUntil: '2025-01-02' })),
  provider('firms', async () => ({ records: [record('firms')], observedUntil: '2026-11-14' })),
];

/** Caché en memoria con una sola concesión por clave. `calls` guarda todo lo que se le envía. */
function memoryCache() {
  const rows = new Map<string, Parameters<Cache['publish']>[1]>();
  const leases = new Set<string>();
  const calls: unknown[] = [];
  const cache: Cache = {
    read: async (key) => {
      calls.push(key);
      const row = rows.get(JSON.stringify(key));
      return row ? { records: row.records, retrievedAt: row.retrievedAt, expiresAt: row.expiresAt, fresh: true, ageSeconds: 0 } : null;
    },
    acquire: async (key) => {
      calls.push(key);
      const id = JSON.stringify(key);
      if (leases.has(id)) return null;
      leases.add(id);
      return { id: 1, holder: id };
    },
    publish: async (lease, entry) => {
      calls.push(entry);
      rows.set(lease.holder, entry);
      return true;
    },
    release: async () => true,
  };
  return { cache, calls };
}
const down: Cache = {
  read: async () => Promise.reject(new Error('supabase caído')),
  acquire: async () => Promise.reject(new Error('supabase caído')),
  publish: async () => Promise.reject(new Error('supabase caído')),
  release: async () => Promise.reject(new Error('supabase caído')),
};

const finding: Finding = { id: 'reason.test', ruleId: 'rule.test', evidenceIds: ['power:test'], params: {} };
const plan = (role: 'A' | 'B'): Plan => ({
  role,
  completeness: 'complete',
  kind: 'crop',
  scenario: role === 'A' ? { id: 'reference', nature: 'observed_reference' } : { id: 'limited_water', nature: 'hypothetical' },
  cropIds: ['frijol'],
  reasons: [finding],
  restrictions: [],
  actions: [],
  reconsiderSignals: [],
  toVerify: [],
});
/** Motor doble: hay plan solo si llegó evidencia de clima. */
const engine: NonNullable<AnalyzeDeps['engine']> = (_input, climate) =>
  climate.records.some((r) => r.source === 'power')
    ? { status: 'ok', engineVersion: 'test', planA: plan('A'), planB: plan('B'), missing: [] }
    : { status: 'insufficient_evidence', engineVersion: 'test', planA: null, planB: null, missing: [{ ...finding, evidenceIds: [] }] };

const withClimate = (o: Parameters<typeof getClimateEvidence>[1]): AnalyzeDeps['climate'] => (q, base) =>
  getClimateEvidence(q, { ...base, snapshots: [], ...o });
const deps = (o: Partial<AnalyzeDeps> = {}): AnalyzeDeps => ({ now: () => now, engine, consume: async () => true, secret: 's3cr3t0-de-prueba', ...o });
const stateOf = (e: ClimateEvidence, source: string) => e.sources.find((s) => s.source === source)?.state;

afterEach(() => vi.useRealTimers());

describe('POST /api/analyze: entrada', () => {
  it('rechaza entrada inválida con Zod antes de procesar', async () => {
    const climate = vi.fn();
    const out = await analyze({ ...input, location: { ...input.location, lat: 95 } }, deps({ climate }));
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ status: 'invalid_input', issues: [{ path: 'location.lat' }] });
    expect(climate).not.toHaveBeenCalled();
  });

  it('la ruta acota el tamaño del cuerpo y responde privado, sin almacenar', async () => {
    const request = (body: string) => new Request('http://localhost/api/analyze', { method: 'POST', body });
    for (const body of ['x'.repeat(5_000), '{"roto":', '']) {
      const res = await POST({ request: request(body) } as Parameters<typeof POST>[0]);
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toMatchObject({ status: 'invalid_input' });
    }
  });
});

describe('POST /api/analyze: orquestación', () => {
  it('responde con el contrato, evidencia compacta, alerta vigente y contexto firmado sin ubicación', async () => {
    const { cache } = memoryCache();
    const out = await analyze(input, deps({ climate: withClimate({ cache, providers: working }) }));
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    const body = analyzeResponseSchema.parse(out.body);
    expect(body.result.status).toBe('ok');
    expect(body.result.climate.query.window).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    // Serie diaria resumida a meses; el faltante sigue siendo null
    const power = body.result.climate.records.find((r) => r.source === 'power')!;
    expect(power.data).toEqual({ type: 'series', step: 'month', points: [{ t: '2025-01', v: 25 }, { t: '2025-02', v: null }] });
    expect(body.alerts).toEqual([{ id: 'fire_hotspot_nearby', evidenceId: 'firms:test', count: 1, nearestKm: 4.2, latestAt: '2026-11-14T06:00:00Z' }]);
    const facts = verifyContext(body.explain, 's3cr3t0-de-prueba', now);
    expect(facts?.planA?.cropIds).toEqual(['frijol']);
    expect(Buffer.from(body.explain!.split('.')[0]!, 'base64url').toString()).not.toMatch(/-6\.77|-79\.84|Juana|celda/);
  });

  it('no emite una alerta de fuego con una recuperación antigua', async () => {
    const old = provider('firms', async () => ({ records: [record('firms', '2026-11-14T09:00:00Z')], observedUntil: '2026-11-14' }));
    const out = await analyze(input, deps({ climate: withClimate({ cache: memoryCache().cache, providers: [working[0]!, old] }) }));
    expect(out.status === 200 && out.body.alerts).toEqual([]);
  });

  it('miss concurrente: una sola solicitud refresca y la otra devuelve lo disponible', async () => {
    const { cache } = memoryCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const live = vi.fn(async () => {
      await gate;
      return { records: [record('power')], observedUntil: '2025-01-02' as const };
    });
    const climate = withClimate({ cache, providers: [provider('power', live)] });
    const both = Promise.all([analyze(input, deps({ climate })), analyze(input, deps({ climate }))]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await both;
    expect(live).toHaveBeenCalledTimes(1);
    expect([a.status, b.status]).toEqual([200, 200]);
    const states = [a, b].map((o) => (o.status === 200 ? o.body.result.climate.sources.find((s) => s.source === 'power') : null));
    expect(states.map((s) => s?.state).sort()).toEqual(['available', 'unavailable']);
    expect(states.find((s) => s?.state === 'unavailable')?.detail).toBe('refresco_en_curso');
  });

  it('Supabase caído: aplica el respaldo local sin abrir llamadas en vivo', async () => {
    const live = vi.fn(async () => ({ records: [record('power')], observedUntil: null }));
    const consume = vi.fn(async () => Promise.reject(new Error('supabase caído')));
    const out = await analyze(
      input,
      deps({ consume, climate: withClimate({ cache: down, providers: [provider('power', live), provider('firms', live)], snapshots: SNAPSHOTS }) }),
    );
    expect(live).not.toHaveBeenCalled();
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    const { climate } = out.body.result;
    // Vale solo el respaldo de la misma celda y ventana, con su vigencia marcada
    expect(new Set(climate.records.map((r) => r.cache.origin))).toEqual(new Set(['local_snapshot']));
    expect(climate.records.every((r) => r.period.start >= window.start && r.period.end <= window.end)).toBe(true);
    expect(stateOf(climate, 'power')).toBe('stale');
    expect(stateOf(climate, 'giovanni')).toBe('stale');
    // FIRMS no tiene respaldo: queda no disponible, sin consulta en vivo
    expect(climate.sources.find((s) => s.source === 'firms')).toMatchObject({ state: 'unavailable', detail: 'cupo_agotado' });
  });

  it('una fuente detenida no impide la respuesta parcial antes de 7 s', async () => {
    vi.useFakeTimers();
    const hung = provider('power', () => new Promise(() => {}));
    const pending = analyze(input, deps({ climate: withClimate({ cache: memoryCache().cache, providers: [hung, working[1]!] }) }));
    await vi.advanceTimersByTimeAsync(6_100);
    const out = await pending;
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(stateOf(out.body.result.climate, 'firms')).toBe('available');
    expect(stateOf(out.body.result.climate, 'power')).toBe('unavailable');
    expect(out.body.result.status).toBe('insufficient_evidence');
  });

  it('plazo absoluto: si la orquestación no vuelve, responde antes de 7 s y corta el trabajo', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const climate: AnalyzeDeps['climate'] = (_q, o) => {
      signal = o?.signal;
      return new Promise(() => {});
    };
    const pending = analyze(input, deps({ climate }));
    await vi.advanceTimersByTimeAsync(6_600);
    const out = await pending;
    expect(signal?.aborted).toBe(true);
    expect(out.status === 200 && out.body.result.climate.sources.every((s) => s.state === 'unavailable')).toBe(true);
  });

  it('presupuesto agotado sin evidencia: 429 con indicación de reintento', async () => {
    const live = vi.fn(async () => ({ records: [record('power')], observedUntil: null }));
    const out = await analyze(
      input,
      deps({ consume: async () => false, climate: withClimate({ cache: memoryCache().cache, providers: [provider('power', live)] }) }),
    );
    expect(live).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: 429, body: { status: 'rate_limited' } });
    expect(out.status === 429 && out.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(out.status === 429 && out.body.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('la caché compartida y el presupuesto no reciben datos de la parcela', async () => {
    const { cache, calls } = memoryCache();
    const consume = vi.fn(async (_operation: string, _intervalSeconds: number, _limit: number) => true);
    await analyze(input, deps({ consume, climate: withClimate({ cache, providers: working }) }));
    const shared = JSON.stringify([calls, consume.mock.calls]);
    expect(calls.length).toBeGreaterThan(0);
    expect(shared).not.toMatch(/-6\.77|-79\.84|Juana|Arroz|save_water|limited|2026-12-01|accuracy/);
    expect(consume.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['refresh:power', 'refresh:firms']));
  });
});

describe('evidencia compacta', () => {
  it('no toca series mensuales ni estadísticos', () => {
    const monthly: EvidenceRecord = { ...record('power'), data: { type: 'series', step: 'month', points: [{ t: '2025-01', v: 1 }] } };
    const e: ClimateEvidence = { query: { lat: 0, lon: 0, window }, assembledAt: now.toISOString(), sources: [{ source: 'power', state: 'available', ageSeconds: 0, detail: null }], records: [monthly] };
    expect(compactEvidence(e).records[0]).toEqual(monthly);
  });
});
