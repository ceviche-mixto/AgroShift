import type {
  ClimateEvidence,
  ClimateQuery,
  EvidenceRecord,
  LocalDate,
  SourceState,
  SourceStatus,
} from '../../domain/contracts.ts';
import { climateEvidenceSchema } from '../../domain/schemas.ts';
import {
  acquireClimateRefresh,
  publishClimateRefresh,
  readClimate,
  releaseClimateRefresh,
  type ClimateKey,
} from '../supabase/cache.ts';
import { matchSnapshot, SNAPSHOTS, type Snapshot } from './fallback.ts';
import { FIRMS_TTL_MS, FIRMS_USABLE_MS, fetchFirms, firmsKey } from './firms.ts';
import { addDays, dateOf, daysInMonth } from './grid.ts';
import {
  GIOVANNI_MAX_OBSERVATION_AGE_DAYS,
  GIOVANNI_TTL_MS,
  GIOVANNI_USABLE_MS,
  giovanniKey,
} from './giovanni.ts';
import {
  POWER_MAX_OBSERVATION_AGE_DAYS,
  POWER_TTL_MS,
  POWER_USABLE_MS,
  fetchPower,
  powerKey,
} from './power.ts';
import { SMAP_MAX_OBSERVATION_AGE_DAYS, SMAP_TTL_MS, SMAP_USABLE_MS, smapKey } from './smap.ts';

// Orquestador de servidor. Por fuente: caché vigente -> refresco en vivo bajo concesión ->
// instantánea previa con edad -> JSON local de la misma celda y ventana -> cobertura insuficiente.
// Las fuentes corren en paralelo y una lenta o caída no bloquea a las demás.

/** Plazo para leer y refrescar fuentes; el resto del tiempo de la solicitud queda para armar la respuesta. */
export const SOURCES_DEADLINE_MS = 6_000;
const LEASE_SECONDS = 15;

export interface LiveResult {
  records: EvidenceRecord[];
  observedUntil: LocalDate | null;
}

export interface LiveContext {
  signal: AbortSignal;
  deadlineAt: number;
  now: Date;
  fetch?: typeof fetch;
  random?: () => number;
}

export interface Provider {
  source: ClimateKey['source'];
  key(q: ClimateQuery, now: Date): ClimateKey;
  /** Vigencia desde la recuperación. */
  ttlMs: number;
  /** Uso máximo como instantánea previa tras la vigencia. */
  usableMs: number;
  /** Máxima antigüedad de la última observación para una evaluación actual. `null` = no aplica. */
  maxObservationAgeDays: number | null;
  /** Ausente = la ruta web solo lee lo que dejó la ingesta. */
  live?(q: ClimateQuery, ctx: LiveContext): Promise<LiveResult>;
}

/** Parámetros por fuente. SMAP y Giovanni no consultan en vivo: los llena la ingesta. */
export const PROVIDERS: Provider[] = [
  {
    source: 'power',
    key: powerKey,
    ttlMs: POWER_TTL_MS,
    usableMs: POWER_USABLE_MS,
    maxObservationAgeDays: POWER_MAX_OBSERVATION_AGE_DAYS,
    live: (q, ctx) => fetchPower(q, ctx),
  },
  { source: 'smap', key: smapKey, ttlMs: SMAP_TTL_MS, usableMs: SMAP_USABLE_MS, maxObservationAgeDays: SMAP_MAX_OBSERVATION_AGE_DAYS },
  {
    source: 'giovanni',
    key: giovanniKey,
    ttlMs: GIOVANNI_TTL_MS,
    usableMs: GIOVANNI_USABLE_MS,
    maxObservationAgeDays: GIOVANNI_MAX_OBSERVATION_AGE_DAYS,
  },
  {
    source: 'firms',
    key: firmsKey,
    ttlMs: FIRMS_TTL_MS,
    usableMs: FIRMS_USABLE_MS,
    maxObservationAgeDays: null,
    live: (q, ctx) => fetchFirms(q, ctx),
  },
];

