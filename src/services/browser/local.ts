import type { AnalyzeResponse, ClimateEvidence, ClimateQuery, FarmInput, SourceStatus } from '../../domain/contracts.ts';
import { evaluateRotation } from '../../domain/rotation.ts';
import { analyzeResponseSchema, climateEvidenceSchema, CONTRACT_VERSION } from '../../domain/schemas.ts';
import { matchSnapshot, type Snapshot } from '../nasa/match.ts';

// Cómputo sin red: motor puro + JSON científico local. Solo se usan registros de la MISMA celda y
// ventana (matchSnapshot); si nada aplica, no hay resultado. Sin Supabase, NASA ni Bedrock.

/** Archivos que sirve src/pages/data/nasa/[name].json.ts y que precarga public/sw.js. */
export const LOCAL_SNAPSHOT_URLS = ['/data/nasa/chiclayo.json', '/data/nasa/india.json', '/data/nasa/kenia.json'] as const;

const LOCAL_SOURCES = ['power', 'smap', 'giovanni', 'firms'] as const;

/** Igual que `referenceWindow` del servidor (src/services/analysis.ts): el último año calendario completo. */
export function referenceWindow(now: Date): ClimateQuery['window'] {
  const year = now.getUTCFullYear() - 1;
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/** Descarga las instantáneas locales. Una que falle o venga mal formada se omite. */
export async function loadLocalSnapshots(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<Snapshot[]> {
  const loaded = await Promise.all(
    LOCAL_SNAPSHOT_URLS.map(async (url) => {
      try {
        const res = await fetchFn(url);
        if (!res.ok) return [];
        const json = (await res.json()) as Snapshot;
        return Array.isArray(json?.records) ? [json] : [];
      } catch {
        return [];
      }
    }),
  );
  return loaded.flat();
}

/**
 * Plan con la evidencia local aplicable a esta entrada, o `null` si ninguna fuente cubre la celda y
 * la ventana. Sin alertas (FIRMS nunca se guarda) y sin explicación.
 */
export function computeLocal(input: FarmInput, snapshots: Snapshot[], now: Date): AnalyzeResponse | null {
  const query: ClimateQuery = { lat: input.location.lat, lon: input.location.lon, window: referenceWindow(now) };
  const records = LOCAL_SOURCES.map((source) => ({ source, records: matchSnapshot(snapshots, source, query) }));
  if (records.every((r) => r.records.length === 0)) return null;
  const sources: SourceStatus[] = records.map(({ source, records: rs }) => {
    if (rs.length === 0) return { source, state: 'insufficient_coverage', ageSeconds: null, detail: 'sin_datos_para_celda_y_ventana' };
    const newest = Math.max(...rs.map((r) => Date.parse(r.retrievedAt)));
    return { source, state: 'stale', ageSeconds: Math.max(0, Math.floor((now.getTime() - newest) / 1000)), detail: 'respaldo_local' };
  });
  try {
    const climate: ClimateEvidence = climateEvidenceSchema.parse({
      query,
      assembledAt: now.toISOString(),
      sources,
      records: records.flatMap((r) => r.records),
    });
    const result = {
      contractVersion: CONTRACT_VERSION,
      ...evaluateRotation(input, climate),
      generatedAt: now.toISOString(),
      climate,
    };
    return analyzeResponseSchema.parse({ result, alerts: [], explain: null });
  } catch {
    return null; // evidencia local que no cumple el contrato: mejor sin plan que un plan dudoso
  }
}
