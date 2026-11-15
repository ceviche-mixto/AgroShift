import { describe, expect, it } from 'vitest';
import type { AnalysisResult, EvidenceRecord, FarmInput, Plan } from '../../src/domain/contracts.ts';
import {
  analysisResultSchema,
  climateEvidenceSchema,
  evidenceRecordSchema,
  farmInputSchema,
  localDateSchema,
  parseFarmInput,
  planSchema,
  scenarioSchema,
} from '../../src/domain/schemas.ts';

const peru: FarmInput = {
  location: { lat: -6.77, lon: -79.84, origin: 'gps', accuracyM: 25 },
  crop: { status: 'known', stage: 'last_harvested', name: 'Arroz' },
  goal: 'next_crop',
  water: 'limited',
  planting: { status: 'known', date: '2026-12-01', precision: 'month' },
};
const india: FarmInput = {
  location: { lat: 12.97, lon: 77.59, origin: 'manual_coordinates', accuracyM: null },
  crop: { status: 'known', stage: 'current', name: 'Ragi' },
  goal: 'save_water',
  water: 'unknown',
  planting: { status: 'unknown' },
};
const kenia: FarmInput = {
  location: { lat: -1.29, lon: 36.82, origin: 'place_search', accuracyM: null },
  crop: { status: 'unknown' },
  goal: 'care_soil',
  water: 'enough',
  planting: { status: 'known', date: '2027-03-15', precision: 'day' },
};

const withLocation = (patch: Record<string, unknown>) => ({
  ...peru,
  location: { ...peru.location, ...patch },
});

