// Idiomas de la aplicación. Inglés es el predeterminado; cada idioma tiene su propia ruta
// (`/` y `/es/`) para que el HTML ya llegue traducido, incluso sin JavaScript ni conexión.
import * as en from './en.ts';
import * as es from './es.ts';

export const LANGS = ['en', 'es'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'en';
/** Clave de localStorage donde se guarda la preferencia. */
export const LANG_STORAGE_KEY = 'agroshift.lang';

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);

const DICTS = { en, es } as const;
/** Textos del idioma. Un valor desconocido usa el predeterminado. */
export const dict = (lang: unknown): (typeof DICTS)[Lang] => DICTS[isLang(lang) ? lang : DEFAULT_LANG];

/** Ruta de una página en un idioma: `pathFor('es', '/fuentes/')` → `/es/fuentes/`. Acepta rutas de cualquier idioma. */
export function pathFor(lang: Lang, path: string): string {
  const base = path.replace(/^\/es(?=\/|$)/, '') || '/';
  return lang === DEFAULT_LANG ? base : `/es${base === '/' ? '/' : base}`;
}

/** Idioma de una ruta: `/es/...` es español; el resto, inglés. */
export const langOfPath = (path: string): Lang => (/^\/es(\/|$)/.test(path) ? 'es' : 'en');
