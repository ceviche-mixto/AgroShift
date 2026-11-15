import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_KINDS,
  GOALS,
  LOCATION_ORIGINS,
  RESULT_STATES,
  SCENARIO_NATURES,
  SOURCE_STATES,
  SOURCES,
  WATER_LEVELS,
} from '../../src/domain/schemas.ts';
import {
  ALERTA_FUEGO,
  AVISO_DECISION,
  CAMPOS,
  COORDENADAS_MANUAL,
  cupoAgotado,
  enTiempo,
  errorDeCampo,
  ESTADO_FUENTE,
  ESTADO_FUENTE_FIRMS,
  ESTADOS,
  fuenteAtrasada,
  FUENTES,
  hace,
  NATURALEZA_ESCENARIO,
  PAGINA_FUENTES,
  PASOS,
  PIE,
  planBPendiente,
  RESULTADO,
  TIPO_EVIDENCIA,
  TONOS,
  type Mensaje,
} from '../../src/content/es.ts';

const keys = (o: object) => Object.keys(o).sort();
const sorted = (a: readonly string[]) => [...a].sort();

const mensajes: [string, Mensaje][] = [
  ...Object.entries(ESTADOS),
  ...Object.entries(RESULTADO),
  ...Object.entries(ESTADO_FUENTE),
  ...Object.entries(ESTADO_FUENTE_FIRMS).map(([k, m]) => [`firms.${k}`, m!] as [string, Mensaje]),
  ['cupoAgotado', cupoAgotado(40_000)],
  ['fuenteAtrasada', fuenteAtrasada('hace 3 horas')],
  ['planBPendiente', planBPendiente('la lluvia de los últimos 30 días.')],
  ['alertaFuego', ALERTA_FUEGO],
];

/** Todos los textos visibles, aplanados. */
function textos(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (v && typeof v === 'object') return Object.values(v).flatMap(textos);
  return [];
}
const visibles = [
  ...textos(CAMPOS),
  ...textos(TONOS),
  ...textos(FUENTES),
  ...textos(TIPO_EVIDENCIA),
  ...textos(NATURALEZA_ESCENARIO),
  ...mensajes.flatMap(([, m]) => textos(m)),
  AVISO_DECISION,
  hace(7_200_000),
  enTiempo(40_000),
];

describe('claves del contrato', () => {
  it('cada valor de las enumeraciones tiene texto', () => {
    expect(keys(CAMPOS.ubicacion.opciones)).toEqual(sorted(LOCATION_ORIGINS));
    expect(keys(CAMPOS.objetivo.opciones)).toEqual(sorted(GOALS));
    expect(keys(CAMPOS.agua.opciones)).toEqual(sorted(WATER_LEVELS));
    expect(keys(CAMPOS.cultivo.etapa)).toEqual(['current', 'last_harvested']);
    expect(keys(CAMPOS.siembra.precision)).toEqual(['day', 'month']);
    expect(keys(RESULTADO)).toEqual(sorted(RESULT_STATES));
    expect(keys(ESTADO_FUENTE)).toEqual(sorted(SOURCE_STATES));
    expect(keys(FUENTES)).toEqual(sorted(SOURCES));
    expect(keys(TIPO_EVIDENCIA)).toEqual(sorted(EVIDENCE_KINDS));
    expect(keys(NATURALEZA_ESCENARIO)).toEqual(sorted(SCENARIO_NATURES));
  });

  it('los cinco campos tienen etiqueta, ayuda y error', () => {
    expect(Object.keys(CAMPOS)).toHaveLength(5);
    for (const c of Object.values(CAMPOS)) {
      expect(c.etiqueta).toMatch(/^¿.+\?$/);
      expect(c.ayuda.length).toBeGreaterThan(0);
      expect(c.error.length).toBeGreaterThan(0);
    }
  });

  it('el error por campo sale de la ruta del contrato', () => {
    expect(errorDeCampo('location.lat')).toBe(CAMPOS.ubicacion.error);
    expect(errorDeCampo('planting.date')).toBe(CAMPOS.siembra.error);
    expect(errorDeCampo('otra')).toBe(ESTADOS.entradaInvalida.explicacion);
  });

  it('un supuesto nunca se lee como pronóstico', () => {
    expect(NATURALEZA_ESCENARIO.hypothetical).toContain('no es un pronóstico');
    expect(TIPO_EVIDENCIA.hypothetical_scenario).toContain('no es un pronóstico');
  });
});

