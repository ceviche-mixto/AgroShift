import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AnalysisResult } from '../../domain/contracts.ts';
import { findingSchema, RESULT_STATES, scenarioSchema } from '../../domain/schemas.ts';

// Contexto de explicación: hechos ya calculados por el motor, firmados por /api/analyze y
// verificados por /api/explain. Solo IDs y hechos permitidos. Sin ubicación, sin texto libre
// del agricultor y sin evidencia cruda.

export const CONTEXT_TTL_MS = 15 * 60_000;
export const MAX_CONTEXT_CHARS = 12_000;

const fact = findingSchema.omit({ evidenceIds: true });
const facts = z.array(fact).max(12);
const planFacts = z.strictObject({
  completeness: z.enum(['complete', 'incomplete']),
  scenario: scenarioSchema,
  cropIds: z.array(z.string().max(60)).max(4),
  reasons: facts,
  restrictions: facts,
  actions: facts,
  reconsiderSignals: facts,
  toVerify: facts,
});

export const explainFactsSchema = z.strictObject({
  status: z.enum(RESULT_STATES),
  engineVersion: z.string().max(40),
  planA: planFacts.nullable(),
  planB: planFacts.nullable(),
  missing: facts,
});
export type ExplainFacts = z.infer<typeof explainFactsSchema>;

const payloadSchema = z.strictObject({ v: z.literal(1), exp: z.int(), facts: explainFactsSchema });

const strip = (list: AnalysisResult['missing']) => list.map(({ id, ruleId, params }) => ({ id, ruleId, params }));
const planOf = (p: AnalysisResult['planA']) =>
  p && {
    completeness: p.completeness,
    scenario: p.scenario,
    cropIds: p.cropIds,
    reasons: strip(p.reasons),
    restrictions: strip(p.restrictions),
    actions: strip(p.actions),
    reconsiderSignals: strip(p.reconsiderSignals),
    toVerify: strip(p.toVerify),
  };

/** Hechos permitidos del resultado. Descarta la consulta climática y con ella la ubicación. */
export function factsOf(result: AnalysisResult): ExplainFacts {
  return explainFactsSchema.parse({
    status: result.status,
    engineVersion: result.engineVersion,
    planA: planOf(result.planA),
    planB: planOf(result.planB),
    missing: strip(result.missing),
  });
}

const mac = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');

/** Firma los hechos. `null` si el contexto supera el tamaño máximo. */
export function signContext(value: ExplainFacts, secret: string, now: Date): string | null {
  const body = Buffer.from(JSON.stringify({ v: 1, exp: now.getTime() + CONTEXT_TTL_MS, facts: value })).toString('base64url');
  const token = `${body}.${mac(body, secret)}`;
  return token.length <= MAX_CONTEXT_CHARS ? token : null;
}

/** Valida tamaño, firma y caducidad. `null` ante cualquier fallo, sin distinguir el motivo. */
export function verifyContext(token: unknown, secret: string, now: Date): ExplainFacts | null {
  if (typeof token !== 'string' || token.length > MAX_CONTEXT_CHARS) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = payloadSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return payload.exp > now.getTime() ? payload.facts : null;
  } catch {
    return null;
  }
}

/** Versión de los hechos, para reutilizar una explicación por hechos y pregunta. */
export const factsVersion = (value: ExplainFacts) =>
  createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22);
