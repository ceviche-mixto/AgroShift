// Visible texts in English (default language). Exact mirror of `es.ts`: same names, same shape.
// Pure module: only contract types (erased at compile time). tests/i18n/mirror.test.ts checks the mirror.
// Scientific metadata (product, version, unit, resolution) does NOT live here: it comes from the contract.
import type {
  CacheOrigin,
  CropAnswer,
  EvidenceKind,
  FarmLocation,
  Goal,
  PlantingAnswer,
  ResultState,
  Scenario,
  Source,
  SourceState,
  WaterLevel,
} from '../domain/contracts.ts';

type EtapaCultivo = Extract<CropAnswer, { status: 'known' }>['stage'];
type PrecisionSiembra = Extract<PlantingAnswer, { status: 'known' }>['precision'];

// ---------- Status tones (symbol + label + border; color only supports them) ----------

export type Tono = 'info' | 'aviso' | 'alerta' | 'exito' | 'sindato';

/** CSS class: `estado estado--${tone}`. The symbol goes in `<span class="estado__simbolo" aria-hidden="true">`. */
export const TONOS: Record<Tono, { simbolo: string; etiqueta: string }> = {
  info: { simbolo: 'ℹ︎', etiqueta: 'Information' },
  aviso: { simbolo: '⚠︎', etiqueta: 'Notice' },
  alerta: { simbolo: '✖︎', etiqueta: 'Alert' },
  exito: { simbolo: '✔︎', etiqueta: 'Ready' },
  sindato: { simbolo: '?', etiqueta: 'No data' },
};

export interface Mensaje {
  tono: Tono;
  /** Up to 60 characters. */
  titulo: string;
  /** One sentence, up to 160 characters. */
  explicacion: string;
  /** What to do now. Only when it applies. */
  siguientePaso?: string;
}

// ---------- Durations ----------

const UNIDADES = [
  [86_400, 'day', 'days'],
  [3_600, 'hour', 'hours'],
  [60, 'minute', 'minutes'],
  [1, 'second', 'seconds'],
] as const;

function cantidad(segundos: number): string {
  const [base, uno, varios] = UNIDADES.find(([s]) => segundos >= s) ?? UNIDADES[3];
  const n = Math.floor(segundos / base);
  return `${n} ${n === 1 ? uno : varios}`;
}

/** Age of a data point: "3 hours ago", "2 days ago". Under one minute: "just now". */
export function hace(ms: number): string {
  return ms >= 60_000 ? `${cantidad(Math.floor(ms / 1000))} ago` : 'just now';
}

/** Wait: "in 40 seconds". Rounds up so nobody is asked to retry too early. */
export function enTiempo(ms: number): string {
  return `in ${cantidad(Math.max(1, Math.ceil(ms / 1000) || 1))}`;
}

// ---------- The five questions ----------

export const CAMPOS = {
  ubicacion: {
    etiqueta: 'Where is your field?',
    ayuda: 'With the place we can look up the weather and soil of your area. Using your location is optional.',
    opciones: {
      gps: 'Use my location',
      manual_coordinates: 'Type coordinates',
      place_search: 'Search for my town',
    } satisfies Record<FarmLocation['origin'], string>,
    latitud: 'Latitude',
    longitud: 'Longitude',
    localidad: 'Name of your town',
    errorGps: 'We could not use your location. Type the coordinates or search for your town.',
    error: 'Tell us where your field is. Use your location, type the coordinates or search for your town.',
  },
  cultivo: {
    etiqueta: 'What do you grow, or what did you harvest last?',
    ayuda: 'What was in the soil before changes what is best to plant next.',
    etapa: {
      current: 'I am growing it now',
      last_harvested: 'I harvested it last',
    } satisfies Record<EtapaCultivo, string>,
    nombre: 'Crop name',
    rapidas: 'Pick one of the most common crops',
    otro: 'Another crop',
    buscadorAyuda: 'Type the name the way you know it: we understand corn, maize, beans, potato, tomato…',
    sugerencias: 'Crop suggestions',
    sugerenciaFamilia: (tipo: string) => `no own sheet · ${tipo}`,
    noSe: 'I do not know',
    error: 'Type the name of the crop or check "I do not know".',
  },
  objetivo: {
    etiqueta: 'What do you need to solve?',
    ayuda: 'This way we show you what matters most to you first.',
    opciones: {
      next_crop: 'What can I plant next?',
      save_water: 'I want to make better use of water',
      care_soil: 'I want to take care of my soil',
    } satisfies Record<Goal, string>,
    error: 'Choose what you want to solve.',
  },
  agua: {
    etiqueta: 'How much water do you have for planting?',
    ayuda: 'The water you have limits which crops can cope.',
    opciones: {
      enough: 'I have enough water',
      limited: 'I have little water',
      unknown: 'I am not sure',
    } satisfies Record<WaterLevel, string>,
    error: 'Choose how much water you have or check "I am not sure".',
  },
  siembra: {
    etiqueta: 'When do you plan to plant?',
    ayuda: 'The date tells us what weather to expect at that time of year.',
    precision: {
      day: 'I know the day',
      month: 'I only know the month',
    } satisfies Record<PrecisionSiembra, string>,
    noSe: 'I do not know yet',
    error: 'Type a valid date or check "I do not know yet".',
  },
} as const;

