import { z } from 'zod';

// Contratos puros: sin imports de servidor, sin reloj y sin coerción.
// Un dato faltante es `null` o 'unknown'. Nunca se convierte en 0.
export const CONTRACT_VERSION = 1;

const text = (max: number) => z.string().trim().min(1).max(max);
const unknownAnswer = z.strictObject({ status: z.literal('unknown') });

// ---------- Fechas ----------

/** Fecha calendario local `YYYY-MM-DD`. Se compara como texto: sin `Date` ni zona horaria. */
export const localDateSchema = z.iso
  .date()
  .refine((d) => d >= '1900-01-01' && d <= '2100-12-31', 'Fecha fuera de rango');
export const monthSchema = z.string().regex(/^(19|20)\d{2}-(0[1-9]|1[0-2])$/, 'Mes inválido');
/** Instante UTC con sufijo `Z`. Solo para metadatos técnicos, nunca para la fecha agrícola. */
export const utcInstantSchema = z.iso.datetime();

export const periodSchema = z
  .strictObject({ start: localDateSchema, end: localDateSchema })
  .refine((p) => p.start <= p.end, 'El periodo termina antes de empezar');

// ---------- Entrada del agricultor ----------

const latSchema = z.number().min(-90).max(90);
const lonSchema = z.number().min(-180).max(180);

export const LOCATION_ORIGINS = ['gps', 'manual_coordinates', 'place_search'] as const;
export const GOALS = ['next_crop', 'save_water', 'care_soil'] as const;
export const WATER_LEVELS = ['enough', 'limited', 'unknown'] as const;

/** Punto WGS84 en grados decimales. */
export const locationSchema = z.strictObject({
  lat: latSchema,
  lon: lonSchema,
  origin: z.enum(LOCATION_ORIGINS),
  /** Radio de incertidumbre en metros. `null` = desconocido (coordenadas manuales o localidad). */
  accuracyM: z.number().positive().max(100_000).nullable(),
});

export const cropAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known'),
    stage: z.enum(['current', 'last_harvested']),
    /** Nombre tal como lo escribe o elige la persona. El catálogo lo canoniza. */
    name: text(80),
  }),
  unknownAnswer,
]);

export const plantingAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known'),
    date: localDateSchema.refine((d) => d >= '2000-01-01', 'Fecha de siembra fuera de rango'),
    /** 'month': solo el mes es fiable y el día es un marcador. */
    precision: z.enum(['day', 'month']),
  }),
  unknownAnswer,
]);

export const farmInputSchema = z.strictObject({
  location: locationSchema,
  crop: cropAnswerSchema,
  goal: z.enum(GOALS),
  water: z.enum(WATER_LEVELS),
  planting: plantingAnswerSchema,
});

// ---------- Evidencia científica ----------

export const SOURCES = ['power', 'smap', 'giovanni', 'firms', 'complement'] as const;
export const EVIDENCE_KINDS = [
  'observation',
  'modeled_estimate',
  'hypothetical_scenario',
  'projection',
] as const;
export const CACHE_ORIGINS = ['live', 'shared_cache', 'stale_snapshot', 'local_snapshot'] as const;
export const COVERAGE_STATES = ['complete', 'partial', 'none'] as const;
export const SOURCE_STATES = [
  'available',
  'partial',
  'stale',
  'unavailable',
  'insufficient_coverage',
] as const;

export const coverageSchema = z
  .strictObject({
    status: z.enum(COVERAGE_STATES),
    validCount: z.int().min(0),
    expectedCount: z.int().min(0),
    /** Banderas de calidad o advertencias del producto. */
    quality: z.array(text(200)).max(20),
  })
  .refine((c) => c.validCount <= c.expectedCount, 'validCount supera expectedCount')
  .refine((c) => c.status !== 'none' || c.validCount === 0, "Cobertura 'none' con valores válidos");

/** `v: null` = faltante o relleno del proveedor. */
const pointSchema = z.strictObject({
  t: z.union([localDateSchema, monthSchema]),
  v: z.number().nullable(),
});