describe('textos', () => {
  it('ninguno está vacío', () => {
    for (const t of visibles) expect(t.trim().length).toBeGreaterThan(0);
  });

  it('títulos <= 60 y explicaciones <= 160', () => {
    for (const [, m] of mensajes) {
      expect(m.titulo.length).toBeLessThanOrEqual(60);
      expect(m.explicacion.length).toBeLessThanOrEqual(160);
      expect(m.tono in TONOS).toBe(true);
    }
  });

  it('todo estado salvo «fuente disponible» trae siguiente paso', () => {
    for (const [nombre, m] of mensajes) {
      if (m === ESTADO_FUENTE.available) continue;
      expect(m.siguientePaso, nombre).toBeTruthy();
    }
  });

  it('sin IDs técnicos ni claves del contrato', () => {
    const prohibido = /SPL4SMGP|T2M|PRECTOTCORR|RH2M|GLDAS|MERRA|insufficient|\b[a-z]+_[a-z_]+\b|HTTP|\b429\b/;
    for (const t of visibles) expect(t, t).not.toMatch(prohibido);
  });

  it('alerta de fuego: texto fijo y alcance', () => {
    expect(ALERTA_FUEGO.titulo).toBe('Posible foco de calor cerca');
    expect(ALERTA_FUEGO.explicacion).toContain('no confirma');
  });

  it('cupo agotado y fuente atrasada usan sus parámetros', () => {
    expect(cupoAgotado(40_000).siguientePaso).toBe('Inténtalo de nuevo en 40 segundos.');
    expect(fuenteAtrasada(hace(3 * 3_600_000)).explicacion).toContain('hace 3 horas');
    expect(planBPendiente('el riego.').siguientePaso).toContain('el riego.');
  });
});

describe('pasos, pie y fuentes', () => {
  it('conteo de pasos y pie institucional', () => {
    expect(PASOS.conteo(2, 5)).toBe('Paso 2 de 5');
    expect(PIE.evento).toBe('NASA Space Apps Challenge Chiclayo 2026');
    expect(PIE.aviso).toContain('técnico agrónomo');
    expect(COORDENADAS_MANUAL).toBe('Ingresar coordenadas manualmente');
  });

  it('la atribución de GeoNames vive en /fuentes, no en el formulario', () => {
    const lugares = PAGINA_FUENTES.lugares.items[0]!;
    expect(lugares.nombre).toContain('GeoNames');
    expect(lugares.descripcion).toContain('CC BY 4.0');
    expect(textos(CAMPOS).join(' ')).not.toContain('GeoNames');
    for (const s of [PAGINA_FUENTES.datos, PAGINA_FUENTES.lugares, PAGINA_FUENTES.herramientas])
      for (const f of s.items) expect(f.enlace.url).toMatch(/^https:\/\//);
  });
});

describe('duraciones', () => {
  const S = 1000;
  it('hace: singular, plural y límites', () => {
    expect(hace(10 * S)).toBe('hace un momento');
    expect(hace(60 * S)).toBe('hace 1 minuto');
    expect(hace(5 * 60 * S)).toBe('hace 5 minutos');
    expect(hace(3_600 * S)).toBe('hace 1 hora');
    expect(hace(3 * 3_600 * S)).toBe('hace 3 horas');
    expect(hace(86_400 * S)).toBe('hace 1 día');
    expect(hace(2 * 86_400 * S)).toBe('hace 2 días');
    expect(hace(Number.NaN)).toBe('hace un momento');
  });

  it('enTiempo: redondea hacia arriba', () => {
    expect(enTiempo(1)).toBe('en 1 segundo');
    expect(enTiempo(1_500)).toBe('en 2 segundos');
    expect(enTiempo(40 * S)).toBe('en 40 segundos');
    expect(enTiempo(120 * S)).toBe('en 2 minutos');
    expect(enTiempo(0)).toBe('en 1 segundo');
    expect(enTiempo(Number.NaN)).toBe('en 1 segundo');
  });
});

// ---------- Contraste (WCAG 2.2) leído de los tokens de global.css ----------

const css = readFileSync(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
const color: Record<string, string> = Object.fromEntries(
  [...css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]!]),
);