const CAMPO_DE_RUTA = {
  location: 'ubicacion',
  crop: 'cultivo',
  goal: 'objetivo',
  water: 'agua',
  planting: 'siembra',
} as const;

/** Error message of a field from the contract path (`issues[].path`, e.g. `location.lat`). */
export function errorDeCampo(ruta: string): string {
  const campo = CAMPO_DE_RUTA[ruta.split('.')[0] as keyof typeof CAMPO_DE_RUTA];
  return campo ? CAMPOS[campo].error : ESTADOS.entradaInvalida.explicacion;
}

// ---------- Screen states ----------

export const ESTADOS = {
  entradaInvalida: {
    tono: 'alerta',
    titulo: 'Check your answers',
    explicacion: 'Some answers could not be used.',
    siguientePaso: 'Fix the marked fields and try again.',
  },
  espera: {
    tono: 'info',
    titulo: 'We are checking your field',
    explicacion: 'We are looking up weather and soil data for your area.',
    siguientePaso: 'Wait a few seconds and do not close the page.',
  },
  sinRed: {
    tono: 'aviso',
    titulo: 'No internet connection',
    explicacion: 'Without internet we cannot check your field.',
    siguientePaso: 'Connect to the internet and try again.',
  },
  sinRedConPlan: {
    tono: 'aviso',
    titulo: 'No internet connection',
    explicacion: 'We are showing the last plan you saved.',
    siguientePaso: 'When internet is back, refresh to see new data.',
  },
  planBPendiente: {
    tono: 'sindato',
    titulo: 'Second option pending',
    explicacion: 'We still lack information to give you a second option.',
    siguientePaso: 'Check in your field how moist the soil is and how much it rained.',
  },
} as const satisfies Record<string, Mensaje>;

/** Quota used up (HTTP 429). `ms` is the wait the server asks for. */
export function cupoAgotado(ms: number): Mensaje {
  return {
    tono: 'aviso',
    titulo: 'Too many requests',
    explicacion: 'The request quota is used up for now.',
    siguientePaso: `Try again ${enTiempo(ms)}.`,
  };
}

/** Outdated source. `edad` is already formatted, e.g. `hace(ms)`. */
export function fuenteAtrasada(edad: string): Mensaje {
  return {
    tono: 'aviso',
    titulo: 'Outdated data',
    explicacion: `This data was taken ${edad}.`,
    siguientePaso: 'Use it with care and try again later.',
  };
}

/** Pending Plan B with what to check (already worded), or the general notice. */
export function planBPendiente(queRevisar?: string): Mensaje {
  const base: Mensaje = ESTADOS.planBPendiente;
  return queRevisar ? { ...base, siguientePaso: `Check this: ${queRevisar}` } : base;
}

