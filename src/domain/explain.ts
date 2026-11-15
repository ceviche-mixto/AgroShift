import type { Finding, Plan, ResultState, Scenario } from './contracts.ts';

// Explicaciones por plantilla, iguales en navegador y servidor. Puro y sin Zod: el texto visible
// sale solo de los hechos del motor (`id` + `params`), así nadie añade afirmaciones nuevas.

export type Fact = Pick<Finding, 'id' | 'ruleId' | 'params'>;
export interface PlanFacts {
  completeness: Plan['completeness'];
  scenario: Scenario;
  cropIds: string[];
  reasons: Fact[];
  restrictions: Fact[];
  actions: Fact[];
  reconsiderSignals: Fact[];
  toVerify: Fact[];
}
export interface ResultFacts {
  status: ResultState;
  planA: PlanFacts | null;
  planB: PlanFacts | null;
  missing: Fact[];
}

const CROP_NAMES: Record<string, string> = {
  maize: 'maíz',
  rice: 'arroz',
  wheat: 'trigo',
  common_bean: 'frijol',
  cowpea: 'caupí',
  chickpea: 'garbanzo',
  sorghum: 'sorgo',
  finger_millet: 'mijo dedo',
};

const FAMILY_NAMES: Record<string, string> = { vegetable: 'hortaliza', tuber: 'tubérculo', perennial: 'cultivo perenne' };
/** Nombre cotidiano del grupo general de un cultivo sin ficha propia. */
export const familyName = (groupId: unknown): string => (typeof groupId === 'string' && FAMILY_NAMES[groupId]) || 'cultivo sin ficha';

/** Nombre cotidiano en español del cultivo canónico. Un ID sin nombre se muestra sin guiones. */
export function cropName(cropId: string): string {
  return CROP_NAMES[cropId] ?? cropId.replace(/[_-]+/g, ' ');
}

type Params = Fact['params'];
/** Valor de `params` para mostrar: coma decimal en números y «sin dato» si falta. */
const n = (v: Params[string] | undefined) =>
  v === null || v === undefined ? 'sin dato' : typeof v === 'number' ? String(v).replace('.', ',') : v;
const crop = (v: Params[string] | undefined) => (typeof v === 'string' ? cropName(v) : 'el cultivo');