export const evidenceDataSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('series'),
    step: z.enum(['day', 'month']),
    points: z.array(pointSchema).max(1000),
  }),
  z
    .strictObject({
      type: z.literal('statistic'),
      name: z.enum(['mean', 'sum', 'min', 'max', 'trend', 'anomaly']),
      /** `null` cuando la muestra es insuficiente. */
      value: z.number().nullable(),
      method: text(300),
      methodVersion: text(40),
      /** Periodo de referencia para anomalías y tendencias. */
      baseline: periodSchema.nullable(),
      sampleCount: z.int().min(0),
      minSampleCount: z.int().min(0),
    })
    .refine(
      (s) => s.sampleCount >= s.minSampleCount || s.value === null,
      'Muestra insuficiente con valor calculado',
    ),
  z.strictObject({
    type: z.literal('detections'),
    items: z
      .array(
        z.strictObject({
          acquiredAt: utcInstantSchema,
          confidence: z.enum(['low', 'nominal', 'high', 'unknown']),
          /** Distancia aproximada al centro de la celda. */
          distanceKm: z.number().min(0),
        }),
      )
      .max(500),
  }),
]);

export const evidenceRecordSchema = z.strictObject({
  /** Clave única del registro. Las razones del motor la referencian. */
  id: text(160),
  source: z.enum(SOURCES),
  dataset: z.strictObject({
    /** Identificador oficial: nombre corto del producto o DOI. */
    id: text(120),
    url: z.url({ protocol: /^https$/ }),
    product: text(120),
    version: text(40),
  }),
  variable: text(80),
  unit: text(40),
  kind: z.enum(EVIDENCE_KINDS),
  grid: z.strictObject({
    cellId: text(80),
    /** Centro de la celda, no la parcela. */
    lat: latSchema,
    lon: lonSchema,
    nativeResolution: text(80),
  }),
  period: periodSchema,
  retrievedAt: utcInstantSchema,
  coverage: coverageSchema,
  cache: z.strictObject({
    origin: z.enum(CACHE_ORIGINS),
    expiresAt: utcInstantSchema.nullable(),
  }),
  /** Límites de uso del producto, en texto breve. */
  limitations: z.array(text(300)).max(10),
  data: evidenceDataSchema,
});

// ---------- Consulta climática y estado por fuente ----------

export const climateQuerySchema = z.strictObject({
  lat: latSchema,
  lon: lonSchema,
  window: periodSchema,
});

export const sourceStatusSchema = z.strictObject({
  source: z.enum(SOURCES),
  state: z.enum(SOURCE_STATES),
  /** Edad del dato más reciente al armar la respuesta. `null` si no hay dato. */
  ageSeconds: z.int().min(0).nullable(),
  /** Código breve del motivo, sin datos personales. */
  detail: text(120).nullable(),
});

export const climateEvidenceSchema = z
  .strictObject({
    query: climateQuerySchema,
    assembledAt: utcInstantSchema,
    sources: z.array(sourceStatusSchema).max(SOURCES.length),
    records: z.array(evidenceRecordSchema).max(60),
  })
  .refine(
    (e) => e.records.every((r) => e.sources.some((s) => s.source === r.source)),
    'Registro sin estado de fuente',
  )
  .refine(
    (e) =>
      e.sources.every(
        (s) => s.state !== 'unavailable' || !e.records.some((r) => r.source === s.source),
      ),
    'Fuente no disponible con registros',
  );

// ---------- Escenarios, planes y resultado ----------

export const SCENARIO_IDS = ['reference', 'less_rain', 'hotter', 'limited_water'] as const;
export const SCENARIO_NATURES = ['observed_reference', 'hypothetical', 'projection'] as const;

export const scenarioSchema = z
  .strictObject({ id: z.enum(SCENARIO_IDS), nature: z.enum(SCENARIO_NATURES) })
  .refine(
    (s) => (s.id === 'reference') === (s.nature === 'observed_reference'),
    'Solo la referencia es observada',
  );

/** Hecho del motor. El texto visible sale de plantillas por `id`. Sin puntajes de confianza. */
export const findingSchema = z.strictObject({
  id: text(80),
  ruleId: text(80),
  evidenceIds: z.array(text(160)).max(20),
  params: z.record(z.string().max(40), z.union([z.string().max(120), z.number()]).nullable()),
});

const findings = z.array(findingSchema).max(12);

/**
 * complete: recomendación sin vacíos. conditional: recomendación con todos los datos de la persona,
 * pero que solo se sostiene si se cumple una condición declarada (riego suplementario con agua
 * limitada). incomplete: falta algo que la persona puede aportar.
 */
