import type { ClimateQuery, EvidenceRecord, Source } from '../../domain/contracts.ts';
import { evidenceRecordSchema } from '../../domain/schemas.ts';
import { cellIds } from './grid.ts';

// Coincidencia pura de instantáneas locales (sin Supabase ni red): sirve al servidor y al navegador.
// Se aceptan solo si coinciden la celda del producto y la ventana exacta; si no, se descartan.

export interface Snapshot {
  /** Ventana de la consulta que generó la instantánea. Sin ella vale el periodo de cada registro. */
  meta?: { window?: { start: string; end: string } };
  records: unknown[];
}

/** Registros del respaldo para esta fuente, celda y ventana. Vacío si nada coincide. */
export function matchSnapshot(snapshots: Snapshot[], source: Source, q: ClimateQuery): EvidenceRecord[] {
  const cells = cellIds(source, q.lat, q.lon);
  return snapshots.flatMap((s) =>
    s.records
      .flatMap((r) => {
        const parsed = evidenceRecordSchema.safeParse(r);
        return parsed.success ? [parsed.data] : [];
      })
      .filter((r) => {
        // Un estadístico (anomalía de un mes) tiene periodo propio: manda la ventana de la instantánea
        const window = s.meta?.window ?? r.period;
        return (
          r.source === source &&
          r.cache.origin === 'local_snapshot' &&
          cells.includes(r.grid.cellId) &&
          window.start === q.window.start &&
          window.end === q.window.end &&
          r.period.start >= q.window.start &&
          r.period.end <= q.window.end
        );
      }),
  );
}