describe('entrada del agricultor', () => {
  it.each([
    ['Perú', peru],
    ['India', india],
    ['Kenia', kenia],
  ])('acepta una ubicación de %s sin alterarla', (_, input) => {
    expect(farmInputSchema.parse(input)).toEqual(input);
  });

  it.each([
    ['latitud 90.01', { lat: 90.01 }],
    ['latitud -91', { lat: -91 }],
    ['longitud 180.5', { lon: 180.5 }],
    ['longitud -181', { lon: -181 }],
    ['NaN', { lat: Number.NaN }],
    ['infinito', { lon: Number.POSITIVE_INFINITY }],
    ['texto numérico', { lat: '-6.77' }],
    ['latitud nula', { lat: null }],
    ['latitud ausente', { lat: undefined }],
    ['origen desconocido', { origin: 'ip' }],
    ['precisión cero', { accuracyM: 0 }],
    ['precisión ausente', { accuracyM: undefined }],
  ])('rechaza coordenadas: %s', (_, patch) => {
    expect(farmInputSchema.safeParse(withLocation(patch)).success).toBe(false);
  });

  it('acepta los extremos del rango WGS84', () => {
    expect(farmInputSchema.safeParse(withLocation({ lat: -90, lon: 180 })).success).toBe(true);
  });

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-2-3', '01/12/2026', '2026-12-01T00:00:00Z', '1999-12-31', '2101-01-01', ''])(
    'rechaza la fecha de siembra %s',
    (date) => {
      const input = { ...peru, planting: { status: 'known', date, precision: 'day' } };
      expect(farmInputSchema.safeParse(input).success).toBe(false);
    },
  );

  it('acepta el 29 de febrero bisiesto y conserva la fecha local como texto', () => {
    const input = { ...peru, planting: { status: 'known', date: '2028-02-29', precision: 'day' } };
    const parsed = farmInputSchema.parse(input);
    expect(parsed.planting).toEqual({ status: 'known', date: '2028-02-29', precision: 'day' });
  });

  it.each([
    ['nulo', null],
    ['texto', 'arroz'],
    ['lista', []],
    ['vacío', {}],
    ['clave extra', { ...peru, email: 'a@b.c' }],
    ['objetivo inválido', { ...peru, goal: 'profit' }],
    ['agua numérica', { ...peru, water: 0 }],
    ['agua ausente', { ...peru, water: undefined }],
    ['cultivo vacío', { ...peru, crop: { status: 'known', stage: 'current', name: '   ' } }],
    ['cultivo largo', { ...peru, crop: { status: 'known', stage: 'current', name: 'a'.repeat(81) } }],
    ['cultivo sin etapa', { ...peru, crop: { status: 'known', name: 'Maíz' } }],
    ['desconocido con resto', { ...peru, crop: { status: 'unknown', name: 'Maíz' } }],
  ])('rechaza el payload: %s', (_, payload) => {
    expect(farmInputSchema.safeParse(payload).success).toBe(false);
  });

  it('devuelve un error de contrato con rutas y sin eco de valores', () => {
    const result = parseFarmInput({ ...peru, location: { ...peru.location, lat: 123 }, goal: 'secreto' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe('invalid_input');
    expect(result.error.issues.map((i) => i.path).sort()).toEqual(['goal', 'location.lat']);
    expect(JSON.stringify(result.error)).not.toMatch(/secreto|123/);
  });
});

const record: EvidenceRecord = {
  id: 'power:T2M:-7.0_-80.0:2025-01-01_2025-01-03',
  source: 'power',
  dataset: {
    id: 'NASA/POWER',
    url: 'https://power.larc.nasa.gov/docs/services/api/temporal/daily/',
    product: 'POWER Daily (MERRA-2)',
    version: '2.5.0',
  },
  variable: 'T2M',
  unit: 'C',
  kind: 'modeled_estimate',
  grid: { cellId: '-7.0_-80.0', lat: -7, lon: -80, nativeResolution: '0.5° x 0.625°' },
  period: { start: '2025-01-01', end: '2025-01-03' },
  retrievedAt: '2026-11-14T12:00:00Z',
  coverage: { status: 'partial', validCount: 2, expectedCount: 3, quality: [] },
  cache: { origin: 'live', expiresAt: '2026-11-15T12:00:00Z' },
  limitations: ['Estimación modelada, no medición en la parcela.'],
  data: {
    type: 'series',
    step: 'day',
    points: [
      { t: '2025-01-01', v: 24.1 },
      { t: '2025-01-02', v: null },
      { t: '2025-01-03', v: 0 },
    ],
  },
};

describe('evidencia científica', () => {
  it('conserva el faltante como null y el cero real como cero', () => {
    const parsed = evidenceRecordSchema.parse(record);
    expect(parsed.data.type === 'series' && parsed.data.points.map((p) => p.v)).toEqual([24.1, null, 0]);
  });

  it.each([
    ['valor ausente en un punto', { data: { type: 'series', step: 'day', points: [{ t: '2025-01-01' }] } }],
    ['fecha de punto inválida', { data: { type: 'series', step: 'day', points: [{ t: '2025-02-30', v: 1 }] } }],
    ['tipo de evidencia inventado', { kind: 'forecast' }],
    ['enlace sin https', { dataset: { ...record.dataset, url: 'http://power.larc.nasa.gov/' } }],
    ['unidad vacía', { unit: '' }],
    ['periodo invertido', { period: { start: '2025-02-01', end: '2025-01-01' } }],
    ['recuperación sin zona UTC', { retrievedAt: '2026-11-14T12:00:00' }],
    ['más válidos que esperados', { coverage: { ...record.coverage, validCount: 4 } }],
    ['sin cobertura con válidos', { coverage: { ...record.coverage, status: 'none' } }],
  ])('rechaza el registro: %s', (_, patch) => {
    expect(evidenceRecordSchema.safeParse({ ...record, ...patch }).success).toBe(false);
  });

  it('marca la serie insuficiente sin valor calculado', () => {
    const statistic = {
      type: 'statistic',
      name: 'anomaly',
      method: 'Media del mes menos media del mismo mes en la referencia',
      methodVersion: '1',
      baseline: { start: '2001-01-01', end: '2020-12-31' },
      sampleCount: 3,
      minSampleCount: 10,
    };
    expect(evidenceRecordSchema.safeParse({ ...record, data: { ...statistic, value: 1.2 } }).success).toBe(false);
    expect(evidenceRecordSchema.safeParse({ ...record, data: { ...statistic, value: null } }).success).toBe(true);
  });

  it('acepta una respuesta FIRMS válida sin detecciones', () => {
    const firms = {
      ...record,
      id: 'firms:VIIRS_NOAA20_NRT:cell',
      source: 'firms',
      kind: 'observation',
      coverage: { status: 'complete', validCount: 0, expectedCount: 0, quality: [] },
      data: { type: 'detections', items: [] },
    };
    expect(evidenceRecordSchema.safeParse(firms).success).toBe(true);
  });

  it('exige estado por fuente y prohíbe registros de una fuente caída', () => {
    const base = {
      query: { lat: -6.77, lon: -79.84, window: record.period },
      assembledAt: '2026-11-14T12:00:01Z',
      records: [record],
    };
    const status = { source: 'power', state: 'partial', ageSeconds: 1, detail: null };
    expect(climateEvidenceSchema.safeParse({ ...base, sources: [status] }).success).toBe(true);
    expect(climateEvidenceSchema.safeParse({ ...base, sources: [] }).success).toBe(false);
    expect(
      climateEvidenceSchema.safeParse({ ...base, sources: [{ ...status, state: 'unavailable' }] }).success,
    ).toBe(false);
  });
});

const finding = { id: 'reason.family_break', ruleId: 'rotation.family', evidenceIds: [record.id], params: {} };
const plan = (role: 'A' | 'B', patch: Partial<Plan> = {}): Plan => ({
  role,
  completeness: 'complete',
  scenario: role === 'A' ? { id: 'reference', nature: 'observed_reference' } : { id: 'limited_water', nature: 'hypothetical' },
  cropIds: ['frijol'],
  reasons: [finding],
  restrictions: [],
  actions: [],
  reconsiderSignals: [],
  toVerify: [],
  ...patch,
});
const result = (patch: Partial<AnalysisResult>): unknown => ({
  contractVersion: 1,
  status: 'ok',
  engineVersion: '0.1.0',
  generatedAt: '2026-11-14T12:00:02Z',
  planA: plan('A'),
  planB: plan('B'),
  missing: [],
  climate: {
    query: { lat: -6.77, lon: -79.84, window: record.period },
    assembledAt: '2026-11-14T12:00:01Z',
    sources: [{ source: 'power', state: 'partial', ageSeconds: 1, detail: null }],
    records: [record],
  },
  ...patch,
});

describe('escenarios, planes y resultado', () => {
  it('distingue la referencia observada de los escenarios hipotéticos', () => {
    expect(scenarioSchema.safeParse({ id: 'reference', nature: 'observed_reference' }).success).toBe(true);
    expect(scenarioSchema.safeParse({ id: 'hotter', nature: 'projection' }).success).toBe(true);
    expect(scenarioSchema.safeParse({ id: 'less_rain', nature: 'observed_reference' }).success).toBe(false);
    expect(scenarioSchema.safeParse({ id: 'reference', nature: 'hypothetical' }).success).toBe(false);
  });

  it('rechaza puntajes de confianza y planes sin sustento', () => {
    expect(planSchema.safeParse({ ...plan('A'), confidence: 0.9 }).success).toBe(false);
    expect(planSchema.safeParse(plan('A', { reasons: [] })).success).toBe(false);
    expect(planSchema.safeParse(plan('B', { completeness: 'incomplete', cropIds: [] })).success).toBe(false);
    expect(
      planSchema.safeParse(plan('B', { completeness: 'incomplete', cropIds: [], reasons: [], toVerify: [finding] })).success,
    ).toBe(true);
  });

  it('separa resultado completo, parcial y sin evidencia', () => {
    const incompleteB = plan('B', { completeness: 'incomplete', toVerify: [finding] });
    expect(analysisResultSchema.safeParse(result({})).success).toBe(true);
    expect(analysisResultSchema.safeParse(result({ planB: null })).success).toBe(false);
    expect(analysisResultSchema.safeParse(result({ planB: incompleteB })).success).toBe(false);
    expect(analysisResultSchema.safeParse(result({ status: 'partial', planB: incompleteB })).success).toBe(true);
    expect(analysisResultSchema.safeParse(result({ status: 'partial', planA: null, planB: null })).success).toBe(false);
    expect(analysisResultSchema.safeParse(result({ planA: plan('B') })).success).toBe(false);
    const none = { status: 'insufficient_evidence', planA: null, planB: null } as const;
    expect(analysisResultSchema.safeParse(result({ ...none, missing: [] })).success).toBe(false);
    expect(analysisResultSchema.safeParse(result({ ...none, missing: [finding] })).success).toBe(true);
    expect(analysisResultSchema.safeParse(result({ ...none, planA: plan('A'), missing: [finding] })).success).toBe(false);
  });
});

describe('fecha calendario', () => {
  it('no admite instantes ni años fuera de rango', () => {
    expect(localDateSchema.safeParse('2025-06-15').success).toBe(true);
    expect(localDateSchema.safeParse('1899-12-31').success).toBe(false);
    expect(localDateSchema.safeParse(new Date('2025-06-15')).success).toBe(false);
  });
});
