import { describe, expect, it } from 'vitest';
import { FINDING_IDS, QUESTION_IDS, cropName, explainFinding, familyName, questionText, type Fact } from '../../src/domain/explain.ts';
import { alternativeFor } from '../../src/domain/scenarios.ts';
import { evidenceText } from '../../src/i18n/evidence-en.ts';
import * as en from '../../src/i18n/en.ts';
import * as es from '../../src/i18n/es.ts';
import { DEFAULT_LANG, LANGS, dict, langOfPath, pathFor } from '../../src/i18n/index.ts';

/** Forma de un valor: objetos con sus claves, funciones con su aridad y texto como `string`. */
function shape(v: unknown): unknown {
  if (typeof v === 'function') return `fn/${v.length}`;
  if (typeof v === 'string') return 'string';
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return typeof v;
}
function texts(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (v && typeof v === 'object') return Object.values(v).flatMap(texts);
  return [];
}

describe('espejo en.ts / es.ts', () => {
  it('mismos nombres exportados con la misma forma', () => {
    expect(shape({ ...en })).toEqual(shape({ ...es }));
  });

  it('ningún texto en inglés está vacío', () => {
    for (const t of texts({ ...en })) expect(t.trim().length, t).toBeGreaterThan(0);
  });

  it('en inglés: títulos <= 60, explicaciones <= 160 y siguiente paso en todo estado', () => {
    const mensajes: [string, en.Mensaje][] = [
      ...Object.entries(en.ESTADOS),
      ...Object.entries(en.RESULTADO),
      ...Object.entries(en.ESTADO_FUENTE),
      ...Object.entries(en.ESTADO_FUENTE_FIRMS).map(([k, m]) => [`firms.${k}`, m!] as [string, en.Mensaje]),
      ['cupo', en.cupoAgotado(40_000)],
      ['atrasada', en.fuenteAtrasada(en.hace(3 * 3_600_000))],
      ['planB', en.planBPendiente('rainfall of the last 30 days.')],
      ['fuego', en.ALERTA_FUEGO],
    ];
    for (const [nombre, m] of mensajes) {
      expect(m.titulo.length, nombre).toBeLessThanOrEqual(60);
      expect(m.explicacion.length, nombre).toBeLessThanOrEqual(160);
      if (m !== en.ESTADO_FUENTE.available) expect(m.siguientePaso, nombre).toBeTruthy();
    }
  });

  it('el pie lleva el equipo completo en ambos idiomas', () => {
    for (const nombre of ['Giancarlo Luciano Larios Infantes', 'Enzo Gabriel García Infantes', 'Sergio Anibal Tuesta Rodas']) {
      expect(es.PIE.equipo).toContain(nombre);
      expect(en.PIE.equipo).toContain(nombre);
    }
    expect(es.PIE.equipo.startsWith('Equipo OneCtrl:')).toBe(true);
    expect(en.PIE.equipo.startsWith('Team OneCtrl:')).toBe(true);
  });

  it('el selector de idioma anuncia su código visible', () => {
    for (const d of [en, es]) for (const code of ['en', 'es'] as const) expect(d.IDIOMA[code].etiqueta.startsWith(d.IDIOMA[code].corto)).toBe(true);
  });

  it('duraciones en inglés', () => {
    expect(en.hace(10_000)).toBe('just now');
    expect(en.hace(3_600_000)).toBe('1 hour ago');
    expect(en.hace(3 * 86_400_000)).toBe('3 days ago');
    expect(en.enTiempo(40_000)).toBe('in 40 seconds');
    expect(en.cupoAgotado(40_000).siguientePaso).toBe('Try again in 40 seconds.');
  });
});

