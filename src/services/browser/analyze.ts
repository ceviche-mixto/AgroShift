import type { AnalyzeResponse, FarmInput, InputError } from '../../domain/contracts.ts';
import { analyzeResponseSchema, inputErrorSchema, parseFarmInput, rateLimitedSchema } from '../../domain/schemas.ts';
import type { Snapshot } from '../nasa/match.ts';
import { computeLocal, loadLocalSnapshots as defaultLoadLocal } from './local.ts';
import { browserStorage, farmKey, type FarmStorage, type StoredPlan } from './storage.ts';

// Cliente de análisis: caché local primero, red con plazo de 8 s, y sin red un plan guardado o
// cómputo local. Un solo vuelo: cada llamada cancela la anterior y una respuesta tardía de una
// entrada superada nunca se presenta ni se guarda. Nunca lanza.

export const CLIENT_TIMEOUT_MS = 8_000;
/** Un dato local es fresco 24 h; después es `stale` pero se puede usar. */
export const FRESH_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_SECONDS = 60;

export type Origin = 'network' | 'cache' | 'saved' | 'local';

export interface AnalyzeSuccess {
  kind: 'result';
  origin: Origin;
  /** Instante UTC en que se obtuvo o calculó la respuesta. */
  savedAt: string;
  /** Pasaron más de 24 h desde `savedAt`. */
  stale: boolean;
  response: AnalyzeResponse;
}

export type AnalyzeOutcome =
  | AnalyzeSuccess
  | { kind: 'invalid'; issues: InputError['issues'] }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  /** Sin red y sin plan guardado ni cobertura científica local para esta parcela. */
  | { kind: 'offline_no_data' }
  /** Otra solicitud más reciente tomó el relevo: no presentar nada. */
  | { kind: 'superseded' };

export interface AnalyzeOptions {
  /** Recibe de inmediato lo que haya en la caché local para esta entrada (con edad y vigencia). */
  onCached?: (cached: AnalyzeSuccess) => void;
  fetch?: typeof fetch;
  now?: () => Date;
  storage?: FarmStorage;
  loadLocalSnapshots?: () => Promise<Snapshot[]>;
  timeoutMs?: number;
  endpoint?: string;
}

// Un solo vuelo por página.
let sequence = 0;
let inflight: AbortController | undefined;

const isStale = (savedAt: string, now: Date) => now.getTime() - Date.parse(savedAt) > FRESH_MS;

export async function analyzeFarm(input: FarmInput, opts: AnalyzeOptions = {}): Promise<AnalyzeOutcome> {
  const id = ++sequence;
  inflight?.abort();
  const ac = (inflight = new AbortController());
  const superseded = () => id !== sequence;
  const now = opts.now ?? (() => new Date());
  const parsed = parseFarmInput(input);
  if (!parsed.ok) return { kind: 'invalid', issues: parsed.error.issues };
  const farm = parsed.value;

  const storage = opts.storage ?? browserStorage();
  const fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? CLIENT_TIMEOUT_MS;
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const present = (origin: Origin, p: { savedAt: string; response: AnalyzeResponse }): AnalyzeSuccess => ({
    kind: 'result',
    origin,
    savedAt: p.savedAt,
    stale: isStale(p.savedAt, now()),
    response: p.response,
  });

  try {
    // La red sale ya; la lectura local corre en paralelo para mostrar algo de inmediato.
    const request = network(farm, fetchFn, ac.signal, opts.endpoint ?? '/api/analyze');
    const stored = await findStored(storage, farm);
    if (superseded()) return { kind: 'superseded' };
    const cached = stored && present(stored.origin, stored.plan);
    if (cached) opts.onCached?.(cached);

    const net = await request;
    if (superseded()) return { kind: 'superseded' };
    if (net.kind === 'ok') {
      const savedAt = now().toISOString();
      // Solo la última entrada escribe: nada de otra parcela pisa la caché
      await storage.putSnapshot(farm, net.response, savedAt);
      await storage.saveLast(farm, net.response, savedAt);
      if (superseded()) return { kind: 'superseded' };
      return present('network', { savedAt, response: net.response });
    }
    if (net.kind === 'invalid') return net.outcome;
    if (net.kind === 'rate_limited') return net.outcome;

    // Red caída, plazo vencido, 5xx o respuesta inválida: plan compatible guardado, o cómputo local.
    if (cached) return cached;
    const when = now();
    const loaded = await (opts.loadLocalSnapshots ?? (() => defaultLoadLocal(fetchFn)))().catch(() => [] as Snapshot[]);
    if (superseded()) return { kind: 'superseded' };
    const response = computeLocal(farm, loaded, when);
    return response ? present('local', { savedAt: when.toISOString(), response }) : { kind: 'offline_no_data' };
  } finally {
    clearTimeout(timer);
    if (inflight === ac) inflight = undefined;
  }
}

/** Plan almacenado compatible con esta entrada exacta: instantánea, luego plan guardado, luego último. */
async function findStored(
  storage: FarmStorage,
  input: FarmInput,
): Promise<{ origin: Origin; plan: StoredPlan } | null> {
  const key = farmKey(input);
  try {
    const snap = await storage.getSnapshot(input);
    if (snap) return { origin: 'cache', plan: snap };
    const saved = (await storage.listSaved()).find((p) => p.planKey === key);
    if (saved) return { origin: 'saved', plan: saved };
    const last = await storage.loadLast();
    if (last?.planKey === key) return { origin: 'cache', plan: last };
  } catch {
    // el almacenamiento no debe romper el análisis
  }
  return null;
}

type NetworkResult =
  | { kind: 'ok'; response: AnalyzeResponse }
  | { kind: 'invalid'; outcome: Extract<AnalyzeOutcome, { kind: 'invalid' }> }
  | { kind: 'rate_limited'; outcome: Extract<AnalyzeOutcome, { kind: 'rate_limited' }> }
  | { kind: 'failed' };

async function network(input: FarmInput, fetchFn: typeof fetch, signal: AbortSignal, endpoint: string): Promise<NetworkResult> {
  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
      cache: 'no-store',
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 200) {
      const ok = analyzeResponseSchema.safeParse(body);
      return ok.success ? { kind: 'ok', response: ok.data } : { kind: 'failed' };
    }
    if (res.status === 400) {
      const bad = inputErrorSchema.safeParse(body);
      return bad.success ? { kind: 'invalid', outcome: { kind: 'invalid', issues: bad.data.issues } } : { kind: 'failed' };
    }
    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const limited = rateLimitedSchema.safeParse(body);
      const retryAfterSeconds =
        Number.isInteger(header) && header >= 1 ? header : limited.success ? limited.data.retryAfterSeconds : DEFAULT_RETRY_SECONDS;
      return { kind: 'rate_limited', outcome: { kind: 'rate_limited', retryAfterSeconds } };
    }
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' }; // red caída, plazo vencido o solicitud cancelada
  }
}
