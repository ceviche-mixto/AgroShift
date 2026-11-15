import { describe, expect, it } from 'vitest';
import type { AnalyzeResponse, FarmInput } from '../../src/domain/contracts.ts';
import { explainFinding, listFacts } from '../../src/domain/explain.ts';
import { analyzeResponseSchema } from '../../src/domain/schemas.ts';
import { analyze, type AnalyzeDeps } from '../../src/services/analysis.ts';
import { MAX_CONTEXT_CHARS, verifyContext } from '../../src/services/bedrock/context.ts';
import { DEMO_CASES } from '../../src/services/nasa/fallback.ts';
import { getClimateEvidence, type Cache } from '../../src/services/nasa/index.ts';

// Análisis de punta a punta con datos REALES de los tres casos (instantáneas de src/data/nasa)
// y el motor real, sin red: Supabase caído y presupuesto agotado dejan solo el respaldo local.
// La normalización, la caducidad y el backoff acotado de cada fuente se prueban en
// power/smap/giovanni/firms/fetch/index.test.ts; las pruebas con red, en *.live.test.ts.

const now = new Date('2026-11-15T04:00:00Z');
const fail = () => Promise.reject(new Error('supabase caído'));
const down: Cache = { read: fail, acquire: fail, publish: fail, release: fail };
const offline: AnalyzeDeps = {
  now: () => now,
  secret: 'secreto-de-prueba',
  consume: async () => false,
  climate: (q, o) => getClimateEvidence(q, { ...o, cache: down }),
};

const input = (c: { lat: number; lon: number }, crop: string, water: FarmInput['water'], date = '2027-06-15'): FarmInput => ({
  location: { lat: c.lat, lon: c.lon, origin: 'manual_coordinates', accuracyM: null },
  crop: { status: 'known', stage: 'last_harvested', name: crop },
  goal: 'next_crop',
  water,
  planting: { status: 'known', date, precision: 'day' },
});
async function run(value: FarmInput): Promise<AnalyzeResponse> {
  const out = await analyze(value, offline);
  expect(out.status).toBe(200);
  return analyzeResponseSchema.parse(out.body);
}
const [peru, india, kenia] = DEMO_CASES;
const state = (r: AnalyzeResponse, source: string) => r.result.climate.sources.find((s) => s.source === source);

describe('fuentes NASA en el análisis: procedencia y vigencia', () => {
  it.each([
    [peru, 'stale'],
    [india, 'insufficient_coverage'],
    [kenia, 'insufficient_coverage'],
  ] as const)('$name: cada fuente declara su estado y su procedencia', async (c, smap) => {
    const { result, alerts } = await run(input(c, 'maíz', 'enough'));
    expect(result.climate.query.window).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(state({ result } as AnalyzeResponse, 'power')).toMatchObject({ state: 'stale', detail: 'respaldo_local' });
    expect(state({ result } as AnalyzeResponse, 'giovanni')).toMatchObject({ state: 'stale', detail: 'respaldo_local' });
    expect(state({ result } as AnalyzeResponse, 'smap')?.state).toBe(smap);
    // FIRMS es tiempo casi real: sin consulta vigente no hay dato ni alerta
    expect(state({ result } as AnalyzeResponse, 'firms')).toMatchObject({ state: 'unavailable', ageSeconds: null });
    expect(alerts).toEqual([]);

    const by = (source: string) => result.climate.records.filter((r) => r.source === source);
    expect(by('power').map((r) => `${r.variable} ${r.unit}`).sort()).toEqual([
      'ALLSKY_SFC_SW_DWN MJ/m^2/day',
      'PRECTOTCORR mm/day',
      'RH2M %',
      'T2M C',
      'T2M_MAX C',
      'T2M_MIN C',
    ]);
    for (const r of by('power')) expect(r.dataset.version).toMatch(/^v\d+\.\d+/);
    expect(by('giovanni').map((r) => r.data.type).sort()).toEqual(['series', 'statistic', 'statistic']);
    expect(by('smap').map((r) => `${r.dataset.id} ${r.unit}`)).toEqual(smap === 'stale' ? ['SPL4SMGP.008 m^3/m^3', 'SPL4SMGP.008 m^3/m^3'] : []);
    for (const r of result.climate.records) {
      expect(r.cache.origin).toBe('local_snapshot');
      // Todo es estimación modelada: ninguna se presenta como observación ni como proyección
      expect(r.kind).toBe('modeled_estimate');
      expect(r.limitations.length).toBeGreaterThan(0);
      // La respuesta viaja compacta: nada de series diarias
      if (r.data.type === 'series') expect(r.data.step).toBe('month');
    }
    expect(JSON.stringify(result).length).toBeLessThan(40_000);
  });
});