// Una frase por hecho. «Año de referencia» = el único año de clima que usa el motor.
const TEMPLATES = {
  'reason.not_repeated': (p) => `No repites ${crop(p.previous)}: cambiar de cultivo corta plagas y enfermedades propias de ese cultivo.`,
  'reason.cereal_after_legume': (p) =>
    `Después de ${crop(p.previous)}, que es leguminosa, un cereal como ${crop(p.crop)} aprovecha el nitrógeno que queda en el suelo.`,
  'reason.legume_after_cereal': (p) =>
    `Después de ${crop(p.previous)}, que es cereal, ${crop(p.crop)} alterna el cultivo: es leguminosa y deja nitrógeno para el cereal que siembres luego.`,
  'reason.legume_after_family': (p) =>
    `Tu cultivo anterior es de tipo ${familyName(p.family)} y no tiene ficha propia: se usó una regla general por familia de cultivo. ${crop(p.crop)} es leguminosa y deja nitrógeno en el suelo.`,
  'reason.thermal_optimal': (p) =>
    `La temperatura media de esas fechas en el año de referencia (${n(p.tempC)} °C) está en el rango ideal de ${crop(p.crop)} (${n(p.min)} a ${n(p.max)} °C).`,
  'reason.thermal_within_limits': (p) =>
    `La temperatura media de esas fechas en el año de referencia (${n(p.tempC)} °C) está dentro de los límites de ${crop(p.crop)} (${n(p.min)} a ${n(p.max)} °C).`,
  'reason.rain_covers_minimum': (p) =>
    `La lluvia del año de referencia (cerca de ${n(p.rainMm)} mm) alcanza el mínimo que pide ${crop(p.crop)} (${n(p.minMm)} mm al año), sin contar riego.`,
  'reason.rain_margin': (p) =>
    `En el año de referencia llovió cerca de ${n(p.rainMm)} mm y ${crop(p.crop)} pide al menos ${n(p.minMm)} mm al año: quedan ${n(p.marginMm)} mm de margen.`,
  'reason.regional_season': (p) => `Las fechas caben en una temporada documentada para ${crop(p.crop)} en tu zona: ${n(p.season)}.`,
  'reason.less_water_than_plan_a': (p) =>
    `Según su ficha, ${crop(p.crop)} se da bien desde ${n(p.optimalMinMm)} mm de lluvia al año y ${crop(p.other)}, desde ${n(p.otherOptimalMinMm)} mm: pide menos agua.`,
  'reason.fallow_no_rain_support': (p) =>
    `La lluvia del año de referencia (cerca de ${n(p.rainMm)} mm) no alcanza el mínimo de ningún otro cultivo del catálogo (desde ${n(p.minMm)} mm al año): sin riego, ninguno se sostiene.`,
  'reason.green_manure_legume': () =>
    'Una leguminosa de cobertura (abono verde) puede dejar nitrógeno para el cereal que siembres después; cuánto aporta depende de la especie y del agua, y aquí no se calcula.',
  'reason.lower_water_need': (p) => `Para ahorrar agua: según su ficha, ${crop(p.crop)} se da bien desde ${n(p.optimalMinMm)} mm de lluvia al año.`,

  'restriction.reference_year': (p) =>
    `Se usó el clima de un solo año de referencia (${n(p.start)} a ${n(p.end)}), no un promedio de muchos años: otro año puede ser distinto.`,
  'restriction.stale_evidence': () => 'Los datos de clima vienen de una copia guardada, no de una consulta reciente.',
  'restriction.hypothetical': (p) => `Supuesto, no pronóstico. ${n(p.assumption)}`,
  'restriction.thermal_outside_optimal': (p) =>
    `La temperatura media de esas fechas (${n(p.tempC)} °C) queda fuera del rango ideal de ${crop(p.crop)} (${n(p.min)} a ${n(p.max)} °C), aunque dentro de sus límites.`,
  'restriction.depends_on_irrigation': (p) =>
    `La lluvia del año de referencia (cerca de ${n(p.rainMm)} mm) no alcanza el mínimo de ${crop(p.crop)} (${n(p.minMm)} mm al año): este plan depende del riego.`,
  'restriction.rain_below_minimum': (p) =>
    `Con poca agua, la lluvia del año de referencia (cerca de ${n(p.rainMm)} mm) no alcanza el mínimo de ${crop(p.crop)} (${n(p.minMm)} mm al año): este plan necesita riego suplementario.`,
  'restriction.green_manure_needs_water': () =>
    'La leguminosa de cobertura también necesita algo de agua para crecer: si no la tienes, deja la parcela en descanso sin sembrar.',
  'restriction.rain_above_maximum': (p) =>
    `La lluvia del año de referencia (cerca de ${n(p.rainMm)} mm) supera el máximo que tolera ${crop(p.crop)} según su ficha (${n(p.maxMm)} mm al año).`,
  'restriction.outside_regional_season': (p) =>
    `Las fechas no caben en las temporadas documentadas para ${crop(p.crop)} en tu zona (${n(p.seasons)}).`,

  'action.consult_local_technician': (p) =>
    `Esto es un apoyo para decidir: confirma fechas de siembra y variedad de ${crop(p.crop)} con un técnico agrario de tu zona.`,
  'action.consult_green_manure': () =>
    'Antes de sembrar la cobertura, confirma con un técnico agrario de tu zona qué especie usar y cuánta agua necesita.',
  'action.secure_irrigation': (p) => `Asegura el riego para todo el ciclo de ${crop(p.crop)}: la lluvia sola no alcanza.`,

  'signal.temperature_out_of_limits': (p) =>
    `Si la temperatura media de la campaña sale del rango de ${n(p.min)} a ${n(p.max)} °C, ${crop(p.crop)} deja de ser opción: revisa el otro plan.`,
  'signal.irrigation_available': () => 'Si consigues agua de riego para todo el ciclo, vuelve al Plan A.',
  'signal.less_irrigation': (p) => `Si el agua de riego resulta menor a la prevista, ${crop(p.crop)} se queda sin respaldo: revisa el otro plan.`,
  'signal.rain_below_minimum': (p) => `Si la lluvia del año baja de ${n(p.minMm)} mm, ${crop(p.crop)} necesitaría riego: revisa el otro plan.`,

  'verify.previous_crop_unknown': () =>
    'No sabemos qué cultivo hubo antes: confirma que no sea el mismo que te proponemos, porque no conviene repetirlo.',
  'verify.previous_crop_not_in_catalog': () =>
    'Tu cultivo anterior no está en nuestro catálogo y no pudimos revisar la rotación: confirma la secuencia con un técnico local.',
  'verify.previous_crop_family_rule': (p) =>
    `La rotación se calculó con una regla general para ${familyName(p.family)}, no con la ficha de tu cultivo anterior: confirma la secuencia con un técnico local.`,
  'verify.planting_date': () => 'Indica al menos el mes de siembra: sin fecha no podemos comparar el clima con ningún cultivo.',
  'verify.water_availability': (p) =>
    `No sabemos cuánta agua tendrás: la lluvia del año de referencia (cerca de ${n(p.rainMm)} mm) no alcanza el mínimo de ${crop(p.crop)} (${n(p.minMm)} mm al año).`,
  'verify.regional_calendar': (p) => `No tenemos un calendario de siembra respaldado para ${crop(p.crop)} en tu zona: verifícalo localmente.`,
  'verify.variety_cycle': (p) => `Se evaluó el ciclo más corto de la ficha de ${crop(p.crop)} (${n(p.days)} días): confirma cuánto dura tu variedad.`,
  'verify.soil_ph': (p) => `No tenemos datos de tu suelo: ${crop(p.crop)} pide un pH entre ${n(p.min)} y ${n(p.max)}.`,
  'verify.no_candidate': () =>
    'Ningún cultivo del catálogo quedó dentro de sus límites de temperatura para esas fechas: consulta con un técnico local.',
  'verify.no_alternative': (p) =>
    `Bajo este supuesto no encontramos otra opción con sustento (lluvia del año de referencia: cerca de ${n(p.rainMm)} mm). Confirma tu agua disponible con un técnico local.`,

  'missing.temperature': (p) =>
    `Faltan datos de temperatura del año de referencia: hay ${n(p.validDays)} días válidos y se necesitan ${n(p.minDays)}.`,
  'missing.rain': (p) => `Faltan datos de lluvia del año de referencia: hay ${n(p.validDays)} días válidos y se necesitan ${n(p.minDays)}.`,
  'missing.cycle_coverage': () => 'Los datos de clima no cubren lo suficiente las fechas del ciclo de ningún cultivo.',
} satisfies Record<string, (p: Params) => string>;

