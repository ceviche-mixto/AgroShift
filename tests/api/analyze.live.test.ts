import { describe, expect, it } from 'vitest';
import type { FarmInput } from '../../src/domain/contracts.ts';
import { analyzeResponseSchema } from '../../src/domain/schemas.ts';
import { analyze } from '../../src/services/analysis.ts';
import { verifyContext } from '../../src/services/bedrock/context.ts';
import { explain } from '../../src/services/bedrock/explain.ts';
import { DEMO_CASES } from '../../src/services/nasa/fallback.ts';

// Análisis real: POWER y FIRMS en vivo, caché y presupuesto en Supabase, motor real.
// Solo con `npm run test:live` (carga `.env`).
const live = Boolean(process.env.SUPABASE_SECRET_KEY && process.env.FIRMS_MAP_KEY && process.env.EXPLAIN_CONTEXT_SECRET);

const input = (c: (typeof DEMO_CASES)[number]): FarmInput => ({
  location: { lat: c.lat, lon: c.lon, origin: 'manual_coordinates', accuracyM: null },
  crop: { status: 'known', stage: 'last_harvested', name: 'maíz' },
  goal: 'next_crop',
  water: 'enough',
  planting: { status: 'known', date: '2027-06-15', precision: 'day' },
});

describe.skipIf(!live)('análisis en vivo de los tres casos', () => {
  it.each(DEMO_CASES)('$name: responde dentro del plazo con POWER real y estados por fuente', async (c) => {
    const started = Date.now();
    const out = await analyze(input(c));
    expect(Date.now() - started).toBeLessThan(7_500);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    const { result } = analyzeResponseSchema.parse(out.body);
    const power = result.climate.sources.find((s) => s.source === 'power');
    expect(['available', 'partial']).toContain(power?.state);
    expect(result.climate.records.filter((r) => r.source === 'power')).toHaveLength(6);
    expect(result.climate.sources.map((s) => s.source).sort()).toEqual(['firms', 'giovanni', 'power', 'smap']);
    expect(['ok', 'partial']).toContain(result.status);
  }, 20_000);

  it('India: dos rotaciones sustentadas y explicación con Bedrock o con respaldo local', async () => {
    const out = await analyze(input(DEMO_CASES[1]));
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.result.status).toBe('ok');
    const facts = verifyContext(out.body.explain, process.env.EXPLAIN_CONTEXT_SECRET!, new Date());
    expect(facts).not.toBeNull();
    const started = Date.now();
    const answer = await explain(facts!, 'less_water');
    expect(Date.now() - started).toBeLessThan(6_500);
    expect(['model', 'local']).toContain(answer.source);
    expect(answer.items.length).toBeGreaterThan(0);
    console.info(`[explain en vivo] origen: ${answer.source}`);
  }, 30_000);
});
