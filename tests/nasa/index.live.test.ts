import { afterAll, describe, expect, it } from 'vitest';
import { getClimateEvidence } from '../../src/services/nasa/index.ts';
import { getServerSupabase } from '../../src/services/supabase/server.ts';

// Orquestador contra POWER, FIRMS y la caché de Supabase reales. Solo con `npm run test:live`.
const live = Boolean(process.env.SUPABASE_SECRET_KEY && process.env.PUBLIC_SUPABASE_URL && process.env.FIRMS_MAP_KEY);
// Ventana propia de la prueba para no tocar filas de otros usos.
const q = { lat: -6.77, lon: -79.84, window: { start: '2025-02-01', end: '2025-02-10' } };

describe.skipIf(!live)('orquestador NASA (en vivo)', () => {
  afterAll(async () => {
    const db = getServerSupabase();
    await db.from('climate_cache').delete().eq('window_start', q.window.start).eq('window_end', q.window.end).eq('source', 'power');
    await db.from('climate_cache').delete().eq('source', 'firms').eq('cell_id', 'firms0.1:-6.8:-79.8').gte('window_start', new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10));
  });

  it('primera llamada en vivo, repetición desde la caché compartida', async () => {
    const first = await getClimateEvidence(q);
    const power = first.records.filter((r) => r.source === 'power');
    expect(power).toHaveLength(6);
    expect(power.every((r) => r.cache.origin === 'live' || r.cache.origin === 'shared_cache')).toBe(true);
    expect(first.sources.find((s) => s.source === 'power')?.state).toBe('available');
    expect(first.sources.find((s) => s.source === 'firms')?.state).toBe('available');
    expect(first.sources.find((s) => s.source === 'smap')?.state).not.toBe('available'); // sin ingesta para esta celda
    expect(JSON.stringify(first)).not.toContain(process.env.FIRMS_MAP_KEY!);

    const second = await getClimateEvidence(q);
    expect(second.records.filter((r) => r.source === 'power').every((r) => r.cache.origin === 'shared_cache')).toBe(true);
    expect(second.records.filter((r) => r.source === 'firms').every((r) => r.cache.origin === 'shared_cache')).toBe(true);
  }, 30_000);
});
