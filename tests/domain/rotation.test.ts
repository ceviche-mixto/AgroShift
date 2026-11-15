import { describe, expect, it } from 'vitest';
import chiclayo from '../../src/data/nasa/chiclayo.json' with { type: 'json' };
import india from '../../src/data/nasa/india.json' with { type: 'json' };
import kenia from '../../src/data/nasa/kenia.json' with { type: 'json' };
import type { ClimateEvidence, EvidenceRecord, FarmInput, Finding, Plan } from '../../src/domain/contracts.ts';
import { CROPS, RULES } from '../../src/domain/crops.ts';
import { explainFinding, FINDING_IDS, needsIrrigation } from '../../src/domain/explain.ts';
import { ENGINE_VERSION, evaluateRotation, type EngineResult } from '../../src/domain/rotation.ts';
import { analysisResultSchema, climateEvidenceSchema, evidenceRecordSchema } from '../../src/domain/schemas.ts';

// Hermético: evidencia sintética por mes y las tres instantáneas reales del repositorio.

const window = { start: '2025-01-01', end: '2025-12-31' };
const pad = (n: number) => String(n).padStart(2, '0');
type ByMonth = (month: number) => number | null;

const record = (variable: string, unit: string, value: ByMonth): EvidenceRecord => ({
  id: `power:${variable}:test`,
  source: 'power',
  dataset: { id: 'TEST', url: 'https://example.org/', product: 'Producto de prueba', version: '1' },
  variable,
  unit,
  kind: 'modeled_estimate',
  grid: { cellId: 'celda', lat: 0, lon: 0, nativeResolution: '0.5°' },
  period: window,
  retrievedAt: '2026-11-15T00:00:00Z',
  coverage: { status: 'complete', validCount: 365, expectedCount: 365, quality: [] },
  cache: { origin: 'live', expiresAt: null },
  limitations: [],
  data: {
    type: 'series',
    step: 'day',
    points: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].flatMap((days, m) =>
      Array.from({ length: days }, (_, d) => ({ t: `2025-${pad(m + 1)}-${pad(d + 1)}`, v: value(m + 1) })),
    ),
  },
});

const assemble = (records: EvidenceRecord[], lat = 0, lon = 0, state: 'available' | 'stale' = 'available'): ClimateEvidence =>
  climateEvidenceSchema.parse({
    query: { lat, lon, window },
    assembledAt: '2026-11-15T00:00:00Z',
    sources: [...new Set(records.map((r) => r.source))].map((source) => ({ source, state, ageSeconds: null, detail: null })),
    records,
  });

/** Clima sintético: temperatura media (°C) y lluvia anual (mm) repartida por igual. */
const synthetic = (tempC: ByMonth, rainMmYear: number | null) =>
  assemble([record('T2M', 'C', tempC), record('PRECTOTCORR', 'mm/day', () => (rainMmYear === null ? null : rainMmYear / 365))]);

const real = (snapshot: { records: unknown[] }, lat: number, lon: number) =>
  assemble(snapshot.records.map((r) => evidenceRecordSchema.parse(r)), lat, lon, 'stale');

const farm = ({ previous, ...rest }: Partial<FarmInput> & { previous?: string } = {}): FarmInput => ({
  location: { lat: 0, lon: 0, origin: 'manual_coordinates', accuracyM: null },
  crop: previous ? { status: 'known', stage: 'last_harvested', name: previous } : { status: 'unknown' },
  goal: 'next_crop',
  water: 'enough',
  planting: { status: 'known', date: '2027-03-01', precision: 'day' },
  ...rest,
});

const LISTS = ['reasons', 'restrictions', 'actions', 'reconsiderSignals', 'toVerify'] as const;
const findingsOf = (r: EngineResult): Finding[] => [
  ...[r.planA, r.planB].flatMap((p) => (p ? LISTS.flatMap((l) => p[l]) : [])),
  ...r.missing,
];
const ids = (list: Finding[]) => list.map((f) => f.id);
const crops = (p: Plan | null) => p?.cropIds;

