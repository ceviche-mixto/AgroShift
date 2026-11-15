import type { AnalysisResult, ClimateEvidence, FarmInput, Finding, Plan, Scenario, WaterLevel } from './contracts.ts';
import { CROPS, RULES, findCrop, regionFor, type Crop, type Rule } from './crops.ts';
import type { FindingId } from './explain.ts';
import { alternativeFor, REFERENCE, type Alternative } from './scenarios.ts';

// Motor determinista de rotación. Puro: sin reloj, red ni azar; la misma entrada da la misma salida.
// Es apoyo a la decisión: no emite puntajes, porcentajes ni niveles de confianza.
//
// QUÉ SE COMPARA
// - Ciclo: los `cycle.range.min` días de la ficha (el ciclo más corto, lo mínimo que necesita cualquier
//   variedad) desde la fecha de siembra (día 1 si la precisión es de mes), tomando los mismos días
//   del año de referencia y envolviendo el fin de año. Un ciclo más largo queda en `toVerify`.
// - Térmico: media de T2M (temperatura media diaria) de esos días contra los rangos de la ficha.
//   Se usa la media porque la regla thermal-limit habla de «temperatura media del periodo»;
//   T2M_MIN y T2M_MAX no se usan porque la ficha no declara la base temporal de sus temperaturas.
// - Hídrico: lluvia ANUAL de referencia (media diaria de PRECTOTCORR × 365) contra la lluvia ANUAL
//   de la ficha. No se compara la lluvia del ciclo con un requisito anual. El riego no se cuantifica.
// - Calendario: solo si el catálogo trae temporada respaldada para la región; si no, queda en `toVerify`.
// - Suelo: no hay evidencia de pH, así que el rango de la ficha va a `toVerify`, nunca como restricción.
// SMAP, Giovanni y FIRMS no intervienen: el catálogo no trae umbrales con qué compararlos.
//
// DATOS INDISPENSABLES (engine.data_requirement)
// Series diarias de POWER T2M y PRECTOTCORR con al menos MIN_VALID_SHARE de días válidos en el año
// de referencia y en el ciclo de cada cultivo. Un `null` es faltante, nunca 0.
//
// DESCARTE (solo reglas activas): rotation_same_crop y thermal_limit (rango absoluto de la ficha).
// SIN SUSTENTO HÍDRICO (engine.water_support): lluvia sobre el máximo absoluto, o bajo el mínimo
// absoluto sin riego declarado. No descarta (water_minimum solo avisa), pero el cultivo va al final
// y su plan queda incompleto.
//
// ORDEN (de mayor a menor peso; el primero que difiere decide)
// 1. con sustento hídrico; 2. solo en less_rain: menor lluvia mínima de la ficha;
// 3. objetivo: save_water = menor lluvia óptima mínima y luego menor mínima absoluta,
//    care_soil = alterna cereal y leguminosa (rotation_legume_cereal), next_crop = nada;
// 4. dentro de temporada regional respaldada; 5. temperatura en rango óptimo;
// 6. alterna cereal y leguminosa; 7. orden alfabético de `id`.
//
// ESTADO
// | Situación                                                        | Resultado                         |
// | Falta POWER, fuente no disponible o cobertura bajo el umbral     | insufficient_evidence + missing   |
// | Fecha de siembra desconocida                                     | partial: A incompleto sin cultivo |
// | Cultivo previo desconocido o fuera de catálogo (sin rotación)    | partial: A y B incompletos        |
// | Agua unknown o limited y la lluvia no cubre el mínimo            | partial: plan incompleto          |
// | Ningún cultivo distinto con sustento bajo el supuesto del Plan B | partial: B incompleto sin cultivo |
// | A y B con sustento                                               | ok                                |
// Regla general: falta evidencia climática = insufficient_evidence; falta una respuesta de la
// persona o respaldo del catálogo = partial con `toVerify`.

/** Cambia si cambian las reglas o la lógica. */
export const ENGINE_VERSION = '0.1.0';
export type EngineResult = Pick<AnalysisResult, 'status' | 'engineVersion' | 'planA' | 'planB' | 'missing'>;