/** Hechos que significan «este plan necesita riego»: base de la insignia de condición clave. */
const IRRIGATION_FACTS: string[] = ['restriction.depends_on_irrigation', 'restriction.rain_below_minimum'];
export const needsIrrigation = (plan: Pick<PlanFacts, 'restrictions'> | null) =>
  !!plan?.restrictions.some((f) => IRRIGATION_FACTS.includes(f.id));

export type FindingId = keyof typeof TEMPLATES;
/** Todos los `id` de hallazgo que el motor puede emitir. */
export const FINDING_IDS = Object.keys(TEMPLATES) as FindingId[];

/** Frase breve en español. Un `id` sin plantilla devuelve un texto neutro: nunca lanza. */
export function explainFinding(fact: Fact): string {
  const template = (TEMPLATES as Record<string, (p: Params) => string>)[fact.id];
  return template ? template(fact.params) : 'Hay un dato más que conviene revisar con un técnico local.';
}

export const QUESTION_IDS = ['why_plan_a', 'less_water', 'when_to_switch', 'what_to_check'] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

const QUESTIONS: Record<QuestionId, string> = {
  why_plan_a: '¿Por qué me proponen el Plan A?',
  less_water: '¿Qué pasa si tengo menos agua?',
  when_to_switch: '¿Cuándo debería pasar al Plan B?',
  what_to_check: '¿Qué debo verificar antes de sembrar?',
};
export function questionText(id: QuestionId): string {
  return QUESTIONS[id];
}

const LISTS = ['reasons', 'restrictions', 'actions', 'reconsiderSignals', 'toVerify'] as const;

/** Hechos con clave estable: 'A:reasons:0', 'B:toVerify:1', 'M:0'. */
export function listFacts(result: ResultFacts): { key: string; fact: Fact }[] {
  const of = (role: 'A' | 'B', plan: PlanFacts | null) =>
    plan ? LISTS.flatMap((list) => plan[list].map((fact, i) => ({ key: `${role}:${list}:${i}`, fact }))) : [];
  return [...of('A', result.planA), ...of('B', result.planB), ...result.missing.map((fact, i) => ({ key: `M:${i}`, fact }))];
}

// Prefijos de clave por pregunta, en orden de importancia.
const ANSWERS: Record<QuestionId, string[]> = {
  why_plan_a: ['A:reasons:', 'A:restrictions:'],
  less_water: ['B:restrictions:', 'B:reasons:', 'B:toVerify:'],
  when_to_switch: ['A:reconsiderSignals:', 'B:restrictions:'],
  what_to_check: ['M:', 'A:toVerify:', 'B:toVerify:', 'A:actions:'],
};

/** Hasta 4 claves de `listFacts`. Si la pregunta no tiene hechos propios, devuelve los primeros disponibles. */
export function answerLocally(id: QuestionId, result: ResultFacts): string[] {
  const keys = listFacts(result).map((f) => f.key);
  const own = ANSWERS[id].flatMap((prefix) => keys.filter((k) => k.startsWith(prefix)));
  return (own.length ? own : keys).slice(0, 4);
}