/** Invariantes de todo resultado: contrato, reglas, evidencia, plantillas y escenarios. */
function check(r: EngineResult, climate: ClimateEvidence): EngineResult {
  analysisResultSchema.parse({ contractVersion: 1, ...r, generatedAt: '2026-11-15T00:00:00Z', climate });
  expect(r.engineVersion).toBe(ENGINE_VERSION);
  const evidenceIds = new Set(climate.records.map((e) => e.id));
  const ruleIds = new Set(RULES.filter((x) => x.active).map((x) => x.id));
  for (const f of findingsOf(r)) {
    expect(FINDING_IDS).toContain(f.id);
    expect(ruleIds.has(f.ruleId) || f.ruleId.startsWith('engine.')).toBe(true);
    for (const e of f.evidenceIds) expect(evidenceIds).toContain(e);
    expect(Object.keys(f.params).join(' ')).not.toMatch(/score|puntaje|confian|confidence|percent|porcentaje|pct|impact/i);
    expect(explainFinding(f)).not.toMatch(/[{}%]|undefined|null|NaN|\[object/);
  }
  if (r.planA) expect(r.planA.scenario).toEqual({ id: 'reference', nature: 'observed_reference' });
  if (r.planB) {
    expect(r.planB.scenario.nature).toBe('hypothetical');
    expect(ids(r.planB.restrictions)[0]).toBe('restriction.hypothetical');
    expect(explainFinding(r.planB.restrictions[0]!)).toMatch(/^Supuesto, no pronóstico\. Si /);
  }
  return r;
}
const run = (input: FarmInput, climate: ClimateEvidence) => check(evaluateRotation(input, climate), climate);

const warmWet = synthetic(() => 25, 900);

describe('rotaciones respaldadas', () => {
  it('compara dos rotaciones de forma reproducible, sin depender del orden de los registros', () => {
    const input = farm({ previous: 'maíz' });
    const first = run(input, warmWet);
    expect(first.status).toBe('ok');
    expect(crops(first.planA)).toEqual(['chickpea']);
    expect(crops(first.planB)).toEqual(['common_bean']);
    expect(first.missing).toEqual([]);
    expect(evaluateRotation(input, warmWet)).toEqual(first);
    expect(evaluateRotation(input, { ...warmWet, records: [...warmWet.records].reverse() })).toEqual(first);
    expect(JSON.stringify(evaluateRotation(structuredClone(input), structuredClone(warmWet)))).toBe(JSON.stringify(first));
  });

  it('el ciclo envuelve el fin de año y usa los mismos meses de la referencia', () => {
    // Frío de mayo a octubre: solo una siembra en diciembre cae entera en meses cálidos
    const seasonal = synthetic((m) => (m >= 5 && m <= 10 ? 4 : 25), 900);
    const december = run(farm({ previous: 'maíz', planting: { status: 'known', date: '2026-12-15', precision: 'day' } }), seasonal);
    expect(december.planA?.reasons.find((f) => f.id === 'reason.thermal_optimal')?.params.tempC).toBe(25);
    // En julio 4 °C queda bajo el mínimo absoluto de todas las fichas: thermal-limit descarta todo
    const july = run(farm({ previous: 'maíz', planting: { status: 'known', date: '2027-07-01', precision: 'month' } }), seasonal);
    expect(july.status).toBe('partial');
    expect(crops(july.planA)).toEqual([]);
    expect(july.planA?.toVerify).toMatchObject([{ id: 'verify.no_candidate', ruleId: 'thermal-limit' }]);
  });
});

describe('agua', () => {
  const hotDry = synthetic(() => 32, 350);
  const input = (water: FarmInput['water']) => farm({ previous: 'caupí', water });

  it('agua limitada cambia el resultado cuando la lluvia no cubre el mínimo de la ficha', () => {
    const enough = run(input('enough'), hotDry);
    expect(enough.status).toBe('ok');
    expect(crops(enough.planA)).toEqual(['maize']);
    expect(enough.planA?.restrictions).toContainEqual(
      expect.objectContaining({ id: 'restriction.depends_on_irrigation', params: { crop: 'maize', rainMm: 350, minMm: 400 } }),
    );
    expect(ids(enough.planA!.reconsiderSignals)).toContain('signal.less_irrigation');
    // El Plan B hipotético anticipa lo que pasa al declarar agua limitada
    expect(enough.planB?.scenario.id).toBe('limited_water');
    expect(crops(enough.planB)).toEqual(['sorghum']);

    const limited = run(input('limited'), hotDry);
    expect(limited.status).toBe('ok');
    expect(crops(limited.planA)).toEqual(['sorghum']);
    expect(limited.planB?.scenario.id).toBe('less_rain');
    expect(crops(limited.planB)).toEqual(['finger_millet']);
    expect(ids(limited.planB!.reasons)).toContain('reason.rain_margin');
  });

  it('con lluvia suficiente el resultado no cambia y se explica por qué', () => {
    const wet = synthetic(() => 32, 600);
    const enough = run(input('enough'), wet);
    const limited = run(input('limited'), wet);
    expect(crops(enough.planA)).toEqual(['maize']);
    expect(limited.planA).toEqual(enough.planA);
    expect(limited.planA?.reasons).toContainEqual(
      expect.objectContaining({ id: 'reason.rain_covers_minimum', params: { crop: 'maize', rainMm: 600, minMm: 400 } }),
    );
  });

  it('sin lluvia suficiente: agua limitada es una condición de riego; agua desconocida es un dato faltante', () => {
    const desert = synthetic(() => 25, 100);
    expect(run(input('enough'), desert).planA?.completeness).toBe('complete');

    // «Tengo poca agua» ya es una respuesta: el plan es viable con riego suplementario, no «a medias»
    const limited = run(input('limited'), desert);
    expect(limited.status).toBe('ok');
    expect(limited.planA?.completeness).toBe('conditional');
    expect(limited.planA?.restrictions).toContainEqual(expect.objectContaining({ id: 'restriction.rain_below_minimum', ruleId: 'water-minimum' }));
    expect(ids(limited.planA!.actions)).toContain('action.secure_irrigation');
    expect(ids(limited.planA!.toVerify)).not.toContain('verify.water_availability');
    expect(needsIrrigation(limited.planA)).toBe(true);
    expect(limited.planB?.completeness).not.toBe('incomplete');

    const unknown = run(input('unknown'), desert);
    expect(unknown.status).toBe('partial');
    expect(unknown.planA?.completeness).toBe('incomplete');
    expect(ids(unknown.planA!.toVerify)).toContain('verify.water_availability');
    // water-minimum solo aplica con agua limitada
    expect(findingsOf({ ...unknown, planB: null }).map((f) => f.ruleId)).not.toContain('water-minimum');
  });

  it('Plan B por agua: cultivo de ficha más ligera, o descanso con abono verde si no hay uno', () => {
    const desert = synthetic(() => 25, 100);
    const need = (id: string) => CROPS.find((c) => c.id === id)!.rainfall.optimal.min!;
    // Con agua limitada, B es un cultivo que se da bien con menos lluvia que el de A
    const lighter = run(farm({ previous: 'arroz', water: 'limited' }), desert);
    const [a] = lighter.planA!.cropIds;
    const [b] = lighter.planB!.cropIds;
    expect(lighter.planB).toMatchObject({ kind: 'crop', completeness: 'conditional' });
    expect(need(b!)).toBeLessThan(need(a!));
    expect(lighter.planB?.reasons).toContainEqual(expect.objectContaining({ id: 'reason.less_water_than_plan_a', params: expect.objectContaining({ crop: b, other: a }) }));

    // Si el Plan A ya es el de menor requerimiento, no hay cultivo más ligero: descanso, no un plan vacío
    const lightest = run(farm({ previous: 'arroz', water: 'limited', goal: 'save_water' }), desert);
    expect(crops(lightest.planA)).toEqual(['sorghum']);
    expect(lightest.status).toBe('ok');
    expect(lightest.planB).toMatchObject({ kind: 'fallow', completeness: 'complete', cropIds: [], toVerify: [] });
    expect(ids(lightest.planB!.reasons)).toEqual(['reason.fallow_no_rain_support', 'reason.green_manure_legume']);
    expect(lightest.planB?.reasons[0]).toMatchObject({ params: { rainMm: 100, minMm: 300 } });
    expect(lightest.planB?.reasons[1]).toMatchObject({ ruleId: 'rotation-legume-cereal' });
    // La cobertura también necesita agua, y se dice
    expect(ids(lightest.planB!.restrictions)).toEqual(['restriction.hypothetical', 'restriction.green_manure_needs_water']);
    expect(needsIrrigation(lightest.planB)).toBe(false);

    // Con agua suficiente, el supuesto del Plan B es «sin riego»: ningún cultivo se sostiene, así que descanso
    expect(run(input('enough'), desert).planB).toMatchObject({ kind: 'fallow', completeness: 'complete' });
  });
});

describe('incertidumbre', () => {
  it.each([
    ['desconocido', farm(), 'verify.previous_crop_unknown'],
    ['fuera de catálogo', farm({ previous: 'Quinua de la chacra' }), 'verify.previous_crop_not_in_catalog'],
  ])('cultivo %s: no asume familia ni rotación', (_name, input, verify) => {
    const r = run(input, warmWet);
    expect(r.status).toBe('partial');
    for (const plan of [r.planA!, r.planB!]) {
      expect(plan.completeness).toBe('incomplete');
      expect(plan.cropIds).toHaveLength(1);
      expect(ids(plan.toVerify)).toContain(verify);
    }
    expect(findingsOf(r).map((f) => f.ruleId).filter((id) => id.startsWith('rotation-'))).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/quinua|chacra/i);
  });

  it('fecha de siembra desconocida: no inventa calendario', () => {
    const r = run(farm({ previous: 'maíz', planting: { status: 'unknown' } }), warmWet);
    expect(r.status).toBe('partial');
    expect(r.planA).toMatchObject({ completeness: 'incomplete', cropIds: [], reasons: [], toVerify: [{ id: 'verify.planting_date' }] });
    expect(r.planB).toBeNull();
  });

  it('sin POWER o con la fuente no disponible: evidencia insuficiente', () => {
    const none: ClimateEvidence = { ...warmWet, sources: [{ source: 'power', state: 'unavailable', ageSeconds: null, detail: 'plazo_agotado' }], records: [] };
    const r = run(farm({ previous: 'maíz' }), none);
    expect(r).toMatchObject({ status: 'insufficient_evidence', planA: null, planB: null });
    expect(r.missing).toMatchObject([
      { id: 'missing.temperature', params: { validDays: 0, minDays: 292 } },
      { id: 'missing.rain', params: { validDays: 0, minDays: 292 } },
    ]);
    // Otras fuentes no sustituyen a POWER
    const onlyOthers = real({ records: chiclayo.records.filter((x) => x.source !== 'power') }, -6.77, -79.84);
    expect(run(farm({ previous: 'arroz' }), onlyOthers).status).toBe('insufficient_evidence');
  });

  it('temperatura mayormente nula: evidencia insuficiente', () => {
    const r = run(farm({ previous: 'maíz' }), synthetic((m) => (m === 1 ? 25 : null), 900));
    expect(r.status).toBe('insufficient_evidence');
    expect(r.missing).toMatchObject([{ id: 'missing.temperature', evidenceIds: ['power:T2M:test'], params: { validDays: 31 } }]);
  });

  it('una lluvia toda nula no se interpreta como sequía', () => {
    const r = run(farm({ previous: 'maíz', water: 'limited' }), synthetic(() => 25, null));
    expect(r).toMatchObject({ status: 'insufficient_evidence', planA: null, planB: null });
    expect(r.missing).toMatchObject([{ id: 'missing.rain', params: { validDays: 0 } }]);
  });

  it('año con cobertura suficiente pero sin datos en las fechas del ciclo: evidencia insuficiente', () => {
    const gap = synthetic((m) => (m === 3 || m === 4 ? null : 25), 900);
    const r = run(farm({ previous: 'maíz' }), gap);
    expect(r).toMatchObject({ status: 'insufficient_evidence', missing: [{ id: 'missing.cycle_coverage' }] });
    // La misma evidencia sí sustenta un ciclo fuera del hueco
    expect(run(farm({ previous: 'maíz', planting: { status: 'known', date: '2027-08-01', precision: 'month' } }), gap).status).toBe('ok');
  });
});