describe('explicaciones por idioma', () => {
  const params = {
    crop: 'maize',
    previous: 'cowpea',
    other: 'sorghum',
    family: 'tuber',
    tempC: 24.5,
    min: 18,
    max: 30,
    rainMm: 800.4,
    minMm: 500,
    maxMm: 1200,
    marginMm: 300,
    validDays: 100,
    minDays: 300,
    days: 90,
    season: 'Kharif',
    seasons: 'Rabi',
    start: '2025-01-01',
    end: '2025-12-31',
    scenario: 'limited_water',
    assumption: 'Si tuvieras menos agua',
  };

  it('cada hecho del motor tiene plantilla en inglés, sin quedarse con texto en español', () => {
    for (const id of FINDING_IDS) {
      const fact: Fact = { id, ruleId: 'r', params };
      const english = explainFinding(fact, 'en');
      expect(english.length, id).toBeGreaterThan(20);
      expect(english, id).not.toMatch(/[áéíóúñ¿¡]/);
      expect(english, id).not.toBe(explainFinding(fact, 'es'));
    }
  });

  it('el idioma predeterminado de explainFinding sigue siendo español', () => {
    expect(explainFinding({ id: 'missing.cycle_coverage', ruleId: 'r', params: {} })).toContain('Los datos de clima');
    expect(explainFinding({ id: 'no.existe', ruleId: 'r', params: {} }, 'en')).toContain('local technician');
  });

  it('los supuestos del Plan B salen en inglés por escenario', () => {
    for (const water of ['enough', 'limited'] as const) {
      const a = alternativeFor(water);
      const text = explainFinding({ id: 'restriction.hypothetical', ruleId: 'r', params: { scenario: a.scenario.id, assumption: a.assumption } }, 'en');
      expect(text).toMatch(/^Assumption, not a forecast\. If /);
      expect(text).not.toContain(a.assumption);
    }
  });

  it('números con punto decimal en inglés y coma en español; «no data» si falta', () => {
    const f: Fact = { id: 'reason.thermal_optimal', ruleId: 'r', params: { crop: 'maize', tempC: 24.5, min: 18, max: null } };
    expect(explainFinding(f, 'en')).toContain('24.5 °C');
    expect(explainFinding(f, 'en')).toContain('no data');
    expect(explainFinding(f, 'es')).toContain('24,5 °C');
  });

  it('nombres de cultivo, familia y preguntas en inglés', () => {
    expect(cropName('finger_millet', 'en')).toBe('finger millet');
    expect(cropName('finger_millet')).toBe('mijo dedo');
    expect(familyName('tuber', 'en')).toBe('tuber');
    expect(familyName('x', 'en')).toBe('crop without its own sheet');
    for (const id of QUESTION_IDS) expect(questionText(id, 'en')).toMatch(/\?$/);
    expect(questionText('why_plan_a', 'en')).toBe('Why is Plan A proposed to me?');
  });
});

describe('textos de evidencia', () => {
  it('traduce los conocidos y deja intacto lo desconocido', () => {
    expect(evidenceText('en', 'Humedad del suelo, superficie (0-5 cm)')).toBe('Soil moisture, surface (0-5 cm)');
    expect(evidenceText('en', 'Anomalía de temperatura del aire, 2025-12')).toBe('Air temperature anomaly, 2025-12');
    expect(evidenceText('en', 'Alcance: hasta 50 km del centro de una celda de 0.1°, 3 días UTC.')).toContain('Range: up to 50 km');
    expect(evidenceText('en', 'T2M')).toBe('T2M');
    expect(evidenceText('es', 'Humedad del suelo, superficie (0-5 cm)')).toBe('Humedad del suelo, superficie (0-5 cm)');
  });
});

describe('rutas por idioma', () => {
  it('inglés es el predeterminado y cada idioma tiene su ruta', () => {
    expect(DEFAULT_LANG).toBe('en');
    expect(LANGS).toEqual(['en', 'es']);
    expect(pathFor('en', '/')).toBe('/');
    expect(pathFor('es', '/')).toBe('/es/');
    expect(pathFor('es', '/fuentes/')).toBe('/es/fuentes/');
    expect(pathFor('en', '/es/fuentes/')).toBe('/fuentes/');
    expect(pathFor('en', '/es/')).toBe('/');
    expect(langOfPath('/es/offline/')).toBe('es');
    expect(langOfPath('/espresso')).toBe('en');
    expect(dict('xx')).toBe(dict('en'));
    expect(dict('es').PIE.fuentes).toBe(es.PIE.fuentes);
  });
});
