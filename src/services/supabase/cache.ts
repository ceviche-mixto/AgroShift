import { z } from 'zod';
import type { EvidenceRecord, LocalDate, Source } from '../../domain/contracts.ts';
import { evidenceRecordSchema } from '../../domain/schemas.ts';
import type { Json } from './database.types.ts';
import { getServerSupabase } from './server.ts';

// Caché compartida de evidencia científica. Solo servidor. Sin datos de la parcela:
// la clave usa la celda del producto, nunca la coordenada exacta.
// Las funciones lanzan si Supabase falla; quien llama aplica el respaldo.
// `crop_cache` se conecta en la tarea 2.11, cuando exista el resultado del motor.

export interface ClimateKey {
  source: Source;
  productVersion: string;
  schemaVersion: number;
  cellId: string;
  windowStart: LocalDate;
  windowEnd: LocalDate;
}

export interface CachedClimate {
  records: EvidenceRecord[];
  retrievedAt: string;
  expiresAt: string;
  /** false = instantánea previa: mostrar con su edad explícita. */
  fresh: boolean;
  ageSeconds: number;
}

export interface ClimateEntry {
  records: EvidenceRecord[];
  /** Última fecha con observación válida. `null` si el periodo no tiene ninguna. */
  observedUntil: LocalDate | null;
  retrievedAt: string;
  expiresAt: string;
  /** Último uso permitido como instantánea previa. */
  usableUntil: string;
}

export interface RefreshLease {
  id: number;
  holder: string;
}

const recordsSchema = z.array(evidenceRecordSchema);

function fail(operation: string, error: { code?: string; message: string }): never {
  throw new Error(`Supabase ${operation}: ${error.code ?? error.message}`);
}

/** Dato vigente o instantánea previa dentro del uso permitido. `null` = sin dato utilizable. */
export async function readClimate(key: ClimateKey, now = new Date()): Promise<CachedClimate | null> {
  const { data, error } = await getServerSupabase()
    .from('climate_cache')
    .select('payload, retrieved_at, expires_at, usable_until')
    .match({
      source: key.source,
      product_version: key.productVersion,
      schema_version: key.schemaVersion,
      cell_id: key.cellId,
      window_start: key.windowStart,
      window_end: key.windowEnd,
    })
    .maybeSingle();
  if (error) fail('readClimate', error);
  if (!data?.payload || !data.retrieved_at || !data.expires_at || !data.usable_until) return null;
  if (now.getTime() >= Date.parse(data.usable_until)) return null;
  const records = recordsSchema.safeParse(data.payload);
  if (!records.success) return null;
  return {
    records: records.data,
    retrievedAt: data.retrieved_at,
    expiresAt: data.expires_at,
    fresh: now.getTime() < Date.parse(data.expires_at),
    ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(data.retrieved_at)) / 1000)),
  };
}

/**
 * Concesión temporal de refresco, atómica entre instancias. `null` = otra instancia la tiene
 * o el dato sigue vigente y no se fuerza: en ambos casos se sirve lo que ya hay.
 */
export async function acquireClimateRefresh(
  key: ClimateKey,
  leaseSeconds: number,
  force = false,
): Promise<RefreshLease | null> {
  const holder = crypto.randomUUID();
  const { data, error } = await getServerSupabase().rpc('acquire_climate_refresh', {
    p_source: key.source,
    p_product_version: key.productVersion,
    p_schema_version: key.schemaVersion,
    p_cell_id: key.cellId,
    p_window_start: key.windowStart,
    p_window_end: key.windowEnd,
    p_holder: holder,
    p_lease_seconds: leaseSeconds,
    p_force: force,
  });
  if (error) fail('acquireClimateRefresh', error);
  return data === null ? null : { id: data, holder };
}

/**
 * Publica y libera. `false` = la concesión venció o es de otro titular y no se escribió.
 * Un dato con observación más antigua que la guardada libera sin reemplazarla.
 */
export async function publishClimateRefresh(lease: RefreshLease, entry: ClimateEntry): Promise<boolean> {
  const { data, error } = await getServerSupabase().rpc('publish_climate_refresh', {
    p_id: lease.id,
    p_holder: lease.holder,
    p_payload: recordsSchema.parse(entry.records) as Json,
    // El tipo generado no admite null, pero la función SQL sí.
    p_observed_until: entry.observedUntil as string,
    p_retrieved_at: entry.retrievedAt,
    p_expires_at: entry.expiresAt,
    p_usable_until: entry.usableUntil,
  });
  if (error) fail('publishClimateRefresh', error);
  return data;
}

/** Libera sin publicar, por ejemplo cuando el proveedor falla. */
export async function releaseClimateRefresh(lease: RefreshLease): Promise<boolean> {
  const { data, error } = await getServerSupabase().rpc('release_climate_refresh', {
    p_id: lease.id,
    p_holder: lease.holder,
  });
  if (error) fail('releaseClimateRefresh', error);
  return data;
}

/** Cuenta una unidad del presupuesto compartido. `false` = cupo agotado en el intervalo. */
export async function consumeBudget(operation: string, intervalSeconds: number, limit: number): Promise<boolean> {
  const { data, error } = await getServerSupabase().rpc('consume_request_budget', {
    p_operation: operation,
    p_interval_seconds: intervalSeconds,
    p_limit: limit,
  });
  if (error) fail('consumeBudget', error);
  return data;
}

/** Borra filas fuera de su último uso permitido. Lo invocan los scripts de ingesta. */
export async function purgeExpired(): Promise<void> {
  const { error } = await getServerSupabase().rpc('purge_agroshift_cache');
  if (error) fail('purgeExpired', error);
}
