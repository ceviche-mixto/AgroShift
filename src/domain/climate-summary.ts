import type { EvidenceRecord } from './contracts.ts';

// Cifras de «Clima de tu zona»: se derivan de los registros reales de NASA POWER y SMAP que ya trae
// la respuesta. Si falta un dato (o no cubre el periodo completo) devuelve `null`; nunca se inventa.

export interface ClimateFigure {
  value: number;
  source: 'power' | 'smap';
  period: { start: string; end: string };
}
export interface ClimateSummary {
  /** Temperatura media del aire, °C. */
  meanTempC: ClimateFigure | null;
  /** Lluvia total del periodo (un año completo), mm. */
  annualRainMm: ClimateFigure | null;
  /** Humedad del suelo en la zona radicular (si no hay, la superficie), m³/m³. */
  soilMoisture: ClimateFigure | null;
}

const MS_DAY = 86_400_000;
const daysIn = (t: string) => {
  const [y, m] = t.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Serie diaria (`YYYY-MM-DD`) o mensual de medias (`YYYY-MM`) → [valor medio diario, días que representa], sin faltantes. */
function weighted(r: EvidenceRecord): { v: number; days: number }[] | null {
  if (r.data.type !== 'series') return null;
  const monthly = r.data.step === 'month';
  return r.data.points.flatMap((p) => (p.v === null ? [] : [{ v: p.v, days: monthly ? daysIn(p.t) : 1 }]));
}

const spanDays = (r: EvidenceRecord) => (Date.parse(r.period.end) - Date.parse(r.period.start)) / MS_DAY + 1;
const find = (records: EvidenceRecord[], source: EvidenceRecord['source'], variable: string, unit: string) =>
  records.find((r) => r.source === source && r.unit === unit && (r.id.split(':')[1] ?? '') === variable && r.data.type === 'series');

const MIN_COVERAGE = 0.8;

export function climateSummary(records: EvidenceRecord[]): ClimateSummary {
  /** Media ponderada por días; exige que al menos el 80 % de los días tenga dato. */
  const mean = (r: EvidenceRecord | undefined, source: 'power' | 'smap'): ClimateFigure | null => {
    const pts = r && weighted(r);
    if (!r || !pts) return null;
    const days = pts.reduce((a, p) => a + p.days, 0);
    if (!days || days / spanDays(r) < MIN_COVERAGE) return null;
    return { value: pts.reduce((a, p) => a + p.v * p.days, 0) / days, source, period: r.period };
  };

  const rain = find(records, 'power', 'PRECTOTCORR', 'mm/day');
  const rainPts = rain && weighted(rain);
  // La lluvia se suma: con huecos subestimaría, así que pide el periodo completo y de al menos un año
  const full = !!rain && !!rainPts && rainPts.reduce((a, p) => a + p.days, 0) === spanDays(rain) && spanDays(rain) >= 360;

  return {
    meanTempC: mean(find(records, 'power', 'T2M', 'C'), 'power'),
    annualRainMm:
      full && rain && rainPts
        ? { value: rainPts.reduce((a, p) => a + p.v * p.days, 0), source: 'power', period: rain.period }
        : null,
    soilMoisture: mean(find(records, 'smap', 'sm_rootzone', 'm^3/m^3') ?? find(records, 'smap', 'sm_surface', 'm^3/m^3'), 'smap'),
  };
}