export const PLAN_COMPLETENESS = ['complete', 'conditional', 'incomplete'] as const;
/** crop: secuencia de cultivos del catálogo. fallow: descanso con abono verde, sin cultivo comercial. */
export const PLAN_KINDS = ['crop', 'fallow'] as const;

export const planSchema = z
  .strictObject({
    role: z.enum(['A', 'B']),
    completeness: z.enum(PLAN_COMPLETENESS),
    kind: z.enum(PLAN_KINDS).default('crop'),
    scenario: scenarioSchema,
    /** Secuencia posterior al cultivo indicado, con IDs canónicos del catálogo. */
    cropIds: z.array(text(60)).max(4),
    reasons: findings,
    restrictions: findings,
    actions: findings,
    reconsiderSignals: findings,
    toVerify: findings,
  })
  .refine(
    (p) => p.completeness === 'incomplete' || ((p.kind === 'fallow' || p.cropIds.length > 0) && p.reasons.length > 0),
    'Plan completo o condicionado sin secuencia o sin razones',
  )
  .refine(
    (p) => p.kind !== 'fallow' || (p.completeness === 'complete' && p.cropIds.length === 0),
    'El descanso es un plan completo y sin cultivos',
  )
  .refine(
    (p) => p.completeness !== 'incomplete' || p.toVerify.length > 0,
    'Plan incompleto sin indicar qué verificar',
  );

export const RESULT_STATES = ['ok', 'partial', 'insufficient_evidence'] as const;

export const analysisResultSchema = z
  .strictObject({
    contractVersion: z.literal(CONTRACT_VERSION),
    status: z.enum(RESULT_STATES),
    engineVersion: text(40),
    generatedAt: utcInstantSchema,
    planA: planSchema.nullable(),
    planB: planSchema.nullable(),
    /** Qué falta y qué verificar cuando no hay sustento. */
    missing: findings,
    climate: climateEvidenceSchema,
  })
  .refine((r) => (r.planA?.role ?? 'A') === 'A' && (r.planB?.role ?? 'B') === 'B', 'Rol de plan cruzado')
  .refine(
    (r) =>
      r.status !== 'ok' ||
      (!!r.planA && !!r.planB && r.planA.completeness !== 'incomplete' && r.planB.completeness !== 'incomplete'),
    "'ok' exige Plan A y Plan B completos o condicionados",
  )
  .refine(
    (r) =>
      r.status !== 'insufficient_evidence' ||
      (r.planA === null && r.planB === null && r.missing.length > 0),
    "'insufficient_evidence' no lleva planes y explica qué falta",
  )
  .refine(
    (r) => r.status !== 'partial' || r.planA !== null || r.planB !== null,
    "'partial' exige al menos un plan",
  );

/** Alerta vigente derivada de evidencia reciente. El texto visible sale de plantillas por `id`. */
export const alertSchema = z.strictObject({
  id: z.literal('fire_hotspot_nearby'),
  evidenceId: text(160),
  /** Detecciones de las últimas 24 h cerca de la celda. */
  count: z.int().min(1),
  nearestKm: z.number().min(0),
  latestAt: utcInstantSchema,
});

/** Respuesta de `POST /api/analyze`. El resultado es lo que el navegador guarda. */
export const analyzeResponseSchema = z.strictObject({
  result: analysisResultSchema,
  alerts: z.array(alertSchema).max(5),
  /** Contexto firmado y de corta duración para `/api/explain`. `null` si no está disponible. */
  explain: z.string().max(12_000).nullable(),
});

export const rateLimitedSchema = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION),
  status: z.literal('rate_limited'),
  retryAfterSeconds: z.int().min(1),
});

export const inputErrorSchema = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION),
  status: z.literal('invalid_input'),
  /** Ruta y código por campo. No repite el valor recibido. */
  issues: z.array(z.strictObject({ path: z.string().max(120), code: text(60) })).min(1).max(20),
});

/** Valida la entrada y devuelve el error de contrato sin eco de valores. */
export function parseFarmInput(
  payload: unknown,
): { ok: true; value: z.infer<typeof farmInputSchema> } | { ok: false; error: z.infer<typeof inputErrorSchema> } {
  const parsed = farmInputSchema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      contractVersion: CONTRACT_VERSION,
      status: 'invalid_input',
      issues: parsed.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.').slice(0, 120), code: i.code })),
    },
  };
}
