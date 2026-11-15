// Ingesta SMAP L4 (SPL4SMGP.008) vía AppEEARS -> Supabase (climate_cache). Fuera de la ruta web.
//
// Uso (desde la raíz del repo):
//   node --env-file=.env scripts/ingest-smap.ts --lat=-6.77 --lon=-79.84 --start 2025-01-01 --end 2025-12-31
//   node --env-file=.env scripts/ingest-smap.ts --lat ... --lon ... --start ... --end ... --task <ID>      (reanuda una tarea)
//   node --env-file=.env scripts/ingest-smap.ts --lat ... --lon ... --start ... --end ... --bundle <csv|carpeta>  (importa un bundle ya descargado)
//   Añade --dry para validar y resumir sin escribir en Supabase.
// Usa la forma --lat=-6.77 (con signo negativo, el valor pegado con =).
// Requiere EARTHDATA_USERNAME y EARTHDATA_PASSWORD (AppEEARS /login usa autenticación básica;
// el token EARTHDATA_TOKEN no es válido en AppEEARS). No son necesarios con --bundle.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { climateQuerySchema } from '../src/domain/schemas.ts';
import { serverEnv } from '../src/services/env.ts';
import { fetchJson, fetchText, type FetchOptions } from '../src/services/nasa/fetch.ts';
import { cellSmap } from '../src/services/nasa/grid.ts';
import { storeRecords } from '../src/services/nasa/index.ts';
import { SMAP_LAYERS, SMAP_PRODUCT, SMAP_TTL_MS, SMAP_USABLE_MS, normalizeSmap, smapKey } from '../src/services/nasa/smap.ts';
import { purgeExpired } from '../src/services/supabase/cache.ts';

const API = 'https://appeears.earthdatacloud.nasa.gov/api';
const POLL_MS = 15_000;
const MAX_WAIT_MS = 15 * 60_000;

const { values: a } = parseArgs({
  options: {
    lat: { type: 'string' },
    lon: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    task: { type: 'string' },
    bundle: { type: 'string' },
    dry: { type: 'boolean', default: false },
  },
});
const query = climateQuerySchema.parse({ lat: Number(a.lat), lon: Number(a.lon), window: { start: a.start, end: a.end } });
const cell = cellSmap(query.lat, query.lon);

const mdy = (d: string) => `${d.slice(5, 7)}-${d.slice(8, 10)}-${d.slice(0, 4)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fromAppeears(): Promise<string> {
  const user = serverEnv('EARTHDATA_USERNAME');
  const pass = serverEnv('EARTHDATA_PASSWORD');
  if (!user || !pass) throw new Error('Faltan EARTHDATA_USERNAME y EARTHDATA_PASSWORD (AppEEARS exige usuario y contraseña de Earthdata)');
  const login = (await fetchJson(`${API}/login`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` },
    secrets: [user, pass],
    signal: AbortSignal.timeout(60_000),
  })) as { token: string };
  const opts = (): FetchOptions => ({ headers: { Authorization: `Bearer ${login.token}` }, secrets: [user, pass, login.token], signal: AbortSignal.timeout(120_000) });

  let id = a.task;
  if (!id) {
    // Se consulta el centro de la celda, no la coordenada de la parcela
    const body = {
      task_type: 'point',
      task_name: `agroshift-smap-${cell.cellId}-${query.window.start}-${query.window.end}`.slice(0, 120),
      params: {
        dates: [{ startDate: mdy(query.window.start), endDate: mdy(query.window.end) }],
        layers: SMAP_LAYERS.map((l) => ({ product: SMAP_PRODUCT, layer: l.layer })),
        coordinates: [{ id: '1', category: 'agroshift', latitude: cell.lat, longitude: cell.lon }],
      },
    };
    const created = (await fetchJson(`${API}/task`, { ...opts(), method: 'POST', body: JSON.stringify(body), headers: { ...opts().headers, 'Content-Type': 'application/json' } })) as { task_id: string };
    id = created.task_id;
    console.log(`Tarea creada: ${id}. Si se corta, reanuda con --task ${id}`);
  }

  const started = Date.now();
  for (;;) {
    const t = (await fetchJson(`${API}/task/${id}`, opts())) as { status: string };
    console.log(`Estado de la tarea ${id}: ${t.status}`);
    if (t.status === 'done') break;
    if (t.status === 'error') throw new Error(`La tarea ${id} terminó con error en AppEEARS`);
    if (Date.now() - started > MAX_WAIT_MS) {
      console.log(`Tarea sin terminar tras 15 min. Reanuda con --task ${id}`);
      process.exit(2);
    }
    await sleep(POLL_MS);
  }
  const bundle = (await fetchJson(`${API}/bundle/${id}`, opts())) as { files: { file_id: string; file_name: string }[] };
  const file = bundle.files.find((f) => /results\.csv$/i.test(f.file_name));
  if (!file) throw new Error('El bundle no trae el CSV de resultados');
  return fetchText(`${API}/bundle/${id}/${file.file_id}`, opts());
}

function fromBundle(path: string): string {
  if (!statSync(path).isDirectory()) return readFileSync(path, 'utf8');
  const csv = readdirSync(path).find((f) => /results\.csv$/i.test(f));
  if (!csv) throw new Error('La carpeta no contiene un CSV de resultados');
  return readFileSync(join(path, csv), 'utf8');
}

const csv = a.bundle ? fromBundle(a.bundle) : await fromAppeears();
const now = new Date();
const { records, observedUntil } = normalizeSmap(csv, query, query.window, now);
for (const r of records) console.log(`${r.variable}: cobertura ${r.coverage.status} (${r.coverage.validCount}/${r.coverage.expectedCount}) celda ${r.grid.cellId}`);
if (a.dry) process.exit(0);
const ok = await storeRecords(smapKey(query), records, observedUntil, SMAP_TTL_MS, SMAP_USABLE_MS, now);
console.log(ok ? 'Publicado en climate_cache.' : 'No se publicó (la concesión venció o una observación más reciente ya está guardada).');
await purgeExpired();