/** Mínimo de días válidos. Mismo criterio de 80 % que usa la ingesta de Giovanni para un mes válido. */
export const MIN_VALID_SHARE = 0.8;

/** `ruleId` de los hechos que salen del motor y no de una regla del catálogo. */
const ENGINE = {
  data: 'engine.data_requirement', // cobertura mínima y vigencia de la evidencia
  reference: 'engine.reference_year', // la referencia es un solo año
  scenario: 'engine.scenario', // supuesto del escenario hipotético
  thermal: 'engine.thermal_optimal', // comparación con el rango óptimo de temperatura
  water: 'engine.water_support', // lluvia anual frente a la ficha y agua declarada
  calendar: 'engine.regional_calendar', // temporada regional del catálogo
  cycle: 'engine.cycle_window', // se evalúa el ciclo más corto de la ficha
  soil: 'engine.soil', // sin evidencia de suelo
  rotation: 'engine.rotation_input', // no se pudo aplicar la rotación
  planting: 'engine.planting_date', // falta la fecha de siembra
  goal: 'engine.goal', // objetivo declarado
  alternative: 'engine.alternative', // no hay segunda opción con sustento
} as const;

const fact = (id: FindingId, ruleId: string, evidenceIds: string[], params: Finding['params'] = {}): Finding => ({
  id,
  ruleId,
  evidenceIds,
  params,
});

const pad = (n: number) => String(n).padStart(2, '0');
/** Los 365 días 'MM-DD' de un año no bisiesto. Una siembra el 29 de febrero se evalúa desde el 1 de marzo. */
const YEAR_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].flatMap((days, m) =>
  Array.from({ length: days }, (_, d) => `${pad(m + 1)}-${pad(d + 1)}`),
);
const minValid = (days: number) => Math.ceil(MIN_VALID_SHARE * days);

interface Daily {
  id: string;
  /** Solo días con valor: un faltante no entra. */
  byDay: Map<string, number>;
}

function daily(climate: ClimateEvidence, variable: string): Daily | null {
  const record = climate.records
    .filter((r) => r.source === 'power' && r.variable === variable && r.data.type === 'series' && r.data.step === 'day')
    .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (!record || record.data.type !== 'series') return null;
  const byDay = new Map<string, number>();
  for (const p of record.data.points) if (p.v !== null) byDay.set(p.t.slice(5), p.v);
  return { id: record.id, byDay };
}

/** Media de los días válidos. `null` si no llegan al umbral de cobertura. */
function meanOf(series: Daily | null, days: string[]): { mean: number | null; valid: number } {
  const values = days.flatMap((d) => series?.byDay.get(d) ?? []);
  const enough = values.length > 0 && values.length >= minValid(days.length);
  return { mean: enough ? values.reduce((a, b) => a + b, 0) / values.length : null, valid: values.length };
}

type Range = { min: number | null; max: number | null };
/** `null` si la ficha no trae el rango completo: no se afirma nada. */
const within = (v: number, r: Range) => (r.min === null || r.max === null ? null : v >= r.min && v <= r.max);

interface Candidate {
  crop: Crop;
  days: number;
  tempC: number;
  optimal: boolean | null;
  rainCovers: boolean;
  rainExcess: boolean;
  alternates: boolean;
  season: 'in' | 'out' | 'none';
  seasons: string;
}

const unbacked = (c: Candidate, water: WaterLevel) => c.rainExcess || (!c.rainCovers && water !== 'enough');

const emptyPlan = (role: Plan['role'], scenario: Scenario, restrictions: Finding[], toVerify: Finding[]): Plan => ({
  role,
  completeness: 'incomplete',
  scenario,
  cropIds: [],
  reasons: [],
  restrictions,
  actions: [],
  reconsiderSignals: [],
  toVerify,
});

