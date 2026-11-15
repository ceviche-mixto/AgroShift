import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '../../src/domain/contracts.ts';
import { CROPS } from '../../src/domain/crops.ts';
import {
  answerLocally,
  cropName,
  explainFinding,
  FINDING_IDS,
  listFacts,
  QUESTION_IDS,
  questionText,
  type Fact,
  type PlanFacts,
  type ResultFacts,
} from '../../src/domain/explain.ts';

const fact = (id: string, params: Fact['params'] = {}): Fact => ({ id, ruleId: 'engine.test', params });
const plan = (o: Partial<PlanFacts> = {}): PlanFacts => ({
  completeness: 'complete',
  scenario: { id: 'reference', nature: 'observed_reference' },
  cropIds: ['chickpea'],
  reasons: [fact('reason.thermal_optimal', { crop: 'chickpea', tempC: 23.7, min: 15, max: 29 }), fact('reason.not_repeated', { previous: 'maize' })],
  restrictions: [fact('restriction.reference_year', { start: '2025-01-01', end: '2025-12-31' })],
  actions: [fact('action.consult_local_technician', { crop: 'chickpea' })],
  reconsiderSignals: [fact('signal.rain_below_minimum', { crop: 'chickpea', minMm: 300 })],
  toVerify: [fact('verify.variety_cycle', { crop: 'chickpea', days: 90 }), fact('verify.soil_ph', { crop: 'chickpea', min: 4.7, max: 9.5 })],
  ...o,
});
const ok: ResultFacts = {
  status: 'ok',
  planA: plan(),
  planB: plan({
    scenario: { id: 'limited_water', nature: 'hypothetical' },
    cropIds: ['common_bean'],
    restrictions: [fact('restriction.hypothetical', { scenario: 'limited_water', assumption: 'Si tuvieras menos agua: se evalúa sin riego.' })],
  }),
  missing: [],
};
const insufficient: ResultFacts = { status: 'insufficient_evidence', planA: null, planB: null, missing: [fact('missing.rain', { validDays: 0, minDays: 292 })] };

describe('plantillas', () => {
  it('cada id tiene una frase breve en español, también sin parámetros', () => {
    expect(new Set(FINDING_IDS).size).toBe(FINDING_IDS.length);
    for (const id of FINDING_IDS) {
      const text = explainFinding(fact(id));
      expect(text.length).toBeGreaterThan(20);
      expect(text.length).toBeLessThan(220);
      expect(text).not.toMatch(/[{}%]|undefined|null|NaN|engine\.|_/);
    }
  });

  it('usa los valores con su unidad y nombres cotidianos', () => {
    expect(explainFinding(ok.planA!.reasons[0]!)).toBe(
      'La temperatura media de esas fechas en el año de referencia (23,7 °C) está en el rango ideal de garbanzo (15 a 29 °C).',
    );
    expect(explainFinding(ok.planA!.toVerify[1]!)).toBe('No tenemos datos de tu suelo: garbanzo pide un pH entre 4,7 y 9,5.');
    expect(explainFinding(ok.planB!.restrictions[0]!)).toBe('Supuesto, no pronóstico. Si tuvieras menos agua: se evalúa sin riego.');
  });

  it('un id desconocido da un texto neutro y no lanza', () => {
    expect(explainFinding(fact('reason.test'))).toBe('Hay un dato más que conviene revisar con un técnico local.');
  });

  it('todo cultivo del catálogo tiene nombre cotidiano', () => {
    for (const c of CROPS) expect(cropName(c.id)).not.toMatch(/_|^$/);
    expect(cropName('finger_millet')).toBe('mijo dedo');
    expect(cropName('otro_cultivo')).toBe('otro cultivo');
  });
});

describe('preguntas', () => {
  it('cada pregunta tiene texto', () => {
    for (const id of QUESTION_IDS) expect(questionText(id)).toMatch(/^¿.+\?$/);
    expect(questionText('less_water')).toBe('¿Qué pasa si tengo menos agua?');
  });

  it('listFacts da claves estables por plan, lista y posición', () => {
    const keys = listFacts(ok).map((f) => f.key);
    expect(keys).toEqual([
      'A:reasons:0', 'A:reasons:1', 'A:restrictions:0', 'A:actions:0', 'A:reconsiderSignals:0', 'A:toVerify:0', 'A:toVerify:1',
      'B:reasons:0', 'B:reasons:1', 'B:restrictions:0', 'B:actions:0', 'B:reconsiderSignals:0', 'B:toVerify:0', 'B:toVerify:1',
    ]);
    expect(listFacts(ok)).toEqual(listFacts(structuredClone(ok)));
    expect(listFacts(insufficient)).toEqual([{ key: 'M:0', fact: insufficient.missing[0] }]);
    expect(listFacts({ ...insufficient, missing: [] })).toEqual([]);
  });

  it('answerLocally elige hasta 4 hechos pertinentes y deterministas', () => {
    expect(answerLocally('why_plan_a', ok)).toEqual(['A:reasons:0', 'A:reasons:1', 'A:restrictions:0']);
    expect(answerLocally('less_water', ok)).toEqual(['B:restrictions:0', 'B:reasons:0', 'B:reasons:1', 'B:toVerify:0']);
    expect(answerLocally('when_to_switch', ok)).toEqual(['A:reconsiderSignals:0', 'B:restrictions:0']);
    expect(answerLocally('what_to_check', ok)).toEqual(['A:toVerify:0', 'A:toVerify:1', 'B:toVerify:0', 'B:toVerify:1']);
    for (const result of [ok, insufficient, { ...ok, planB: null }]) {
      const keys = listFacts(result).map((f) => f.key);
      for (const id of QUESTION_IDS) {
        const answer = answerLocally(id, result);
        expect(answer.length).toBeGreaterThan(0);
        expect(answer.length).toBeLessThanOrEqual(4);
        expect(keys).toEqual(expect.arrayContaining(answer));
        expect(answerLocally(id, result)).toEqual(answer);
      }
    }
    expect(answerLocally('why_plan_a', insufficient)).toEqual(['M:0']);
    expect(answerLocally('less_water', { ...insufficient, missing: [] })).toEqual([]);
  });

  it('el resultado del contrato es asignable a los hechos', () => {
    const asFacts = (r: AnalysisResult): ResultFacts => r;
    expect(asFacts).toBeTypeOf('function');
  });
});