describe('reglas del catálogo', () => {
  it('rotation_same_crop descarta repetir el cultivo indicado', () => {
    for (const crop of CROPS) {
      for (const stage of ['current', 'last_harvested'] as const) {
        const r = run({ ...farm(), crop: { status: 'known', stage, name: crop.aliases[0]! } }, warmWet);
        expect([...(crops(r.planA) ?? []), ...(crops(r.planB) ?? [])]).not.toContain(crop.id);
        expect(r.planA?.reasons[0]).toMatchObject({ id: 'reason.not_repeated', ruleId: 'rotation-same-crop', params: { previous: crop.id } });
      }
    }
  });

  it('rotation_legume_cereal se refleja en ambos sentidos y manda con el objetivo de cuidar el suelo', () => {
    const afterCereal = run(farm({ previous: 'maíz', goal: 'care_soil' }), warmWet);
    expect(CROPS.find((c) => c.id === afterCereal.planA!.cropIds[0])?.group).toBe('legume');
    expect(afterCereal.planA?.reasons).toContainEqual(expect.objectContaining({ id: 'reason.legume_after_cereal', ruleId: 'rotation-legume-cereal' }));
    const afterLegume = run(farm({ previous: 'frijol', goal: 'care_soil' }), warmWet);
    expect(CROPS.find((c) => c.id === afterLegume.planA!.cropIds[0])?.group).toBe('cereal');
    expect(afterLegume.planA?.reasons).toContainEqual(expect.objectContaining({ id: 'reason.cereal_after_legume', ruleId: 'rotation-legume-cereal' }));
  });

  it('la regla inactiva de misma familia no influye', () => {
    expect(RULES.find((r) => r.id === 'rotation-same-family')?.active).toBe(false);
    // Arroz y sorgo son Gramineae: con ahorro de agua gana el sorgo, la ficha que menos lluvia pide
    const r = run(farm({ previous: 'arroz', goal: 'save_water' }), synthetic(() => 25, 600));
    expect(crops(r.planA)).toEqual(['sorghum']);
    expect(r.planA?.reasons).toContainEqual(expect.objectContaining({ id: 'reason.lower_water_need', params: { crop: 'sorghum', optimalMinMm: 400 } }));
    expect(findingsOf(r).map((f) => f.ruleId)).not.toContain('rotation-same-family');
  });

  it('thermal_limit descarta fuera del rango absoluto y el óptimo queda como razón o restricción', () => {
    // 38 °C supera el máximo absoluto de todas las fichas salvo maíz (47), caupí (40) y sorgo (40, el cultivo previo)
    const r = run(farm({ previous: 'sorgo' }), synthetic(() => 38, 550));
    expect([crops(r.planA), crops(r.planB)]).toEqual([['cowpea'], ['maize']]);
    expect(r.planA?.restrictions).toContainEqual(
      expect.objectContaining({ id: 'restriction.thermal_outside_optimal', params: { crop: 'cowpea', tempC: 38, min: 25, max: 35 } }),
    );
    expect(r.planA?.reasons).toContainEqual(
      expect.objectContaining({ id: 'reason.thermal_within_limits', ruleId: 'thermal-limit', params: { crop: 'cowpea', tempC: 38, min: 15, max: 40 } }),
    );
    expect(r.planA?.reconsiderSignals).toContainEqual(expect.objectContaining({ id: 'signal.temperature_out_of_limits', ruleId: 'thermal-limit' }));
  });
});

