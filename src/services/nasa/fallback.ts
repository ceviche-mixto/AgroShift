import chiclayo from '../../data/nasa/chiclayo.json' with { type: 'json' };
import india from '../../data/nasa/india.json' with { type: 'json' };
import kenia from '../../data/nasa/kenia.json' with { type: 'json' };
import { readClimate } from '../supabase/cache.ts';
import { giovanniKey } from './giovanni.ts';
import { matchSnapshot, type Snapshot } from './match.ts';
import { fetchPower } from './power.ts';
import { smapKey } from './smap.ts';

// Respaldo local: instantáneas REALES de los tres casos de demostración. Se aceptan solo si
// coinciden la celda del producto y la ventana exacta; si no, se descartan.

// Puro y sin Supabase: vive en match.ts para que el navegador lo use. Se reexporta para el servidor.
export { matchSnapshot, type Snapshot };

export const SNAPSHOTS: Snapshot[] = [chiclayo, india, kenia];

export const SNAPSHOT_ATTRIBUTION = [
  'Datos obtenidos del proyecto NASA POWER (NASA Langley Research Center), financiado por el programa Earth Science / Applied Science de NASA. https://power.larc.nasa.gov/',
  'SMAP L4 Global 3-hourly 9 km Surface and Root Zone Soil Moisture (SPL4SMGP v008), NASA NSIDC DAAC, vía AppEEARS. https://doi.org/10.5067/T5RUATAQREF8',
  'GLDAS Noah Land Surface Model L4 3 hourly 0.25 x 0.25 degree V2.1, NASA GES DISC, vía Giovanni in Cloud. https://doi.org/10.5067/E7TYRXPJKWOQ',
];

export const DEMO_WINDOW = { start: '2025-01-01', end: '2025-12-31' } as const;
export const DEMO_CASES = [
  { file: 'chiclayo', name: 'Chiclayo, Perú', lat: -6.77, lon: -79.84 },
  { file: 'india', name: 'India (Bengaluru)', lat: 12.97, lon: 77.59 },
  { file: 'kenia', name: 'Kenia (Nairobi)', lat: -1.29, lon: 36.82 },
] as const;

/**
 * Regenera src/data/nasa/*.json con respuestas reales: POWER en vivo, y SMAP y Giovanni tal como
 * los dejó la ingesta en Supabase (correr antes scripts/ingest-smap.ts y scripts/ingest-giovanni.ts). Comando:
 *   node --env-file=.env --input-type=module -e "import('./src/services/nasa/fallback.ts').then(m => m.writeSnapshots())"
 * Una fuente sin ingesta vigente queda en `omitted`. FIRMS nunca se incluye: es información de
 * tiempo casi real que no tiene sentido guardar.
 */
export async function writeSnapshots(dir = 'src/data/nasa', now = new Date()): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  for (const c of DEMO_CASES) {
    const q = { lat: c.lat, lon: c.lon, window: DEMO_WINDOW };
    const ingested = { smap: await readClimate(smapKey(q), now), giovanni: await readClimate(giovanniKey(q), now) };
    const records = [
      ...(await fetchPower(q, { now })).records,
      ...(ingested.smap?.records ?? []),
      ...(ingested.giovanni?.records ?? []),
    ];
    const snapshot = {
      meta: {
        name: c.name,
        generatedAt: now.toISOString(),
        command: 'node --env-file=.env --input-type=module -e "import(\'./src/services/nasa/fallback.ts\').then(m => m.writeSnapshots())"',
        attribution: SNAPSHOT_ATTRIBUTION,
        window: DEMO_WINDOW,
        omitted: [
          ...(['smap', 'giovanni'] as const)
            .filter((s) => !ingested[s])
            .map((s) => ({ source: s, reason: `Sin ingesta vigente en Supabase para esta celda y ventana (scripts/ingest-${s}.ts).` })),
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