describe('análisis con datos reales de tres continentes', () => {
  it('India: dos rotaciones sustentadas, con evidencia enlazada y Plan B hipotético', async () => {
    const { result, explain } = await run(input(india, 'maíz', 'enough'));
    expect(result.status).toBe('ok');
    const { planA, planB } = result;
    expect(planA?.completeness).toBe('complete');
    expect(planB?.completeness).toBe('complete');
    expect(planA?.cropIds).toEqual(['chickpea']);
    expect(planB?.cropIds).toEqual(['common_bean']);
    expect(planA?.scenario).toEqual({ id: 'reference', nature: 'observed_reference' });
    expect(planB?.scenario.nature).toBe('hypothetical');

    const evidenceIds = new Set(result.climate.records.map((r) => r.id));
    const findings = [planA!, planB!].flatMap((p) => [...p.reasons, ...p.restrictions, ...p.actions, ...p.reconsiderSignals, ...p.toVerify]);
    expect(findings.length).toBeGreaterThan(4);
    for (const f of findings) for (const id of f.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
    // La evidencia es respaldo local con edad: el plan lo dice
    expect(planA!.restrictions.map((f) => f.id)).toContain('restriction.stale_evidence');
    // Sin puntajes ni porcentajes en ningún texto
    for (const { fact } of listFacts(result)) expect(explainFinding(fact)).not.toMatch(/%|confianza|probabilidad/i);

    // El contexto de explicación cabe con planes reales y no lleva ubicación
    expect(explain!.length).toBeLessThan(MAX_CONTEXT_CHARS);
    expect(verifyContext(explain, 'secreto-de-prueba', now)?.planA?.cropIds).toEqual(['chickpea']);
    expect(Buffer.from(explain!.split('.')[0]!, 'base64url').toString()).not.toMatch(/12\.97|77\.59|gldas|merra/);
  });

  it('Kenia: dos rotaciones sustentadas y resultado reproducible', async () => {
    const first = await run(input(kenia, 'maíz', 'enough'));
    const second = await run(input(kenia, 'maíz', 'enough'));
    expect(first.result.status).toBe('ok');
    expect(first.result.planA?.cropIds).not.toEqual(first.result.planB?.cropIds);
    expect(second).toEqual(first);
  });

  it('Perú: con la lluvia de referencia ningún cultivo se sostiene sin riego; el riego es condición y el Plan B nunca queda vacío', async () => {
    for (const water of ['enough', 'limited', 'unknown'] as const) {
      const { result } = await run(input(peru, 'arroz', water, '2026-12-01'));
      expect(result.planB?.completeness).not.toBe('incomplete');
      expect(result.planB?.kind === 'fallow' || result.planB!.cropIds.length > 0).toBe(true);
      // Solo falta un dato cuando la persona no sabe cuánta agua tiene
      expect(result.status).toBe(water === 'unknown' ? 'partial' : 'ok');
    }
    // Con riego suficiente el Plan A es completo y depende de ese riego
    const withWater = (await run(input(peru, 'arroz', 'enough', '2026-12-01'))).result.planA!;
    expect(withWater.completeness).toBe('complete');
    expect(withWater.restrictions.map((f) => f.id)).toContain('restriction.depends_on_irrigation');
    // Con poca agua es condicionado, no incompleto
    expect((await run(input(peru, 'arroz', 'limited', '2026-12-01'))).result.planA?.completeness).toBe('conditional');
    expect((await run(input(peru, 'arroz', 'unknown', '2026-12-01'))).result.planA?.completeness).toBe('incomplete');
  });

  it('fuera de las celdas con respaldo y sin red no hay evidencia: 429 con reintento, sin plan inventado', async () => {
    const out = await analyze(input({ ...peru, lat: 40.4, lon: -3.7 }, 'trigo', 'enough'), offline);
    expect(out).toMatchObject({ status: 429, body: { status: 'rate_limited' } });
  });
});