describe('evidencia real de los tres casos', () => {
  const cases = [
    { name: 'Perú', climate: real(chiclayo, -6.77, -79.84), lat: -6.77, lon: -79.84, previous: 'arroz' },
    { name: 'India', climate: real(india, 12.97, 77.59), lat: 12.97, lon: 77.59, previous: 'maíz' },
    { name: 'Kenia', climate: real(kenia, -1.29, 36.82), lat: -1.29, lon: 36.82, previous: 'maíz' },
  ];
  const at = (c: (typeof cases)[number], o: Parameters<typeof farm>[0] = {}) =>
    run({ ...farm({ previous: c.previous, ...o }), location: { lat: c.lat, lon: c.lon, origin: 'gps', accuracyM: 30 } }, c.climate);
  const planting = (date: string): FarmInput['planting'] => ({ status: 'known', date, precision: 'day' });

  it('no lanza, valida el contrato y los tres casos entregan Plan A y Plan B', () => {
    const ok = new Set<string>();
    for (const c of cases) {
      for (const date of ['2026-12-01', '2028-02-29', '2027-03-15', '2027-06-15', '2027-09-01']) {
        for (const water of ['enough', 'limited', 'unknown'] as const) {
          for (const goal of ['next_crop', 'save_water', 'care_soil'] as const) {
            const r = at(c, { water, goal, planting: planting(date) });
            expect(r.status).not.toBe('insufficient_evidence');
            expect(ids(r.planA!.restrictions)).toEqual(expect.arrayContaining(['restriction.reference_year', 'restriction.stale_evidence']));
            if (r.status === 'ok') {
              ok.add(c.name);
              expect(r.planA!.cropIds).not.toEqual(r.planB!.cropIds);
            }
          }
        }
      }
    }
    expect([...ok]).toEqual(['Perú', 'India', 'Kenia']);
  });

  it('India: dos rotaciones completas y la temporada regional respaldada del ragi', () => {
    const r = at(cases[1]!, { planting: planting('2027-06-15') });
    expect(r.status).toBe('ok');
    expect([crops(r.planA), crops(r.planB)]).toEqual([['chickpea'], ['common_bean']]);
    expect(r.planA?.reasons).toContainEqual(expect.objectContaining({ id: 'reason.rain_covers_minimum', params: { crop: 'chickpea', rainMm: 825, minMm: 300 } }));

    // Tras una leguminosa, el ciclo de junio a agosto cabe en la temporada Kar documentada
    const inSeason = at(cases[1]!, { previous: 'frijol', goal: 'care_soil', planting: planting('2027-06-15') });
    expect(crops(inSeason.planA)).toEqual(['finger_millet']);
    expect(inSeason.planA?.reasons).toContainEqual(expect.objectContaining({ id: 'reason.regional_season' }));
    expect(ids(inSeason.planA!.toVerify)).not.toContain('verify.regional_calendar');
    // En enero queda fuera de temporada y pierde el primer lugar
    const offSeason = at(cases[1]!, { previous: 'frijol', goal: 'care_soil', planting: planting('2027-01-10') });
    expect(crops(offSeason.planA)).not.toEqual(['finger_millet']);
    // Sin respaldo regional: se verifica localmente, no se inventa calendario
    expect(ids(offSeason.planA!.toVerify)).toContain('verify.regional_calendar');
    expect(ids(offSeason.planA!.actions)).toContain('action.consult_local_technician');
  });

  it('Perú: la lluvia de referencia no sustenta un Plan B con cultivo sin riego, y el Plan B es descanso', () => {
    const enough = at(cases[0]!, { planting: planting('2026-12-01') });
    expect(enough.status).toBe('ok');
    expect(enough.planA).toMatchObject({ completeness: 'complete', cropIds: ['chickpea'] });
    expect(enough.planA?.restrictions).toContainEqual(
      expect.objectContaining({ id: 'restriction.depends_on_irrigation', params: { crop: 'chickpea', rainMm: 169, minMm: 300 } }),
    );
    expect(enough.planB).toMatchObject({ kind: 'fallow', completeness: 'complete', cropIds: [] });
    expect(enough.planB?.reasons[0]).toMatchObject({ id: 'reason.fallow_no_rain_support', params: { rainMm: 169, minMm: 300 } });
  });

  it('Chiclayo + arroz + poca agua: Plan A principal con condición de riego, un solo aviso y Plan B real', () => {
    const r = at(cases[0]!, { water: 'limited', planting: planting('2026-12-01') });
    // Respondió las cinco preguntas: no es «a medias» ni «incompleto»
    expect(r.status).toBe('ok');
    expect(r.missing).toEqual([]);
    const { planA, planB } = r;
    expect(planA).toMatchObject({ completeness: 'conditional', kind: 'crop', cropIds: ['chickpea'] });
    expect(planA!.reasons.length).toBeGreaterThan(0);
    // La condición cita lluvia frente al mínimo de la ficha y aparece una sola vez como restricción
    const irrigation = planA!.restrictions.filter((f) => /irrigation|rain_below_minimum/.test(f.id));
    expect(irrigation).toHaveLength(1);
    expect(irrigation[0]).toMatchObject({ id: 'restriction.rain_below_minimum', ruleId: 'water-minimum', params: { crop: 'chickpea', rainMm: 169, minMm: 300 } });
    expect(explainFinding(irrigation[0]!)).toContain('riego suplementario');
    expect(needsIrrigation(planA)).toBe(true);
    // Nada en «Qué revisar» repite la condición de riego ni pide un dato que ya dio
    expect(ids(planA!.toVerify)).toEqual(['verify.regional_calendar', 'verify.variety_cycle', 'verify.soil_ph']);
    // Plan B: alternativa real de menor requerimiento hídrico, con la ficha como respaldo
    expect(planB).toMatchObject({ completeness: 'conditional', kind: 'crop', cropIds: ['sorghum'] });
    expect(planB!.reasons).toContainEqual(
      expect.objectContaining({ id: 'reason.less_water_than_plan_a', params: { crop: 'sorghum', optimalMinMm: 400, other: 'chickpea', otherOptimalMinMm: 600 } }),
    );
    expect(planB!.scenario.nature).toBe('hypothetical');
    // Y si el Plan A ya fuera el más ligero, el Plan B sería descanso con abono verde, nunca un plan vacío
    const lightest = at(cases[0]!, { water: 'limited', goal: 'save_water', planting: planting('2026-12-01') });
    expect(crops(lightest.planA)).toEqual(['sorghum']);
    expect(lightest.planB).toMatchObject({ kind: 'fallow', completeness: 'complete' });
    // Agua desconocida sí es un dato por aportar
    const unknown = at(cases[0]!, { water: 'unknown', planting: planting('2026-12-01') });
    expect(unknown.status).toBe('partial');
    expect(unknown.planA?.completeness).toBe('incomplete');
  });
});
