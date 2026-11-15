import type { ClimateQuery, EvidenceRecord, Source } from '../../domain/contracts.ts';
import { evidenceRecordSchema } from '../../domain/schemas.ts';
import chiclayo from '../../data/nasa/chiclayo.json' with { type: 'json' };
import india from '../../data/nasa/india.json' with { type: 'json' };
import kenia from '../../data/nasa/kenia.json' with { type: 'json' };
import { cellIds } from './grid.ts';
import { fetchPower } from './power.ts';

// Respaldo local: instantáneas REALES de los tres casos de demostración. Se aceptan solo si
// coinciden la celda del producto y la ventana exacta; si no, se descartan.

export interface Snapshot {
  records: unknown[];
}

export const SNAPSHOTS: Snapshot[] = [chiclayo, india, kenia];

export const SNAPSHOT_ATTRIBUTION =
  'Datos obtenidos del proyecto NASA POWER (NASA Langley Research Center), financiado por el programa Earth Science / Applied Science de NASA. https://power.larc.nasa.gov/';

/** Registros del respaldo para esta fuente, celda y ventana. Vacío si nada coincide. */
export function matchSnapshot(snapshots: Snapshot[], source: Source, q: ClimateQuery): EvidenceRecord[] {
  const cells = cellIds(source, q.lat, q.lon);
  return snapshots
    .flatMap((s) => s.records)
    .flatMap((r) => {
      const parsed = evidenceRecordSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    })
    .filter(
      (r) =>
        r.source === source &&
        r.cache.origin === 'local_snapshot' &&
        cells.includes(r.grid.cellId) &&
        r.period.start === q.window.start &&
        r.period.end === q.window.end,
    );
}

export const DEMO_WINDOW = { start: '2025-01-01', end: '2025-12-31' } as const;
export const DEMO_CASES = [
  { file: 'chiclayo', name: 'Chiclayo, Perú', lat: -6.77, lon: -79.84 },
  { file: 'india', name: 'India (Bengaluru)', lat: 12.97, lon: 77.59 },
  { file: 'kenia', name: 'Kenia (Nairobi)', lat: -1.29, lon: 36.82 },
] as const;

/**
 * Regenera src/data/nasa/*.json con respuestas reales de POWER. Comando:
 *   node --env-file=.env --input-type=module -e "import('./src/services/nasa/fallback.ts').then(m => m.writeSnapshots())"
 * SMAP, Giovanni y FIRMS no se incluyen: SMAP y Giovanni dependen de la ingesta (ver `omitted`)
 * y FIRMS es información de tiempo casi real que no tiene sentido guardar.
 */
export async function writeSnapshots(dir = 'src/data/nasa', now = new Date()): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  for (const c of DEMO_CASES) {
    const { records } = await fetchPower({ lat: c.lat, lon: c.lon, window: DEMO_WINDOW }, { now });
    const snapshot = {
      meta: {
        name: c.name,
        generatedAt: now.toISOString(),
        command: 'node --env-file=.env --input-type=module -e "import(\'./src/services/nasa/fallback.ts\').then(m => m.writeSnapshots())"',
        attribution: SNAPSHOT_ATTRIBUTION,
        window: DEMO_WINDOW,
        omitted: [
          { source: 'smap', reason: 'Requiere la ingesta AppEEARS (scripts/ingest-smap.ts); sin datos reales verificados.' },
          { source: 'giovanni', reason: 'Requiere la ingesta Giovanni (scripts/ingest-giovanni.ts); sin datos reales verificados.' },
          { source: 'firms', reason: 'Información de tiempo casi real: nunca se guarda como respaldo.' },
        ],
      },
      records: records.map((r) => ({ ...r, cache: { origin: 'local_snapshot', expiresAt: null } })),
    };
    // metadatos legibles y un registro por línea
    const body = snapshot.records.map((r) => JSON.stringify(r)).join(',\n');
    await writeFile(
      `${dir}/${c.file}.json`,
      `{\n"meta": ${JSON.stringify(snapshot.meta, null, 1)},\n"records": [\n${body}\n]\n}\n`,
    );
  }
}
