import { createClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import type { EvidenceRecord } from '../../src/domain/contracts';
import {
  acquireClimateRefresh,
  consumeBudget,
  publishClimateRefresh,
  readClimate,
  releaseClimateRefresh,
  type ClimateKey,
} from '../../src/services/supabase/cache';
import { getServerSupabase } from '../../src/services/supabase/server';

// Prueba contra el proyecto real. Solo corre con `npm run test:live` (carga `.env`).
const live = Boolean(process.env.SUPABASE_SECRET_KEY && process.env.PUBLIC_SUPABASE_URL);
const run = crypto.randomUUID();
const key: ClimateKey = {
  source: 'power',
  productVersion: 'test',
  schemaVersion: 1,
  cellId: `test:${run}`,
  windowStart: '2025-01-01',
  windowEnd: '2025-01-02',
};
const operation = `test:${run}`;

const record = (value: number): EvidenceRecord => ({
  id: `power:T2M:${key.cellId}`,
  source: 'power',
  dataset: { id: 'NASA/POWER', url: 'https://power.larc.nasa.gov/', product: 'POWER Daily', version: 'test' },
  variable: 'T2M',
  unit: 'C',
  kind: 'modeled_estimate',
  grid: { cellId: key.cellId, lat: -7, lon: -80, nativeResolution: '0.5° x 0.625°' },
  period: { start: key.windowStart, end: key.windowEnd },
  retrievedAt: new Date().toISOString(),
  coverage: { status: 'partial', validCount: 1, expectedCount: 2, quality: [] },
  cache: { origin: 'live', expiresAt: null },
  limitations: [],
  data: { type: 'series', step: 'day', points: [{ t: '2025-01-01', v: value }, { t: '2025-01-02', v: null }] },
});
const entry = (value: number, observedUntil: string, ttlMs = 60_000) => ({
  records: [record(value)],
  observedUntil,
  retrievedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  usableUntil: new Date(Date.now() + ttlMs + 60_000).toISOString(),
});
const firstValue = (cached: Awaited<ReturnType<typeof readClimate>>) => {
  const data = cached?.records[0]?.data;
  return data?.type === 'series' ? data.points.map((p) => p.v) : undefined;
};

describe.skipIf(!live)('caché compartida en Supabase (en vivo)', () => {
  afterAll(async () => {
    const db = getServerSupabase();
    await db.from('climate_cache').delete().eq('cell_id', key.cellId);
    await db.from('request_budget').delete().eq('operation', operation);
  });

  it('niega lectura, escritura y funciones al rol público', async () => {
    const anon = createClient(process.env.PUBLIC_SUPABASE_URL!, process.env.PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false },
    });
    const read = await anon.from('climate_cache').select('id').limit(1);
    const write = await anon.from('request_budget').insert({
      operation,
      interval_start: new Date().toISOString(),
      used: 1,
      expires_at: new Date().toISOString(),
    });
    const rpc = await anon.rpc('consume_request_budget', { p_operation: operation, p_interval_seconds: 60, p_limit: 5 });
    expect(read.error).not.toBeNull();
    expect(write.error).not.toBeNull();
    expect(rpc.error).not.toBeNull();
  });

  it('concede el refresco a una sola solicitud y condiciona la publicación al titular', async () => {
    expect(await readClimate(key)).toBeNull();

    const attempts = await Promise.all(Array.from({ length: 5 }, () => acquireClimateRefresh(key, 30)));
    const granted = attempts.filter((lease) => lease !== null);
    expect(granted).toHaveLength(1);
    const lease = granted[0]!;

    // La fila reservada todavía no tiene datos.
    expect(await readClimate(key)).toBeNull();
    // Un titular ajeno no publica ni libera.
    const intruder = { id: lease.id, holder: crypto.randomUUID() };
    expect(await publishClimateRefresh(intruder, entry(99, '2025-01-01'))).toBe(false);
    expect(await releaseClimateRefresh(intruder)).toBe(false);

    expect(await publishClimateRefresh(lease, entry(24.5, '2025-01-01'))).toBe(true);
    const cached = await readClimate(key);
    expect(cached?.fresh).toBe(true);
    expect(firstValue(cached)).toEqual([24.5, null]);
    // La concesión ya se liberó: no se publica dos veces con ella.
    expect(await publishClimateRefresh(lease, entry(1, '2025-01-01'))).toBe(false);
  });

  it('no concede refresco con dato vigente, y al forzar conserva la observación más reciente', async () => {
    expect(await acquireClimateRefresh(key, 30)).toBeNull();

    const forced = await acquireClimateRefresh(key, 30, true);
    expect(forced).not.toBeNull();
    expect(await publishClimateRefresh(forced!, entry(1, '2024-12-31'))).toBe(true);
    expect(firstValue(await readClimate(key))).toEqual([24.5, null]);

    const newer = await acquireClimateRefresh(key, 30, true);
    expect(await publishClimateRefresh(newer!, entry(26, '2025-01-02'))).toBe(true);
    expect(firstValue(await readClimate(key))).toEqual([26, null]);
  });

  it('distingue dato vigente, instantánea previa y dato fuera de uso permitido', async () => {
    const lease = await acquireClimateRefresh(key, 30, true);
    expect(await publishClimateRefresh(lease!, entry(27, '2025-01-02', 60_000))).toBe(true);
    expect((await readClimate(key, new Date(Date.now() + 90_000)))?.fresh).toBe(false);
    expect(await readClimate(key, new Date(Date.now() + 180_000))).toBeNull();
  });

  it('libera la concesión cuando el proveedor falla y otra instancia puede tomarla', async () => {
    const lease = await acquireClimateRefresh(key, 30, true);
    expect(await acquireClimateRefresh(key, 30, true)).toBeNull();
    expect(await releaseClimateRefresh(lease!)).toBe(true);
    const next = await acquireClimateRefresh(key, 30, true);
    expect(next).not.toBeNull();
    await releaseClimateRefresh(next!);
  });

  it('agota el presupuesto compartido de forma atómica', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => consumeBudget(operation, 3600, 4)));
    expect(results.filter(Boolean)).toHaveLength(4);
    expect(await consumeBudget(operation, 3600, 4)).toBe(false);
  });
});