function luminancia(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function ratio(a: string, b: string): number {
  const [x, y] = [luminancia(color[a]!), luminancia(color[b]!)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const TONOS_CSS = ['info', 'aviso', 'alerta', 'exito', 'sindato'] as const;
const TEXTO = 7; // AAA, texto normal
const TEXTO_DESHABILITADO = 4.5; // exento por WCAG; se exige igual
const COMPONENTE = 3; // bordes, símbolos, foco

// [descripción, color delantero, color de fondo, mínimo]
const combinaciones: [string, string, string, number][] = [
  ['texto / fondo', 'color-texto', 'color-fondo', TEXTO],
  ['texto / superficie', 'color-texto', 'color-superficie', TEXTO],
  ['texto suave / fondo', 'color-texto-suave', 'color-fondo', TEXTO],
  ['texto suave / superficie', 'color-texto-suave', 'color-superficie', TEXTO],
  ['botón reposo', 'color-primario-texto', 'color-primario', TEXTO],
  ['botón hover', 'color-primario-texto', 'color-primario-hover', TEXTO],
  ['opción reposo', 'color-texto', 'color-superficie', TEXTO],
  ['opción hover', 'color-texto', 'opcion-hover-fondo', TEXTO],
  ['opción activa', 'color-texto', 'opcion-activo-fondo', TEXTO],
  ['opción elegida', 'color-primario-texto', 'color-primario', TEXTO],
  ['opción elegida hover', 'color-primario-texto', 'color-primario-hover', TEXTO],
  ['opción elegida activa', 'color-primario-texto', 'opcion-elegida-activo-fondo', TEXTO],
  ['opción deshabilitada', 'opcion-off-texto', 'opcion-off-fondo', TEXTO_DESHABILITADO],
  ['borde opción / fondo', 'color-borde', 'color-fondo', COMPONENTE],
  ['borde opción / superficie', 'color-borde', 'color-superficie', COMPONENTE],
  ['borde opción / hover', 'color-borde', 'opcion-hover-fondo', COMPONENTE],
  ['borde opción / activa', 'color-borde', 'opcion-activo-fondo', COMPONENTE],
  ['borde elegida / fondo', 'color-primario', 'color-fondo', COMPONENTE],
  ['borde elegida activa / fondo', 'opcion-elegida-activo-fondo', 'color-fondo', COMPONENTE],
  ['borde deshabilitada / fondo', 'opcion-off-borde', 'color-fondo', COMPONENTE],
  ['borde deshabilitada / propio', 'opcion-off-borde', 'opcion-off-fondo', COMPONENTE],
  ['foco / fondo', 'color-foco', 'color-fondo', COMPONENTE],
  ['foco / superficie', 'color-foco', 'color-superficie', COMPONENTE],
  ['foco / hover', 'color-foco', 'opcion-hover-fondo', COMPONENTE],
  ['foco / activa', 'color-foco', 'opcion-activo-fondo', COMPONENTE],
  ['espera (anillo) / fondo', 'color-primario', 'color-fondo', COMPONENTE],
  ...TONOS_CSS.flatMap((t): [string, string, string, number][] => [
    [`estado ${t}: texto`, 'color-texto', `${t}-fondo`, TEXTO],
    [`estado ${t}: borde y símbolo / propio`, `${t}-borde`, `${t}-fondo`, COMPONENTE],
    [`estado ${t}: borde / fondo`, `${t}-borde`, 'color-fondo', COMPONENTE],
  ]),
];

describe('contraste WCAG 2.2', () => {
  it.each(combinaciones)('%s', (_n, fg, bg, min) => {
    expect(color[fg], fg).toBeDefined();
    expect(color[bg], bg).toBeDefined();
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
  });

  it('cada token de color se usa en alguna regla', () => {
    const reglas = css.replace(/:root\s*\{[^}]*\}/, '');
    // texto-suave lo usa BaseLayout, no global.css.
    for (const t of Object.keys(color).filter((c) => c !== 'color-texto-suave'))
      expect(reglas, t).toContain(`var(--${t})`);
  });

  it('hay variante CSS por tono, alto contraste y movimiento reducido', () => {
    for (const t of TONOS_CSS) expect(css).toContain(`.estado--${t} `);
    expect(Object.keys(TONOS).sort()).toEqual([...TONOS_CSS].sort());
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*\.espera__giro \{ animation: none; \}/);
    expect(css).toContain('--tamano-tactil: 3rem');
  });

  it('cada tono usa un borde distinto (estilo y grosor)', () => {
    const bordes = TONOS_CSS.map((t) => css.match(new RegExp(`\\.estado--${t} \\{[^}]*border: ([^;]*?) var`))?.[1]);
    expect(new Set(bordes).size).toBe(TONOS_CSS.length);
  });
});
