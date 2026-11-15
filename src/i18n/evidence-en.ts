// English wording of the evidence texts that the data services write in Spanish (variable names, limitations,
// resolution). Exact-match table plus one pattern; any unknown text is shown unchanged, never lost.
import type { Lang } from './index.ts';

const EXACT: Record<string, string> = {
  'Estimación de reanálisis y satélite para una celda; no es una medición en la parcela.':
    'Reanalysis and satellite estimate for one grid cell; not a measurement in the plot.',
  'Los días más recientes pueden ser provisionales y cambiar.': 'The most recent days may be provisional and change.',
  'Producto modelado y asimilado: un modelo de superficie ajustado con observaciones SMAP; no es medición directa.':
    'Modeled and assimilated product: a land-surface model adjusted with SMAP observations; not a direct measurement.',
  'Celda de ~9 km: no representa el suelo de la parcela.': '~9 km cell: it does not represent the soil of the plot.',
  'Valor diario: promedio de las lecturas disponibles de cada fecha.': 'Daily value: average of the readings available for each date.',
  'Modelo de superficie terrestre forzado con observaciones (GLDAS Noah 2.1): estimación en una celda de 0.25°, no medición de la parcela.':
    'Land-surface model driven by observations (GLDAS Noah 2.1): an estimate for a 0.25° cell, not a measurement of the plot.',
  'La anomalía es un antecedente histórico frente al periodo base, no un pronóstico.':
    'The anomaly is a historical reference against the base period, not a forecast.',
  'La tendencia es indicativa: usa un solo mes del año y pocos años.': 'The trend is indicative: it uses a single month of the year and few years.',
  'Es una detección térmica satelital puntual: un posible foco de calor, no un incendio confirmado.':
    'This is a single satellite thermal detection: a possible heat spot, not a confirmed fire.',
  'Sin detecciones no descarta fuego: nubes y los pasos del satélite pueden ocultarlo.':
    'No detections does not rule out fire: clouds and satellite pass times can hide it.',
  'Humedad del suelo, superficie (0-5 cm)': 'Soil moisture, surface (0-5 cm)',
  'Humedad del suelo, zona radicular (0-100 cm)': 'Soil moisture, root zone (0-100 cm)',
  'Temperatura del aire cerca de la superficie, media mensual': 'Air temperature near the surface, monthly mean',
  'VIIRS 375 m, consulta en celda de 0.1°': 'VIIRS 375 m, queried on a 0.1° cell',
};

const PATTERNS: [RegExp, (...m: string[]) => string][] = [
  [/^Alcance: hasta (\S+) km del centro de una celda de 0\.1°, (\S+) días UTC\.$/, (_, km, d) => `Range: up to ${km} km from the center of a 0.1° cell, ${d} UTC days.`],
  [/^Anomalía de temperatura del aire, (\S+)$/, (_, m) => `Air temperature anomaly, ${m}`],
  [/^Tendencia de temperatura del aire, mes (\S+)$/, (_, m) => `Air temperature trend, month ${m}`],
];

/** Evidence text in the chosen language. Spanish is the original; English falls back to the original if unknown. */
export function evidenceText(lang: Lang, text: string): string {
  if (lang !== 'en') return text;
  const exact = EXACT[text];
  if (exact) return exact;
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(text);
    if (m) return fn(...m);
  }
  return text;
}