export const RESULTADO: Record<ResultState, Mensaje> = {
  ok: {
    tono: 'exito',
    titulo: 'Your plan is ready',
    explicacion: 'You have a first option and a second option.',
    siguientePaso: 'Read both and choose the one that suits you best.',
  },
  partial: {
    tono: 'aviso',
    titulo: 'Your plan is only partly ready',
    explicacion: 'We only have part of what is needed.',
    siguientePaso: 'Look at what is missing before you decide.',
  },
  insufficient_evidence: {
    tono: 'sindato',
    titulo: 'Not enough data yet',
    explicacion: 'With what we have, we cannot recommend a crop.',
    siguientePaso: 'Look at what is missing and try again.',
  },
};

export const ESTADO_FUENTE: Record<SourceState, Mensaje> = {
  available: {
    tono: 'exito',
    titulo: 'Data up to date',
    explicacion: 'This source answered correctly.',
  },
  partial: {
    tono: 'aviso',
    titulo: 'Incomplete data',
    explicacion: 'Some days or areas are missing in this source.',
    siguientePaso: 'Take the result with care.',
  },
  stale: {
    tono: 'aviso',
    titulo: 'Outdated data',
    explicacion: 'We used the last saved data.',
    siguientePaso: 'Use it with care and try again later.',
  },
  unavailable: {
    tono: 'alerta',
    titulo: 'Source not responding',
    explicacion: 'We could not query this source.',
    siguientePaso: 'Try again later.',
  },
  insufficient_coverage: {
    tono: 'sindato',
    titulo: 'No data for your area',
    explicacion: 'This source has too little data near your field.',
    siguientePaso: 'Check the soil moisture in your field.',
  },
};

/**
 * FIRMS not responding is not a fire alert: a red notice would be mistaken for a real fire.
 * Neutral tone (gray for "unavailable", soft amber for "last saved reading").
 */
export const ESTADO_FUENTE_FIRMS: Partial<Record<SourceState, Mensaje>> = {
  unavailable: {
    tono: 'sindato',
    titulo: 'Heat-spot monitoring not available',
    explicacion: 'Satellite heat-spot monitoring is temporarily unavailable (NASA FIRMS).',
    siguientePaso: 'Look around for nearby burning before you plant.',
  },
  stale: {
    tono: 'aviso',
    titulo: 'Last saved heat-spot reading',
    explicacion: 'We used the last saved reading, with its date. It does not show the present moment.',
    siguientePaso: 'Look around for nearby burning before you plant.',
  },
};

// ---------- Sources, evidence, scenarios ----------

export const FUENTES: Record<Source, string> = {
  power: 'Weather (NASA POWER)',
  smap: 'Soil moisture (NASA SMAP)',
  giovanni: 'Temperature trend (NASA Giovanni)',
  firms: 'Heat detected by satellite (NASA FIRMS)',
  complement: 'Supporting information',
};

export const TIPO_EVIDENCIA: Record<EvidenceKind, string> = {
  observation: 'Observed data',
  modeled_estimate: 'Model estimate',
  hypothetical_scenario: 'Assumption: not a forecast',
  projection: 'Projection',
};

export const NATURALEZA_ESCENARIO: Record<Scenario['nature'], string> = {
  observed_reference: 'Observed data',
  hypothetical: 'Assumption: not a forecast',
  projection: 'Projection',
};

// ---------- Fixed notices ----------

export const ALERTA_FUEGO: Mensaje = {
  tono: 'alerta',
  titulo: 'Possible heat spot nearby',
  explicacion: 'A satellite detected heat near your field. This does not confirm that there is a fire.',
  siguientePaso: 'Look around you and alert the authorities if you see fire.',
};

export const AVISO_DECISION =
  'This tool helps you decide. It does not replace checking your field or the advice of a technician.';

// ---------- Dynamic texts of the form and result screens ----------

export const ROL_PLAN = { A: 'Plan A', B: 'Plan B' } as const;

/**
 * Plan titles and badge. The badge replaces per-plan notice boxes:
 * `riego` is a management condition of a complete plan; `falta` only shows if the person can supply a fact.
 */