export function evaluateRotation(input: FarmInput, climate: ClimateEvidence): EngineResult {
  const result = (status: EngineResult['status'], planA: Plan | null, planB: Plan | null, missing: Finding[] = []): EngineResult => ({
    status,
    engineVersion: ENGINE_VERSION,
    planA,
    planB,
    missing,
  });

  // 1. Datos indispensables
  const temp = daily(climate, 'T2M');
  const rain = daily(climate, 'PRECTOTCORR');
  const tempYear = meanOf(temp, YEAR_DAYS);
  const rainYear = meanOf(rain, YEAR_DAYS);
  const lack = (id: FindingId, series: Daily | null, valid: number) =>
    fact(id, ENGINE.data, series ? [series.id] : [], { validDays: valid, minDays: minValid(YEAR_DAYS.length) });
  if (!temp || !rain || tempYear.mean === null || rainYear.mean === null) {
    return result('insufficient_evidence', null, null, [
      ...(tempYear.mean === null ? [lack('missing.temperature', temp, tempYear.valid)] : []),
      ...(rainYear.mean === null ? [lack('missing.rain', rain, rainYear.valid)] : []),
    ]);
  }
  const rainMm = Math.round(rainYear.mean * YEAR_DAYS.length);
  const ids = [temp.id, rain.id];
  const frame = [
    fact('restriction.reference_year', ENGINE.reference, ids, climate.query.window),
    ...(climate.sources.some((s) => s.source === 'power' && s.state === 'stale')
      ? [fact('restriction.stale_evidence', ENGINE.data, ids)]
      : []),
  ];

  // 2. Sin fecha no se inventa calendario
  if (input.planting.status === 'unknown') {
    return result('partial', emptyPlan('A', REFERENCE, frame, [fact('verify.planting_date', ENGINE.planting, [])]), null);
  }
  const start = input.planting.precision === 'month' ? `${input.planting.date.slice(5, 7)}-01` : input.planting.date.slice(5);
  const startIndex = YEAR_DAYS.findIndex((d) => d >= start);

  // 3. Reglas activas que alcanzan a la ubicación. El efecto de cada tipo es el de rules.json 1.0.0.
  const region = regionFor(input.location.lat, input.location.lon);
  const rule = (type: Rule['type']) =>
    RULES.find((r) => r.active && r.type === type && (r.scope.kind === 'global' || (region !== null && r.scope.regionIds.includes(region))));
  const sameCrop = rule('rotation_same_crop');
  const legumeCereal = rule('rotation_legume_cereal');
  const thermal = rule('thermal_limit');
  const waterMin = rule('water_minimum');
  // Cultivo actual o último cosechado: la regla los trata igual. Sin cultivo reconocido no se asume nada.
  const previous = input.crop.status === 'known' ? findCrop(input.crop.name) : null;

  // 4. Candidatos
  const candidates: Candidate[] = [];
  let evaluable = 0;
  for (const crop of CROPS) {
    const cycle = crop.cycle.range.min;
    if (cycle === null) continue;
    const days = Array.from({ length: Math.min(cycle, YEAR_DAYS.length) }, (_, i) => YEAR_DAYS[(startIndex + i) % YEAR_DAYS.length]!);
    const mean = meanOf(temp, days).mean;
    if (mean === null || meanOf(rain, days).mean === null) continue; // sin cobertura en su ciclo
    evaluable++;
    const tempC = Math.round(mean * 10) / 10;
    if (sameCrop && previous?.id === crop.id) continue;
    if (thermal && within(tempC, crop.temperature.absolute) === false) continue;

    const { min, max } = crop.rainfall.absolute;
    const months = [...new Set(days.map((d) => Number(d.slice(0, 2))))];
    const windows = crop.regions.find((r) => r.id === region && r.coverage === 'supported')?.windows ?? [];
    // Temporada de cultivo (incluye cosecha): el ciclo evaluado debe caber entero
    const fits = windows.filter((w) =>
      months.every((m) => (w.startMonth <= w.endMonth ? m >= w.startMonth && m <= w.endMonth : m >= w.startMonth || m <= w.endMonth)),
    );
    candidates.push({
      crop,
      days: days.length,
      tempC,
      optimal: within(tempC, crop.temperature.optimal),
      rainExcess: max !== null && rainMm > max,
      rainCovers: min !== null && rainMm >= min && !(max !== null && rainMm > max),
      alternates: !!legumeCereal && !!previous && previous.group !== crop.group,
      season: windows.length === 0 ? 'none' : fits.length ? 'in' : 'out',
      seasons: (fits.length ? fits : windows).map((w) => w.label).join('; ').slice(0, 120),
    });
  }
  if (evaluable === 0) return result('insufficient_evidence', null, null, [fact('missing.cycle_coverage', ENGINE.data, ids)]);

  const rank = (water: WaterLevel, lessRain: boolean) => {
    const key = (c: Candidate) => [
      unbacked(c, water) ? 1 : 0,
      lessRain ? (c.crop.rainfall.absolute.min ?? Infinity) : 0,
      input.goal === 'save_water' ? (c.crop.rainfall.optimal.min ?? Infinity) : 0,
      input.goal === 'save_water' ? (c.crop.rainfall.absolute.min ?? Infinity) : 0,
      input.goal === 'care_soil' && !c.alternates ? 1 : 0,
      c.season === 'out' ? 1 : 0,
      c.optimal ? 0 : 1,
      c.alternates ? 0 : 1,
    ];
    return [...candidates].sort((x, y) => {
      const kx = key(x);
      const ky = key(y);
      const i = kx.findIndex((v, j) => v !== ky[j]);
      return i >= 0 ? (kx[i]! < ky[i]! ? -1 : 1) : x.crop.id < y.crop.id ? -1 : 1;
    });
  };

  // 5. Plan para un candidato bajo un escenario. `alt === null` es la referencia.
  const planFor = (role: Plan['role'], alt: Alternative | null, c: Candidate | undefined): Plan => {
    const scenario = alt?.scenario ?? REFERENCE;
    const water = alt?.water ?? input.water;
    const restrictions = alt
      ? [fact('restriction.hypothetical', ENGINE.scenario, [rain.id], { scenario: scenario.id, assumption: alt.assumption })]
      : [...frame];
    if (!c) {
      return emptyPlan(role, scenario, restrictions, [
        role === 'A'
          ? fact('verify.no_candidate', thermal?.id ?? ENGINE.thermal, [temp.id])
          : fact('verify.no_alternative', ENGINE.alternative, [rain.id], { rainMm }),
      ]);
    }
    const { crop } = c;
    const id = crop.id;
    const reasons: Finding[] = [];
    const actions: Finding[] = [];
    const signals: Finding[] = [];
    const toVerify: Finding[] = [];

    // Rotación
    if (!previous) {
      const which = input.crop.status === 'unknown' ? 'verify.previous_crop_unknown' : 'verify.previous_crop_not_in_catalog';
      toVerify.push(fact(which, ENGINE.rotation, []));
    } else {
      if (sameCrop) reasons.push(fact('reason.not_repeated', sameCrop.id, [], { previous: previous.id }));
      if (legumeCereal && c.alternates) {
        const which = crop.group === 'cereal' ? 'reason.cereal_after_legume' : 'reason.legume_after_cereal';
        reasons.push(fact(which, legumeCereal.id, [], { crop: id, previous: previous.id }));
      }
    }

    // Temperatura
    const limits = { crop: id, ...crop.temperature.absolute };
    const insideLimits = thermal && within(c.tempC, crop.temperature.absolute);
    const ideal = { crop: id, tempC: c.tempC, ...crop.temperature.optimal };
    if (c.optimal) reasons.push(fact('reason.thermal_optimal', ENGINE.thermal, [temp.id], ideal));
    else if (insideLimits) reasons.push(fact('reason.thermal_within_limits', thermal.id, [temp.id], { ...limits, tempC: c.tempC }));
    if (c.optimal === false) restrictions.push(fact('restriction.thermal_outside_optimal', ENGINE.thermal, [temp.id], ideal));
    if (insideLimits) signals.push(fact('signal.temperature_out_of_limits', thermal.id, [temp.id], limits));

    // Agua: lluvia anual de referencia frente a la ficha, más el agua declarada o la del supuesto
    const { min: minMm, max: maxMm } = crop.rainfall.absolute;
    const numbers = { crop: id, rainMm, minMm };
    if (c.rainExcess) {
      restrictions.push(fact('restriction.rain_above_maximum', ENGINE.water, [rain.id], { crop: id, rainMm, maxMm }));
    } else if (c.rainCovers) {
      reasons.push(
        scenario.id === 'less_rain'
          ? fact('reason.rain_margin', ENGINE.water, [rain.id], { ...numbers, marginMm: rainMm - (minMm ?? 0) })
          : fact('reason.rain_covers_minimum', ENGINE.water, [rain.id], numbers),
      );
      signals.push(fact('signal.rain_below_minimum', waterMin?.id ?? ENGINE.water, [rain.id], { crop: id, minMm }));
    } else if (water === 'enough') {
      restrictions.push(fact('restriction.depends_on_irrigation', ENGINE.water, [rain.id], numbers));
      actions.push(fact('action.secure_irrigation', ENGINE.water, [rain.id], { crop: id }));
      signals.push(fact('signal.less_irrigation', ENGINE.water, [rain.id], { crop: id }));
    } else if (water === 'limited') {
      restrictions.push(fact('restriction.rain_below_minimum', waterMin?.id ?? ENGINE.water, [rain.id], numbers));
      toVerify.push(fact('verify.irrigation_amount', ENGINE.water, [rain.id], { crop: id }));
    } else {
      toVerify.push(fact('verify.water_availability', ENGINE.water, [rain.id], numbers));
    }
    if (input.goal === 'save_water' && crop.rainfall.optimal.min !== null) {
      reasons.push(fact('reason.lower_water_need', ENGINE.goal, [], { crop: id, optimalMinMm: crop.rainfall.optimal.min }));
    }

    // Calendario regional y lo que el motor no puede comprobar
    if (c.season === 'in') reasons.push(fact('reason.regional_season', ENGINE.calendar, [], { crop: id, season: c.seasons }));
    else if (c.season === 'out') {
      restrictions.push(fact('restriction.outside_regional_season', ENGINE.calendar, [], { crop: id, seasons: c.seasons }));
    } else {
      toVerify.push(fact('verify.regional_calendar', ENGINE.calendar, [], { crop: id }));
      actions.push(fact('action.consult_local_technician', ENGINE.calendar, [], { crop: id }));
    }
    toVerify.push(fact('verify.variety_cycle', ENGINE.cycle, [], { crop: id, days: c.days }));
    if (within(0, crop.ph.absolute) !== null) toVerify.push(fact('verify.soil_ph', ENGINE.soil, [], { crop: id, ...crop.ph.absolute }));

    const complete = !!previous && !unbacked(c, water) && reasons.length > 0;
    return {
      role,
      completeness: complete ? 'complete' : 'incomplete',
      scenario,
      cropIds: [id], // un cultivo: no se encadenan campañas sin sustento
      reasons: reasons.slice(0, 12),
      restrictions: restrictions.slice(0, 12),
      actions: actions.slice(0, 12),
      reconsiderSignals: signals.slice(0, 12),
      toVerify: toVerify.slice(0, 12),
    };
  };

  // 6. Plan A en la referencia; Plan B = mejor opción DISTINTA con sustento bajo el supuesto
  const a = rank(input.water, false)[0];
  const alt = alternativeFor(input.water);
  const b = rank(alt.water, alt.scenario.id === 'less_rain').find((c) => c.crop.id !== a?.crop.id && !unbacked(c, alt.water));
  const planA = planFor('A', null, a);
  const planB = planFor('B', alt, b);
  return result(planA.completeness === 'complete' && planB.completeness === 'complete' ? 'ok' : 'partial', planA, planB);
}