export interface Cache {
  read: typeof readClimate;
  acquire: typeof acquireClimateRefresh;
  publish: typeof publishClimateRefresh;
  release: typeof releaseClimateRefresh;
}
const SUPABASE_CACHE: Cache = {
  read: readClimate,
  acquire: acquireClimateRefresh,
  publish: publishClimateRefresh,
  release: releaseClimateRefresh,
};

export interface ClimateOptions {
  now?: () => Date;
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Sustituye o añade proveedores por fuente (p. ej. un complemento verificado). */
  providers?: Provider[];
  cache?: Cache;
  snapshots?: Snapshot[];
  fetch?: typeof fetch;
  random?: () => number;
}

interface Outcome {
  status: SourceStatus;
  records: EvidenceRecord[];
}

/** Rechaza cuando vence el plazo, aunque la promesa original no responda. */
function within<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('plazo_agotado'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const reason = (e: unknown) =>
  e instanceof Error ? (e.name === 'ZodError' ? 'respuesta_invalida' : e.message.slice(0, 120) || 'error') : 'error';

const relabel = (records: EvidenceRecord[], origin: EvidenceRecord['cache']['origin'], expiresAt: string | null) =>
  // Postgres devuelve timestamptz con +00:00; el contrato exige sufijo Z
  records.map((r) => ({ ...r, cache: { origin, expiresAt: expiresAt && new Date(expiresAt).toISOString() } }));

/** Fecha de la última observación válida de las series del registro. */
function lastObservation(records: EvidenceRecord[]): LocalDate | null {
  const dates = records.flatMap((r) =>
    r.data.type === 'series'
      ? r.data.points.filter((p) => p.v !== null).map((p) => (p.t.length === 7 ? addDays(`${p.t}-01`, daysInMonth(p.t) - 1) : p.t))
      : [],
  );
  return dates.sort().at(-1) ?? null;
}

function classify(p: Provider, records: EvidenceRecord[], q: ClimateQuery, now: Date): { state: SourceState; detail: string | null } {
  const origin = records[0]?.cache.origin;
  if (origin === 'stale_snapshot') return { state: 'stale', detail: 'instantanea_previa' };
  if (origin === 'local_snapshot') return { state: 'stale', detail: 'respaldo_local' };
  const statuses = records.map((r) => r.coverage.status);
  if (statuses.every((s) => s === 'none')) {
    return p.source === 'firms' ? { state: 'stale', detail: 'datos_vencidos' } : { state: 'insufficient_coverage', detail: 'sin_datos_validos' };
  }
  if (p.source === 'firms' && statuses.some((s) => s !== 'complete')) return { state: 'stale', detail: 'datos_vencidos' };
  if (p.maxObservationAgeDays !== null) {
    const limit = addDays(dateOf(now), -p.maxObservationAgeDays);
    const last = lastObservation(records);
    // Solo importa si la ventana pide el presente
    if (last && last < limit && q.window.end >= limit) return { state: 'stale', detail: 'observacion_antigua' };
  }
  return statuses.some((s) => s !== 'complete') ? { state: 'partial', detail: 'cobertura_parcial' } : { state: 'available', detail: null };
}

function present(p: Provider, records: EvidenceRecord[], q: ClimateQuery, now: Date): Outcome {
  const newest = Math.max(...records.map((r) => Date.parse(r.retrievedAt)));
  const { state, detail } = classify(p, records, q, now);
  return {
    records,
    status: { source: p.source, state, ageSeconds: Math.max(0, Math.floor((now.getTime() - newest) / 1000)), detail },
  };
}

const none = (p: Provider, state: SourceState, detail: string): Outcome => ({
  records: [],
  status: { source: p.source, state, ageSeconds: null, detail },
});

async function runSource(p: Provider, q: ClimateQuery, now: Date, signal: AbortSignal, deadlineAt: number, o: ClimateOptions): Promise<Outcome> {
  const cache = o.cache ?? SUPABASE_CACHE;
  const key = p.key(q, now);
  let cached: Awaited<ReturnType<Cache['read']>> = null;
  let cacheUp = true;
  try {
    cached = await within(cache.read(key, now), signal);
  } catch {
    cacheUp = false; // Supabase caído o lento: se sigue sin caché
  }
  if (cached?.records.length === 0) cached = null;
  if (cached?.fresh) return present(p, relabel(cached.records, 'shared_cache', cached.expiresAt), q, now);

  let failure: string | null = null;
  if (p.live) {
    let lease: Awaited<ReturnType<Cache['acquire']>> | undefined;
    try {
      lease = cacheUp ? await within(cache.acquire(key, LEASE_SECONDS), signal) : undefined;
    } catch {
      lease = undefined;
    }
    if (lease !== null) {
      // null = otra instancia refresca: se sirve lo previo
      try {
        const live = await within(p.live(q, { signal, deadlineAt, now, fetch: o.fetch, random: o.random }), signal);
        if (lease && live.records.length > 0) {
          await within(
            cache.publish(lease, {
              records: live.records,
              observedUntil: live.observedUntil,
              retrievedAt: now.toISOString(),
              expiresAt: new Date(now.getTime() + p.ttlMs).toISOString(),
              usableUntil: new Date(now.getTime() + p.ttlMs + p.usableMs).toISOString(),
            }),
            signal,
          ).catch(() => false); // publicar es un extra: el dato ya está en mano
        } else if (lease) {
          cache.release(lease).catch(() => false);
        }
        return live.records.length > 0 ? present(p, live.records, q, now) : none(p, 'insufficient_coverage', 'sin_datos_validos');
      } catch (e) {
        failure = reason(e);
        if (lease) cache.release(lease).catch(() => false);
      }
    } else {
      failure = 'refresco_en_curso';
    }
  }
  if (cached) return present(p, relabel(cached.records, 'stale_snapshot', cached.expiresAt), q, now);
  const local = matchSnapshot(o.snapshots ?? SNAPSHOTS, p.source, q);
  if (local.length > 0) return present(p, local, q, now);
  return failure ? none(p, 'unavailable', failure) : none(p, 'insufficient_coverage', 'sin_datos_para_celda_y_ventana');
}

/** Arma la evidencia climática de una consulta. Nunca lanza por una fuente caída. */
export async function getClimateEvidence(q: ClimateQuery, o: ClimateOptions = {}): Promise<ClimateEvidence> {
  const now = o.now ? o.now() : new Date();
  const providers = [...PROVIDERS.filter((p) => !o.providers?.some((x) => x.source === p.source)), ...(o.providers ?? [])];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.deadlineMs ?? SOURCES_DEADLINE_MS);
  o.signal?.addEventListener('abort', () => ac.abort(), { once: true });
  const deadlineAt = Date.now() + (o.deadlineMs ?? SOURCES_DEADLINE_MS);
  let settled: PromiseSettledResult<Outcome>[];
  try {
    settled = await Promise.allSettled(providers.map((p) => runSource(p, q, now, ac.signal, deadlineAt, o)));
  } finally {
    clearTimeout(timer);
  }
  const outcomes = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : none(providers[i]!, 'unavailable', 'error_interno')));
  return climateEvidenceSchema.parse({
    query: q,
    assembledAt: now.toISOString(),
    sources: outcomes.map((x) => x.status),
    records: outcomes.flatMap((x) => x.records),
  });
}

/** Para la ingesta: publica registros ya normalizados bajo una concesión forzada. `false` = no se escribió. */
export async function storeRecords(
  key: ClimateKey,
  records: EvidenceRecord[],
  observedUntil: LocalDate | null,
  ttlMs: number,
  usableMs: number,
  now = new Date(),
): Promise<boolean> {
  const lease = await acquireClimateRefresh(key, 60, true);
  if (!lease) return false;
  return publishClimateRefresh(lease, {
    records,
    observedUntil,
    retrievedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    usableUntil: new Date(now.getTime() + ttlMs + usableMs).toISOString(),
  });
}