export const PLAN_INSIGNIA = {
  riego: 'Needs supplemental irrigation',
  falta: 'Missing information',
} as const;
export const PLAN_TITULO = { descanso: 'Fallow with green manure', porDefinir: 'Crop to be decided' } as const;

/** Where a source's data came from (slot `origin` of the `source` template). */
export const ORIGEN_DATO: Record<CacheOrigin, string> = {
  live: 'Queried just now',
  shared_cache: 'Recent copy saved on the server',
  stale_snapshot: 'Copy saved a while ago',
  local_snapshot: 'Copy saved on this device',
};

/** Location: notices of the `location-status` area. `metros` is the accuracy reported by the device. */
export const UBICACION_ESTADO = {
  buscandoGps: 'Looking for your location…',
  gpsListo: 'Done. We will use your location to check the weather of your area.',
  gpsAproximada: (metros: number) =>
    `Your location is approximate (error of about ${Math.round(metros)} meters). Check that the coordinates are those of your field.`,
  buscandoLocalidad: 'Searching for your town…',
  sinCoincidencias: 'We did not find that town. Try another name or type the coordinates.',
  variasCoincidencias: 'We found several places with that name. Pick yours.',
  coincidenciaAproximada: 'This location is approximate: it is the center of the town, not your field.',
  elegida: (nombre: string) => `You chose: ${nombre}.`,
  errorBusqueda: 'We could not search for the town now. Type the coordinates or try again.',
} as const;

/** Origin of the answer to a result question. */
export const RESPUESTA_ORIGEN = {
  local: 'Answer built from the data of your result.',
  ia: 'Explanation written with the help of artificial intelligence, using only the data of your result.',
} as const;

/** Plans saved on this device. */
export const GUARDADO_ESTADO = {
  guardado: 'We saved this plan on your device.',
  quitado: 'We removed the saved plan.',
  error: 'We could not save the plan on your device. Check that your browser allows saving data.',
  abierto: 'We opened the saved plan.',
} as const;

// ---------- Island flow messages ----------

export const BOTON_ENVIAR = { reposo: 'See my plan', enviando: 'Checking your field…' } as const;

export const FLUJO = {
  sinConexion: {
    tono: 'aviso',
    titulo: 'No internet connection',
    explicacion: 'You can keep using the plans and data saved on your device.',
  },
  listoSinRed: {
    tono: 'info',
    titulo: 'Ready to use without internet',
    explicacion: 'This page is already saved on your device.',
  },
  planLocal: {
    tono: 'info',
    titulo: 'Plan calculated on your device',
    explicacion: 'Without internet we use scientific data saved here. It may be less recent than a new query.',
    siguientePaso: 'When internet is back, refresh to see new data.',
  },
  sinDatosLocales: {
    tono: 'sindato',
    titulo: 'No internet and no saved data for your area',
    explicacion: 'We have no saved data for your area to calculate a plan offline.',
    siguientePaso: 'Connect to the internet and try again.',
  },
  sinPlan: {
    tono: 'sindato',
    titulo: 'No option for now',
    explicacion: 'With what we have, we cannot propose this option.',
  },
  mostrandoGuardado: {
    tono: 'info',
    titulo: 'Showing saved data',
    explicacion: 'We keep looking for new data for your field.',
  },
} as const satisfies Record<string, Mensaje>;

/** Plan that comes from the device memory. `edad` is already formatted, e.g. `hace(ms)`. */
export function planGuardado(edad: string): Mensaje {
  return {
    tono: 'info',
    titulo: 'Plan saved on your device',
    explicacion: `This plan was calculated ${edad}.`,
    siguientePaso: 'When internet is available, refresh to see new data.',
  };
}

export const UBICACION_EXTRA = {
  unaCoincidencia: 'We found this place. Confirm it to use it.',
  escribeLocalidad: 'Type the name of your town to search for it.',
} as const;

// ---------- Step-by-step form, footer and sources page ----------

export const PASOS = {
  conteo: (n: number, total: number) => `Step ${n} of ${total}`,
  avance: 'Progress of your answers',
  siguiente: 'Next',
  atras: 'Back',
  pista: 'Answer this question to continue.',
} as const;

