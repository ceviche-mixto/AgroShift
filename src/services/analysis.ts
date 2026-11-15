import type {
  Alert,
  AnalyzeResponse,
  ClimateEvidence,
  ClimateQuery,
  InputError,
  RateLimited,
} from '../domain/contracts.ts';
import { evaluateRotation } from '../domain/rotation.ts';
import { analyzeResponseSchema, CONTRACT_VERSION, parseFarmInput, SOURCES } from '../domain/schemas.ts';
import { factsOf, signContext } from './bedrock/context.ts';
import { serverEnv } from './env.ts';
import { activeFirmsAlert } from './nasa/firms.ts';
import { getClimateEvidence, SOURCES_DEADLINE_MS } from './nasa/index.ts';
import { consumeBudget } from './supabase/cache.ts';

// Orquesta una solicitud de análisis: valida, reúne evidencia compartida y calcula el plan con
// las respuestas recibidas. Las respuestas de la parcela no se guardan ni se registran.
// `crop_cache` no se usa: el motor es puro y barato, y así nada derivado de una parcela se comparte.

/** Plazo absoluto de servidor. Al vencer se responde con la evidencia disponible. */
export const ANALYZE_DEADLINE_MS = 7_000;
/** Refrescos en vivo por fuente y minuto, compartidos entre instancias. */
export const REFRESH_BUDGET = { intervalSeconds: 60, limit: 30 } as const;

export interface AnalyzeDeps {
  now?: () => Date;
  climate?: typeof getClimateEvidence;
  engine?: typeof evaluateRotation;
  consume?: typeof consumeBudget;
  /** `null` desactiva el contexto de explicación. Por defecto EXPLAIN_CONTEXT_SECRET. */
  secret?: string | null;
  deadlineMs?: number;
}

export type AnalyzeOutcome =
  | { status: 200; body: AnalyzeResponse }
  | { status: 400; body: InputError }
  | { status: 429; body: RateLimited };

/** Evidencia de referencia: el último año calendario completo, que es lo que cubre la ingesta. */
export function referenceWindow(now: Date): ClimateQuery['window'] {
  const year = now.getUTCFullYear() - 1;
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/** Resume series diarias a medias mensuales: el motor usa el detalle, la respuesta viaja liviana. */
export function compactEvidence(evidence: ClimateEvidence): ClimateEvidence {
  return {
    ...evidence,
    records: evidence.records.map((r) => {
      if (r.data.type !== 'series' || r.data.step !== 'day') return r;
      const byMonth = new Map<string, number[]>();
      for (const p of r.data.points) {
        const month = p.t.slice(0, 7);
        const values = byMonth.get(month) ?? [];
        if (p.v !== null) values.push(p.v);
        byMonth.set(month, values);
      }
      return {
        ...r,
        coverage: {
          ...r.coverage,
          quality: [...r.coverage.quality, 'Serie diaria resumida a medias mensuales en la respuesta'].slice(0, 20),
        },
        data: {
          type: 'series' as const,
          step: 'month' as const,
          points: [...byMonth].map(([t, vs]) => ({
            t,
            v: vs.length ? Number((vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(3)) : null,
          })),
        },
      };
    }),
  };
}

function alertsOf(evidence: ClimateEvidence, now: Date): Alert[] {
  return evidence.records.flatMap((r) => {
    const { active, items } = activeFirmsAlert(r, now);
    if (!active) return [];
    return [
      {
        id: 'fire_hotspot_nearby' as const,
        evidenceId: r.id,
        count: items.length,
        nearestKm: Math.min(...items.map((i) => i.distanceKm)),
        latestAt: items.map((i) => i.acquiredAt).sort().at(-1)!,
      },
    ];
  });
}

const unavailable = (query: ClimateQuery, now: Date): ClimateEvidence => ({
  query,
  assembledAt: now.toISOString(),
  sources: SOURCES.filter((s) => s !== 'complement').map((source) => ({
    source,
    state: 'unavailable',
    ageSeconds: null,
    detail: 'plazo_agotado',
  })),
  records: [],
});

export async function analyze(payload: unknown, deps: AnalyzeDeps = {}): Promise<AnalyzeOutcome> {
  const parsed = parseFarmInput(payload);
  if (!parsed.ok) return { status: 400, body: parsed.error };
  const input = parsed.value;
  const now = (deps.now ?? (() => new Date()))();
  const deadlineMs = deps.deadlineMs ?? ANALYZE_DEADLINE_MS;
  const query: ClimateQuery = { lat: input.location.lat, lon: input.location.lon, window: referenceWindow(now) };
  const consume = deps.consume ?? consumeBudget;
  let exhausted = false;

  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cutoff = new Promise<ClimateEvidence>((resolve) => {
    timer = setTimeout(() => {
      ac.abort(); // corta el trabajo pendiente de las fuentes
      resolve(unavailable(query, now));
    }, deadlineMs - 500);
  });
  const climate = await Promise.race([
    (deps.climate ?? getClimateEvidence)(query, {
      now: () => now,
      signal: ac.signal,
      deadlineMs: Math.min(SOURCES_DEADLINE_MS, deadlineMs - 1_000),
      // Un miss caro gasta presupuesto compartido. Si Supabase no responde no se abre una
      // ráfaga de llamadas: la fuente pasa a instantánea previa o respaldo local.
      beforeLive: async (source) => {
        const ok = await consume(`refresh:${source}`, REFRESH_BUDGET.intervalSeconds, REFRESH_BUDGET.limit);
        if (!ok) exhausted = true;
        return ok;
      },
    }).catch(() => unavailable(query, now)),
    cutoff,
  ]).finally(() => clearTimeout(timer));

  const engine = (deps.engine ?? evaluateRotation)(input, climate);
  if (exhausted && engine.status === 'insufficient_evidence') {
    const retryAfterSeconds = REFRESH_BUDGET.intervalSeconds - (Math.floor(now.getTime() / 1000) % REFRESH_BUDGET.intervalSeconds);
    return { status: 429, body: { contractVersion: CONTRACT_VERSION, status: 'rate_limited', retryAfterSeconds } };
  }

  const result = {
    contractVersion: CONTRACT_VERSION,
    ...engine,
    generatedAt: now.toISOString(),
    climate: compactEvidence(climate),
  };
  const draft = analyzeResponseSchema.parse({ result, alerts: alertsOf(climate, now), explain: null });
  const secret = deps.secret === undefined ? serverEnv('EXPLAIN_CONTEXT_SECRET') : deps.secret;
  return {
    status: 200,
    body: { ...draft, explain: secret ? signContext(factsOf(draft.result), secret, now) : null },
  };
}
