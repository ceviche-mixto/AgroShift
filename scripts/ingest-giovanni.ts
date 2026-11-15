// Ingesta Giovanni in Cloud (GLDAS Noah 0.25° 3-hourly, Tair_f_inst) -> Supabase (climate_cache). Fuera de la ruta web.
//
// Uso (desde la raíz del repo):
//   node --env-file=.env scripts/ingest-giovanni.ts --lat=-6.77 --lon=-79.84 --start 2025-01-01 --end 2025-12-31 [--month 2025-12] [--dry]
//   Importar exportaciones oficiales de Giovanni (CSV de /timeseries), repetibles, en vez de llamar al servicio:
//   node --env-file=.env scripts/ingest-giovanni.ts --lat ... --lon ... --start ... --end ... --window-csv v.csv --baseline-csv b1.csv --baseline-csv b2.csv
// Requiere EARTHDATA_USERNAME y EARTHDATA_PASSWORD (token de Giovanni /signin) salvo al importar CSV. El mes objetivo por defecto es el último mes completo de la ventana.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { climateQuerySchema } from '../src/domain/schemas.ts';
import { addDays, daysInMonth } from '../src/services/nasa/grid.ts';
import {
  BASELINE,
  GIOVANNI_TTL_MS,
  GIOVANNI_USABLE_MS,
  fetchGiovanniWindow,
  giovanniToken,
  giovanniKey,
  normalizeGiovanni,
  parseGiovanniCsv,
} from '../src/services/nasa/giovanni.ts';
import { storeRecords } from '../src/services/nasa/index.ts';
import { purgeExpired } from '../src/services/supabase/cache.ts';

const { values: a } = parseArgs({
  options: {
    lat: { type: 'string' },
    lon: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    month: { type: 'string' },
    'window-csv': { type: 'string', multiple: true },
    'baseline-csv': { type: 'string', multiple: true },
    dry: { type: 'boolean', default: false },
  },
});
const query = climateQuerySchema.parse({ lat: Number(a.lat), lon: Number(a.lon), window: { start: a.start, end: a.end } });

const endMonth = query.window.end.slice(0, 7);
const lastDay = `${endMonth}-${String(daysInMonth(endMonth)).padStart(2, '0')}`;
const targetMonth = a.month ?? (query.window.end === lastDay ? endMonth : addDays(`${endMonth}-01`, -1).slice(0, 7));
if (!/^\d{4}-\d{2}$/.test(targetMonth)) throw new Error('--month debe ser YYYY-MM');
const mm = targetMonth.slice(5);

async function download() {
  const token = await giovanniToken({ signal: AbortSignal.timeout(60_000) });
  // Ventana en tramos de un año; periodo base: solo el mes objetivo de cada año base
  const window: string[] = [];
  for (let y = Number(query.window.start.slice(0, 4)); y <= Number(query.window.end.slice(0, 4)); y++) {
    const s = query.window.start > `${y}-01-01` ? query.window.start : `${y}-01-01`;
    const e = query.window.end < `${y}-12-31` ? query.window.end : `${y}-12-31`;
    window.push(await fetchGiovanniWindow(query.lat, query.lon, s, e, { token, signal: AbortSignal.timeout(120_000) }));
  }
  const baseline: string[] = [];
  for (let y = Number(BASELINE.start.slice(0, 4)); y <= Number(BASELINE.end.slice(0, 4)); y++) {
    const m = `${y}-${mm}`;
    baseline.push(await fetchGiovanniWindow(query.lat, query.lon, `${m}-01`, `${m}-${daysInMonth(m)}`, { token, signal: AbortSignal.timeout(120_000) }));
  }
  return { window, baseline };
}

const read = (paths: string[] = []) => paths.map((p) => readFileSync(p, 'utf8'));
const csvs = a['window-csv'] ? { window: read(a['window-csv']), baseline: read(a['baseline-csv']) } : await download();
const now = new Date();
const { records, observedUntil } = normalizeGiovanni(
  csvs.window.flatMap(parseGiovanniCsv),
  csvs.baseline.flatMap(parseGiovanniCsv),
  query,
  targetMonth,
  now,
);
for (const r of records) {
  const d = r.data;
  console.log(
    `${r.variable}: ${d.type === 'statistic' ? `${d.value} ${r.unit} (años base ${d.sampleCount}/${d.minSampleCount})` : `cobertura ${r.coverage.validCount}/${r.coverage.expectedCount} meses`}`,
  );
}
if (a.dry) process.exit(0);
const ok = await storeRecords(giovanniKey(query), records, observedUntil, GIOVANNI_TTL_MS, GIOVANNI_USABLE_MS, now);
console.log(ok ? 'Publicado en climate_cache.' : 'No se publicó (la concesión venció o una observación más reciente ya está guardada).');
await purgeExpired();