/** Step 1: coordinates are typed only if the person asks to. */
export const COORDENADAS_MANUAL = 'Enter coordinates manually';

export const PIE = {
  nombre: 'AgroShift',
  fuentes: 'Scientific sources & AI tools',
  repo: 'Open Source (Apache 2.0) on GitHub',
  navegacion: 'More about AgroShift',
  aviso: 'Decision-support powered by NASA Earth observations — built to complement field inspection and local agronomic expertise.',
  evento: 'NASA Space Apps Challenge Chiclayo 2026',
  equipo: 'Team OneCtrl: Giancarlo Luciano Larios Infantes, Enzo Gabriel García Infantes & Sergio Anibal Tuesta Rodas',
} as const;

/** Header: brand link and the "how it works" dialog. */
export const CABECERA = {
  inicio: 'AgroShift, go to the home page',
  ayuda: 'Help',
  titulo: 'How AgroShift works',
  cerrar: 'Close help',
  entendido: 'Got it',
  pasos: [
    { titulo: '1. Tell us about your field', texto: 'Say where it is and which crop you grow or last harvested.' },
    { titulo: '2. We read NASA data', texto: 'AgroShift reads NASA data on rain, soil moisture and heat for your area.' },
    { titulo: '3. Get your planting plan', texto: 'You get a plain-language plan that compares two planting options.' },
  ],
} as const;

export interface FuenteEnlace {
  nombre: string;
  descripcion: string;
  /** Product and version as published by the source. */
  producto: string;
  enlace: { texto: string; url: string };
}

export const PAGINA_FUENTES = {
  titulo: 'Scientific sources and tools',
  intro: 'AgroShift uses open data from NASA and other public sources. Here is where each piece of data comes from and which tools the app was built with.',
  datos: {
    titulo: 'Scientific data',
    items: [
      {
        nombre: 'NASA POWER',
        descripcion: 'Daily weather of your area: temperature, rain, air humidity and sunlight.',
        producto: 'POWER Daily API, AG community (NASA Langley Research Center)',
        enlace: { texto: 'power.larc.nasa.gov', url: 'https://power.larc.nasa.gov/' },
      },
      {
        nombre: 'NASA SMAP',
        descripcion: 'Soil moisture at the surface and in the root zone.',
        producto: 'SMAP L4 Global 3-hourly 9 km (SPL4SMGP v008), NASA NSIDC DAAC',
        enlace: { texto: 'doi.org/10.5067/T5RUATAQREF8', url: 'https://doi.org/10.5067/T5RUATAQREF8' },
      },
      {
        nombre: 'NASA Giovanni',
        descripcion: 'Air temperature trend of your area, with data from the GLDAS model.',
        producto: 'GLDAS Noah Land Surface Model L4 3-hourly 0.25 deg, version 2.1, NASA GES DISC',
        enlace: { texto: 'doi.org/10.5067/E7TYRXPJKWOQ', url: 'https://doi.org/10.5067/E7TYRXPJKWOQ' },
      },
      {
        nombre: 'NASA FIRMS',
        descripcion: 'Heat detected by satellite near your field, almost in real time.',
        producto: 'VIIRS NOAA-20, near real time',
        enlace: { texto: 'firms.modaps.eosdis.nasa.gov', url: 'https://firms.modaps.eosdis.nasa.gov/' },
      },
    ],
  },
  lugares: {
    titulo: 'Town search',
    items: [
      {
        nombre: 'GeoNames, through Open-Meteo',
        descripcion: 'Names and coordinates of the places you search for. CC BY 4.0 license.',
        producto: 'Open-Meteo Geocoding API, with data from GeoNames',
        enlace: { texto: 'open-meteo.com/en/docs/geocoding-api', url: 'https://open-meteo.com/en/docs/geocoding-api' },
      },
    ],
  },
  herramientas: {
    titulo: 'Tools it was built with',
    items: [
      { nombre: 'Claude Code', descripcion: 'AI assistant that helped write and refactor the code, the tests and the documentation. The team reviewed and ran every change.', producto: 'Claude Code (Anthropic)', enlace: { texto: 'claude.com/product/claude-code', url: 'https://claude.com/product/claude-code' } },
      { nombre: 'ChatGPT', descripcion: 'AI assistant used in early planning: ideas for the concept, comparing NASA datasets and drafting the project description.', producto: 'ChatGPT (OpenAI)', enlace: { texto: 'chatgpt.com', url: 'https://chatgpt.com/' } },
      { nombre: 'Astro', descripcion: 'Fast pages that also work with a weak signal.', producto: 'Astro', enlace: { texto: 'astro.build', url: 'https://astro.build/' } },
      { nombre: 'Tailwind CSS', descripcion: 'Styles of the app.', producto: 'Tailwind CSS', enlace: { texto: 'tailwindcss.com', url: 'https://tailwindcss.com/' } },
      { nombre: 'TypeScript and Zod', descripcion: 'Typed code and validation of incoming data.', producto: 'TypeScript, Zod', enlace: { texto: 'zod.dev', url: 'https://zod.dev/' } },
      { nombre: 'Supabase', descripcion: 'Shared copy of the data and request limits.', producto: 'Supabase', enlace: { texto: 'supabase.com', url: 'https://supabase.com/' } },
      { nombre: 'Amazon Bedrock', descripcion: 'Artificial intelligence help to explain your result, using only the plan data.', producto: 'Amazon Bedrock (AWS)', enlace: { texto: 'aws.amazon.com/bedrock', url: 'https://aws.amazon.com/bedrock/' } },
      { nombre: 'Vercel', descripcion: 'Where the app is published.', producto: 'Vercel', enlace: { texto: 'vercel.com', url: 'https://vercel.com/' } },
    ],
  },
  volver: 'Back to home',
} as const satisfies {
  titulo: string;
  intro: string;
  datos: { titulo: string; items: readonly FuenteEnlace[] };
  lugares: { titulo: string; items: readonly FuenteEnlace[] };
  herramientas: { titulo: string; items: readonly FuenteEnlace[] };
  volver: string;
};

// ---------- Language, pages and fixed interface texts ----------

/** EN | ES switch. `etiqueta` describes the action of each button (screen readers). */
export const IDIOMA = {
  grupo: 'Language',
  en: { corto: 'EN', nombre: 'English', etiqueta: 'EN: switch language to English' },
  es: { corto: 'ES', nombre: 'Español', etiqueta: 'ES: switch language to Spanish' },
} as const;

export const SITIO = {
  saltar: 'Skip to content',
  descripcion: 'AgroShift: compare two planting options for your field.',
  inicio: {
    titulo: 'Plan your next planting',
    intro: 'Answer five questions and compare two options for your field.',
    resultados: 'Your plan for this planting',
    guardados: 'Your saved plans',
    editar: 'Change my answers',
    guardar: 'Save this plan',
    actualizar: 'Refresh with new data',
    ver: 'View',
    quitar: 'Remove',
  },
  fuentes: {
    titulo: 'Scientific sources and tools · AgroShift',
    descripcion: 'Where the AgroShift data comes from and which tools it was built with.',
  },
  sinConexion: {
    titulo: 'Offline · AgroShift',
    descripcion: 'AgroShift offline: what you can do when there is no saved data.',
    encabezado: 'Offline',
    etiqueta: 'No data',
    estadoTitulo: 'No saved data',
    explicacion:
      'You are offline and this device has no copy of what you are looking for. To use AgroShift offline, open it once with internet and wait for the notice that it is ready. A first visit without a connection cannot be opened.',
    siguientePaso: 'Go back home: there you can see the plans you already saved.',
    volver: 'Back to home',
  },
} as const;

export const FORMULARIO_EXTRA = {
  diaSiembra: 'Planting day',
  mesSiembra: 'Planting month',
  mes: 'Month',
  anio: 'Year',
  elegirMes: 'Choose month',
  elegirAnio: 'Choose year',
  meses: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  notaFinal: 'After the result you can add data about your soil and your previous crops.',
  eligeLocalidad: 'Choose your town',
} as const;

export const SECCIONES_PLAN = {
  queFalta: 'What is missing',
  cuandoCambiar: 'When to switch to the other plan',
  porQue: 'Why',
  tenEnCuenta: 'Keep in mind',
  queHacer: 'What to do',
  queRevisar: 'What to check',
  preguntas: 'Questions about your plan',
  alertas: 'Alerts for your area',
} as const;

export const PANEL_FUENTES = {
  resumen: 'Scientific sources used',
  queMide: 'What it measures',
  unidad: 'Unit',
  periodo: 'Period',
  fechaDato: 'Date of the data',
  escala: 'Scale',
  vigencia: 'Validity',
  origen: 'Origin',
  limitaciones: 'Limitations',
  version: (v: string) => `version ${v}`,
  rango: (inicio: string, fin: string) => `${inicio} to ${fin}`,
  vigenteHasta: (fecha: string) => `Valid until ${fecha}`,
  sinVencimiento: 'Saved copy, no expiry date',
  validos: (n: number, total: number) => `Valid data: ${n} of ${total}`,
} as const;

/** Detail added to the fire notice. `km` is already formatted. */
export const detalleFuego = (cantidad: number, km: string) =>
  `Detections in the last 24 hours: ${cantidad}; the nearest, about ${km} km away.`;

export const PLANES_GUARDADOS = {
  tituloError: 'Not saved',
  tituloGuardado: 'Plan saved',
  tituloQuitado: 'Plan removed',
  ver: (etiqueta: string) => `View ${etiqueta}`,
  quitar: (etiqueta: string) => `Remove ${etiqueta}`,
  /** Name of a saved plan: crop · coordinates · date. */
  etiqueta: (cultivo: string | null, lat: number, lon: number, fecha: string) =>
    `${cultivo ?? 'Crop not given'} · ${lat.toFixed(2)}, ${lon.toFixed(2)} · ${fecha}`,
  separadorCultivos: ', then ',
} as const;

/** Optional satellite map in step 1 (Leaflet, loaded only when asked for). */
export const MAPA_PARCELA = {
  abrir: 'Select field on satellite map',
  region: 'Satellite map of your field',
  ayuda: 'Tap the map to mark your field. Mark up to 4 corners to outline it; a fifth tap starts over. You can always type the coordinates instead.',
  mapa: 'Satellite map. Use the arrow keys to move it and the plus and minus keys to zoom.',
  marcarCentro: 'Mark the center of the map',
  limpiar: 'Clear',
  usar: 'Use this location',
  cargando: 'Loading the map…',
  errorCarga: 'The map could not load. Type the coordinates instead.',
  vacio: 'Nothing marked yet.',
  zoomMas: 'Zoom in',
  zoomMenos: 'Zoom out',
  atribucion: 'Imagery: Esri, Maxar, Earthstar Geographics and the GIS User Community',
  centro: (lat: string, lon: string) => `Center marked: ${lat}, ${lon}.`,
  parcela: (n: number, lat: string, lon: string, ha: string) => `Field with ${n} corners marked. Center: ${lat}, ${lon}. About ${ha} hectares.`,
  aplicada: (lat: string, lon: string) => `Location set from the map: ${lat}, ${lon}.`,
} as const;

/** "Climate of your area" card in the results. Values come from NASA POWER and SMAP. */
export const CLIMA_ZONA = {
  titulo: 'Climate of your area',
  intro: 'What NASA satellites and models detect for your area, over a grid cell of several kilometers, not on your exact field.',
  temperatura: 'Average temperature',
  lluvia: 'Rain in a year',
  suelo: 'Water in the soil',
  noDisponible: 'Not available',
  fuente: (nombre: string) => `Source: ${nombre}`,
  fuentes: { power: 'NASA POWER', smap: 'NASA SMAP' },
  periodo: (rango: string) => `Period: ${rango}`,
  grados: (n: string) => `${n} °C`,
  milimetros: (n: string) => `${n} mm`,
  porcentajeSuelo: (n: string) => `${n} % of the soil volume`,
} as const;
