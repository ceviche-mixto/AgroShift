// Textos visibles en español. Módulo puro: solo tipos del contrato (se borran al compilar).
// Los metadatos científicos (producto, versión, unidad, resolución) NO van aquí: salen del contrato.
// `en.ts` es su espejo exacto (mismos nombres y misma forma): tests/i18n/mirror.test.ts lo comprueba.
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

// ---------- Tonos de estado (símbolo + etiqueta + borde; el color solo acompaña) ----------

export type Tono = 'info' | 'aviso' | 'alerta' | 'exito' | 'sindato';

/** Clase CSS: `estado estado--${tono}`. El símbolo va en `<span class="estado__simbolo" aria-hidden="true">`. */
export const TONOS: Record<Tono, { simbolo: string; etiqueta: string }> = {
  info: { simbolo: 'ℹ︎', etiqueta: 'Información' },
  aviso: { simbolo: '⚠︎', etiqueta: 'Atención' },
  alerta: { simbolo: '✖︎', etiqueta: 'Alerta' },
  exito: { simbolo: '✔︎', etiqueta: 'Listo' },
  sindato: { simbolo: '?', etiqueta: 'Sin dato' },
};

export interface Mensaje {
  tono: Tono;
  /** Hasta 60 caracteres. */
  titulo: string;
  /** Una frase, hasta 160 caracteres. */
  explicacion: string;
  /** Qué hacer ahora. Solo cuando aplica. */
  siguientePaso?: string;
}

// ---------- Duraciones ----------

const UNIDADES = [
  [86_400, 'día', 'días'],
  [3_600, 'hora', 'horas'],
  [60, 'minuto', 'minutos'],
  [1, 'segundo', 'segundos'],
] as const;

function cantidad(segundos: number): string {
  const [base, uno, varios] = UNIDADES.find(([s]) => segundos >= s) ?? UNIDADES[3];
  const n = Math.floor(segundos / base);
  return `${n} ${n === 1 ? uno : varios}`;
}

/** Edad de un dato: «hace 3 horas», «hace 2 días». Menos de un minuto: «hace un momento». */
export function hace(ms: number): string {
  return ms >= 60_000 ? `hace ${cantidad(Math.floor(ms / 1000))}` : 'hace un momento';
}

/** Espera: «en 40 segundos». Redondea hacia arriba para no pedir reintentar antes de tiempo. */
export function enTiempo(ms: number): string {
  return `en ${cantidad(Math.max(1, Math.ceil(ms / 1000) || 1))}`;
}

// ---------- Los cinco campos ----------

export const CAMPOS = {
  ubicacion: {
    etiqueta: '¿Dónde está tu campo?',
    ayuda: 'Con el lugar vemos el clima y el suelo de tu zona. Usar tu ubicación es opcional.',
    opciones: {
      gps: 'Usar mi ubicación',
      manual_coordinates: 'Escribir coordenadas',
      place_search: 'Buscar mi localidad',
    } satisfies Record<FarmLocation['origin'], string>,
    latitud: 'Latitud',
    longitud: 'Longitud',
    localidad: 'Nombre de tu localidad',
    errorGps: 'No pudimos usar tu ubicación. Escribe las coordenadas o busca tu localidad.',
    error: 'Dinos dónde está tu campo. Usa tu ubicación, escribe las coordenadas o busca tu localidad.',
  },
  cultivo: {
    etiqueta: '¿Qué cultivas o qué cosechaste por última vez?',
    ayuda: 'Lo que había antes en el suelo cambia lo que conviene sembrar después.',
    etapa: {
      current: 'Lo cultivo ahora',
      last_harvested: 'Lo coseché por última vez',
    } satisfies Record<EtapaCultivo, string>,
    nombre: 'Nombre del cultivo',
    rapidas: 'Elige uno de los cultivos más comunes',
    otro: 'Otro cultivo',
    buscadorAyuda: 'Escribe el nombre como lo conoces: entendemos choclo, frejol, papa, tomate…',
    sugerencias: 'Sugerencias de cultivos',
    sugerenciaFamilia: (tipo: string) => `sin ficha propia · ${tipo}`,
    noSe: 'No sé',
    error: 'Escribe el nombre del cultivo o marca «No sé».',
  },
  objetivo: {
    etiqueta: '¿Qué necesitas resolver?',
    ayuda: 'Así te mostramos primero lo que más te importa.',
    opciones: {
      next_crop: '¿Qué puedo sembrar después?',
      save_water: 'Quiero aprovechar mejor el agua',
      care_soil: 'Quiero cuidar mi suelo',
    } satisfies Record<Goal, string>,
    error: 'Elige qué quieres resolver.',
  },
  agua: {
    etiqueta: '¿Cuánta agua tienes para sembrar?',
    ayuda: 'El agua que tienes limita qué cultivos aguantan.',
    opciones: {
      enough: 'Tengo suficiente agua',
      limited: 'Tengo poca agua',
      unknown: 'No estoy seguro',
    } satisfies Record<WaterLevel, string>,
    error: 'Elige cuánta agua tienes o marca «No estoy seguro».',
  },
  siembra: {
    etiqueta: '¿Cuándo piensas sembrar?',
    ayuda: 'La fecha nos dice qué clima te espera en esa época.',
    precision: {
      day: 'Sé el día',
      month: 'Sé solo el mes',
    } satisfies Record<PrecisionSiembra, string>,
    noSe: 'No sé todavía',
    error: 'Escribe una fecha válida o marca «No sé todavía».',
  },
} as const;

const CAMPO_DE_RUTA = {
  location: 'ubicacion',
  crop: 'cultivo',
  goal: 'objetivo',
  water: 'agua',
  planting: 'siembra',
} as const;

/** Mensaje de error de un campo a partir de la ruta del contrato (`issues[].path`, p. ej. `location.lat`). */
export function errorDeCampo(ruta: string): string {
  const campo = CAMPO_DE_RUTA[ruta.split('.')[0] as keyof typeof CAMPO_DE_RUTA];
  return campo ? CAMPOS[campo].error : ESTADOS.entradaInvalida.explicacion;
}

// ---------- Estados de la pantalla ----------

export const ESTADOS = {
  entradaInvalida: {
    tono: 'alerta',
    titulo: 'Revisa tus respuestas',
    explicacion: 'Hay respuestas que no pudimos usar.',
    siguientePaso: 'Corrige los campos marcados y vuelve a intentar.',
  },
  espera: {
    tono: 'info',
    titulo: 'Estamos revisando tu campo',
    explicacion: 'Buscamos datos del clima y del suelo de tu zona.',
    siguientePaso: 'Espera unos segundos y no cierres la página.',
  },
  sinRed: {
    tono: 'aviso',
    titulo: 'No hay conexión a internet',
    explicacion: 'Sin internet no podemos revisar tu campo.',
    siguientePaso: 'Conéctate a internet y vuelve a intentar.',
  },
  sinRedConPlan: {
    tono: 'aviso',
    titulo: 'No hay conexión a internet',
    explicacion: 'Te mostramos el último plan que guardaste.',
    siguientePaso: 'Cuando vuelva el internet, actualiza para ver datos nuevos.',
  },
  planBPendiente: {
    tono: 'sindato',
    titulo: 'Segunda opción pendiente',
    explicacion: 'Aún falta información para darte una segunda opción.',
    siguientePaso: 'Revisa en tu parcela cuánta humedad tiene el suelo y cuánto llovió.',
  },
} as const satisfies Record<string, Mensaje>;

/** Cupo agotado (HTTP 429). `ms` es la espera que indica el servidor. */
export function cupoAgotado(ms: number): Mensaje {
  return {
    tono: 'aviso',
    titulo: 'Demasiadas consultas',
    explicacion: 'Se acabó el cupo de consultas por ahora.',
    siguientePaso: `Inténtalo de nuevo ${enTiempo(ms)}.`,
  };
}

/** Fuente atrasada. `edad` ya viene formateada, p. ej. `hace(ms)`. */
export function fuenteAtrasada(edad: string): Mensaje {
  return {
    tono: 'aviso',
    titulo: 'Dato atrasado',
    explicacion: `Este dato se tomó ${edad}.`,
    siguientePaso: 'Tómalo con cuidado y vuelve a intentar más tarde.',
  };
}

/** Plan B pendiente con lo que hay que revisar (texto ya redactado), o el aviso general. */
export function planBPendiente(queRevisar?: string): Mensaje {
  const base: Mensaje = ESTADOS.planBPendiente;
  return queRevisar ? { ...base, siguientePaso: `Revisa esto: ${queRevisar}` } : base;
}

export const RESULTADO: Record<ResultState, Mensaje> = {
  ok: {
    tono: 'exito',
    titulo: 'Tu plan está listo',
    explicacion: 'Tienes una primera opción y una segunda opción.',
    siguientePaso: 'Lee las dos y elige la que mejor te sirva.',
  },
  partial: {
    tono: 'aviso',
    titulo: 'Tu plan está a medias',
    explicacion: 'Solo tenemos una parte de lo que hace falta.',
    siguientePaso: 'Mira lo que falta antes de decidir.',
  },
  insufficient_evidence: {
    tono: 'sindato',
    titulo: 'Aún no hay datos suficientes',
    explicacion: 'Con lo que tenemos no podemos recomendar un cultivo.',
    siguientePaso: 'Mira lo que falta y vuelve a intentar.',
  },
};

export const ESTADO_FUENTE: Record<SourceState, Mensaje> = {
  available: {
    tono: 'exito',
    titulo: 'Datos al día',
    explicacion: 'Esta fuente respondió bien.',
  },
  partial: {
    tono: 'aviso',
    titulo: 'Datos incompletos',
    explicacion: 'Faltan algunos días o zonas en esta fuente.',
    siguientePaso: 'Toma el resultado con cuidado.',
  },
  stale: {
    tono: 'aviso',
    titulo: 'Dato atrasado',
    explicacion: 'Usamos el último dato guardado.',
    siguientePaso: 'Tómalo con cuidado y vuelve a intentar más tarde.',
  },
  unavailable: {
    tono: 'alerta',
    titulo: 'Fuente sin respuesta',
    explicacion: 'No pudimos consultar esta fuente.',
    siguientePaso: 'Vuelve a intentar más tarde.',
  },
  insufficient_coverage: {
    tono: 'sindato',
    titulo: 'Sin datos en tu zona',
    explicacion: 'Esta fuente no tiene datos suficientes cerca de tu campo.',
    siguientePaso: 'Revisa la humedad del suelo en tu parcela.',
  },
};

/**
 * FIRMS sin respuesta no es una alerta de fuego: un aviso rojo se confundiría con un incendio real.
 * Tono neutro (gris para «no disponible», ámbar suave para «última lectura guardada»).
 */
export const ESTADO_FUENTE_FIRMS: Partial<Record<SourceState, Mensaje>> = {
  unavailable: {
    tono: 'sindato',
    titulo: 'Monitoreo de focos de calor no disponible',
    explicacion: 'Monitoreo satelital de focos de calor temporalmente no disponible (NASA FIRMS).',
    siguientePaso: 'Verifica visualmente quemas cercanas antes de sembrar.',
  },
  stale: {
    tono: 'aviso',
    titulo: 'Última lectura guardada de focos de calor',
    explicacion: 'Usamos la última lectura guardada, con su fecha. No muestra el momento actual.',
    siguientePaso: 'Verifica visualmente quemas cercanas antes de sembrar.',
  },
};

// ---------- Fuentes, evidencia, escenarios ----------

export const FUENTES: Record<Source, string> = {
  power: 'Clima (NASA POWER)',
  smap: 'Humedad del suelo (NASA SMAP)',
  giovanni: 'Tendencia de temperatura (NASA Giovanni)',
  firms: 'Calor detectado por satélite (NASA FIRMS)',
  complement: 'Información de apoyo',
};

export const TIPO_EVIDENCIA: Record<EvidenceKind, string> = {
  observation: 'Dato observado',
  modeled_estimate: 'Estimación de un modelo',
  hypothetical_scenario: 'Supuesto: no es un pronóstico',
  projection: 'Proyección',
};

export const NATURALEZA_ESCENARIO: Record<Scenario['nature'], string> = {
  observed_reference: 'Dato observado',
  hypothetical: 'Supuesto: no es un pronóstico',
  projection: 'Proyección',
};

// ---------- Avisos fijos ----------

export const ALERTA_FUEGO: Mensaje = {
  tono: 'alerta',
  titulo: 'Posible foco de calor cerca',
  explicacion: 'Un satélite detectó calor cerca de tu campo. Esto no confirma que haya un incendio.',
  siguientePaso: 'Mira a tu alrededor y avisa a las autoridades si ves fuego.',
};

export const AVISO_DECISION =
  'Esta herramienta ayuda a decidir. No reemplaza la revisión en tu campo ni la ayuda de un técnico.';

// ---------- Textos dinámicos de la pantalla del formulario y del resultado (Fase 3) ----------

export const ROL_PLAN = { A: 'Plan A', B: 'Plan B' } as const;

/**
 * Títulos del plan y su insignia. La insignia reemplaza a las cajas de aviso por plan:
 * `riego` es una condición de manejo de un plan completo; `falta` solo sale si la persona puede aportar un dato.
 */
export const PLAN_INSIGNIA = {
  riego: 'Requiere riego suplementario',
  falta: 'Falta información',
} as const;
export const PLAN_TITULO = { descanso: 'Descanso con abono verde', porDefinir: 'Cultivo por definir' } as const;

/** De dónde salió el dato de una fuente (slot `origin` de la plantilla `source`). */
export const ORIGEN_DATO: Record<CacheOrigin, string> = {
  live: 'Consultado ahora',
  shared_cache: 'Copia reciente guardada en el servidor',
  stale_snapshot: 'Copia guardada hace tiempo',
  local_snapshot: 'Copia guardada en este dispositivo',
};

/** Ubicación: avisos de la zona `location-status`. `metros` es la precisión que informa el aparato. */
export const UBICACION_ESTADO = {
  buscandoGps: 'Buscando tu ubicación…',
  gpsListo: 'Listo. Usaremos tu ubicación para revisar el clima de tu zona.',
  gpsAproximada: (metros: number) =>
    `Tu ubicación es aproximada (error de unos ${Math.round(metros)} metros). Revisa que las coordenadas sean de tu campo.`,
  buscandoLocalidad: 'Buscando tu localidad…',
  sinCoincidencias: 'No encontramos esa localidad. Prueba con otro nombre o escribe las coordenadas.',
  variasCoincidencias: 'Encontramos varios lugares con ese nombre. Elige el tuyo.',
  coincidenciaAproximada: 'Esta ubicación es aproximada: es el centro de la localidad, no tu campo.',
  elegida: (nombre: string) => `Elegiste: ${nombre}.`,
  errorBusqueda: 'No pudimos buscar la localidad ahora. Escribe las coordenadas o vuelve a intentar.',
} as const;

/** Origen de la respuesta a una pregunta del resultado. */
export const RESPUESTA_ORIGEN = {
  local: 'Respuesta armada con los datos de tu resultado.',
  ia: 'Explicación redactada con ayuda de inteligencia artificial, solo con los datos de tu resultado.',
} as const;

/** Planes guardados en este dispositivo. */
export const GUARDADO_ESTADO = {
  guardado: 'Guardamos este plan en tu dispositivo.',
  quitado: 'Quitamos el plan guardado.',
  error: 'No pudimos guardar el plan en tu dispositivo. Revisa que tu navegador permita guardar datos.',
  abierto: 'Abrimos el plan guardado.',
} as const;

// ---------- Mensajes del flujo de la isla (Fase 3.5) ----------

export const BOTON_ENVIAR = { reposo: 'Ver mi plan', enviando: 'Revisando tu campo…' } as const;

export const FLUJO = {
  sinConexion: {
    tono: 'aviso',
    titulo: 'No hay conexión a internet',
    explicacion: 'Puedes seguir con los planes y datos guardados en tu dispositivo.',
  },
  listoSinRed: {
    tono: 'info',
    titulo: 'Listo para usar sin internet',
    explicacion: 'Esta página ya está guardada en tu dispositivo.',
  },
  planLocal: {
    tono: 'info',
    titulo: 'Plan calculado en tu dispositivo',
    explicacion: 'Sin internet usamos datos científicos guardados aquí. Pueden ser menos recientes que una consulta nueva.',
    siguientePaso: 'Cuando vuelva el internet, actualiza para ver datos nuevos.',
  },
  sinDatosLocales: {
    tono: 'sindato',
    titulo: 'Sin internet y sin datos guardados de tu zona',
    explicacion: 'No tenemos datos guardados de tu zona para calcular un plan sin conexión.',
    siguientePaso: 'Conéctate a internet y vuelve a intentar.',
  },
  sinPlan: {
    tono: 'sindato',
    titulo: 'Sin opción por ahora',
    explicacion: 'Con lo que tenemos no podemos proponer esta opción.',
  },
  mostrandoGuardado: {
    tono: 'info',
    titulo: 'Mostrando datos guardados',
    explicacion: 'Seguimos buscando datos nuevos para tu campo.',
  },
} as const satisfies Record<string, Mensaje>;

/** Plan que viene de la memoria del dispositivo. `edad` ya viene formateada, p. ej. `hace(ms)`. */
export function planGuardado(edad: string): Mensaje {
  return {
    tono: 'info',
    titulo: 'Plan guardado en tu dispositivo',
    explicacion: `Este plan se calculó ${edad}.`,
    siguientePaso: 'Cuando haya internet, actualiza para ver datos nuevos.',
  };
}

export const UBICACION_EXTRA = {
  unaCoincidencia: 'Encontramos este lugar. Confírmalo para usarlo.',
  escribeLocalidad: 'Escribe el nombre de tu localidad para buscarla.',
} as const;

// ---------- Formulario por pasos, pie de página y página de fuentes ----------

export const PASOS = {
  conteo: (n: number, total: number) => `Paso ${n} de ${total}`,
  avance: 'Avance de tus respuestas',
  siguiente: 'Siguiente',
  atras: 'Atrás',
  pista: 'Responde esta pregunta para continuar.',
} as const;

/** Paso 1: las coordenadas se escriben solo si la persona lo pide. */
export const COORDENADAS_MANUAL = 'Ingresar coordenadas manualmente';

export const PIE = {
  nombre: 'AgroShift',
  fuentes: 'Fuentes científicas y herramientas',
  aviso: 'Uso orientativo: AgroShift no reemplaza la revisión en tu campo ni a un técnico agrónomo.',
  evento: 'NASA Space Apps Challenge Chiclayo 2026',
  equipo: 'Equipo OneCtrl: Giancarlo Luciano Larios Infantes, Enzo Gabriel García Infantes y Sergio Anibal Tuesta Rodas',
} as const;

export interface FuenteEnlace {
  nombre: string;
  descripcion: string;
  /** Producto y versión tal como los publica la fuente. */
  producto: string;
  enlace: { texto: string; url: string };
}

export const PAGINA_FUENTES = {
  titulo: 'Fuentes científicas y herramientas',
  intro: 'AgroShift usa datos abiertos de la NASA y de otras fuentes públicas. Aquí está de dónde sale cada dato y con qué herramientas se hizo la aplicación.',
  datos: {
    titulo: 'Datos científicos',
    items: [
      {
        nombre: 'NASA POWER',
        descripcion: 'Clima diario de tu zona: temperatura, lluvia, humedad del aire y luz del sol.',
        producto: 'POWER Daily API, comunidad AG (NASA Langley Research Center)',
        enlace: { texto: 'power.larc.nasa.gov', url: 'https://power.larc.nasa.gov/' },
      },
      {
        nombre: 'NASA SMAP',
        descripcion: 'Humedad del suelo en la superficie y en la zona de las raíces.',
        producto: 'SMAP L4 Global 3-hourly 9 km (SPL4SMGP v008), NASA NSIDC DAAC',
        enlace: { texto: 'doi.org/10.5067/T5RUATAQREF8', url: 'https://doi.org/10.5067/T5RUATAQREF8' },
      },
      {
        nombre: 'NASA Giovanni',
        descripcion: 'Tendencia de la temperatura del aire de tu zona, con datos del modelo GLDAS.',
        producto: 'GLDAS Noah Land Surface Model L4 3-hourly 0.25 deg, versión 2.1, NASA GES DISC',
        enlace: { texto: 'doi.org/10.5067/E7TYRXPJKWOQ', url: 'https://doi.org/10.5067/E7TYRXPJKWOQ' },
      },
      {
        nombre: 'NASA FIRMS',
        descripcion: 'Calor detectado por satélite cerca de tu campo, casi en tiempo real.',
        producto: 'VIIRS NOAA-20, tiempo casi real',
        enlace: { texto: 'firms.modaps.eosdis.nasa.gov', url: 'https://firms.modaps.eosdis.nasa.gov/' },
      },
    ],
  },
  lugares: {
    titulo: 'Búsqueda de localidades',
    items: [
      {
        nombre: 'GeoNames, a través de Open-Meteo',
        descripcion: 'Nombres y coordenadas de los lugares que buscas. Licencia CC BY 4.0.',
        producto: 'Open-Meteo Geocoding API, con datos de GeoNames',
        enlace: { texto: 'open-meteo.com/en/docs/geocoding-api', url: 'https://open-meteo.com/en/docs/geocoding-api' },
      },
    ],
  },
  herramientas: {
    titulo: 'Herramientas con las que se hizo',
    items: [
      { nombre: 'Astro', descripcion: 'Páginas rápidas que funcionan también con poca señal.', producto: 'Astro', enlace: { texto: 'astro.build', url: 'https://astro.build/' } },
      { nombre: 'Tailwind CSS', descripcion: 'Estilos de la aplicación.', producto: 'Tailwind CSS', enlace: { texto: 'tailwindcss.com', url: 'https://tailwindcss.com/' } },
      { nombre: 'TypeScript y Zod', descripcion: 'Código con tipos y revisión de los datos que entran.', producto: 'TypeScript, Zod', enlace: { texto: 'zod.dev', url: 'https://zod.dev/' } },
      { nombre: 'Supabase', descripcion: 'Copia compartida de los datos y control de consultas.', producto: 'Supabase', enlace: { texto: 'supabase.com', url: 'https://supabase.com/' } },
      { nombre: 'Amazon Bedrock', descripcion: 'Ayuda con inteligencia artificial para explicar tu resultado, solo con los datos del plan.', producto: 'Amazon Bedrock (AWS)', enlace: { texto: 'aws.amazon.com/bedrock', url: 'https://aws.amazon.com/bedrock/' } },
      { nombre: 'Vercel', descripcion: 'Donde se publica la aplicación.', producto: 'Vercel', enlace: { texto: 'vercel.com', url: 'https://vercel.com/' } },
    ],
  },
  volver: 'Volver al inicio',
} as const satisfies {
  titulo: string;
  intro: string;
  datos: { titulo: string; items: readonly FuenteEnlace[] };
  lugares: { titulo: string; items: readonly FuenteEnlace[] };
  herramientas: { titulo: string; items: readonly FuenteEnlace[] };
  volver: string;
};

// ---------- Idioma, páginas y textos fijos de la interfaz ----------

/** Selector EN | ES. `etiqueta` describe la acción de cada botón (lectores de pantalla). */
export const IDIOMA = {
  grupo: 'Idioma',
  en: { corto: 'EN', nombre: 'English', etiqueta: 'EN: cambiar el idioma a inglés' },
  es: { corto: 'ES', nombre: 'Español', etiqueta: 'ES: cambiar el idioma a español' },
} as const;

export const SITIO = {
  saltar: 'Saltar al contenido',
  descripcion: 'AgroShift: compara dos opciones de siembra para tu campo.',
  inicio: {
    titulo: 'Planea tu próxima siembra',
    intro: 'Responde cinco preguntas y compara dos opciones para tu campo.',
    resultados: 'Tu plan para esta siembra',
    guardados: 'Tus planes guardados',
    editar: 'Cambiar mis respuestas',
    guardar: 'Guardar este plan',
    actualizar: 'Actualizar con datos nuevos',
    ver: 'Ver',
    quitar: 'Quitar',
  },
  fuentes: {
    titulo: 'Fuentes científicas y herramientas · AgroShift',
    descripcion: 'De dónde salen los datos de AgroShift y con qué herramientas se hizo.',
  },
  sinConexion: {
    titulo: 'Sin conexión · AgroShift',
    descripcion: 'AgroShift sin conexión: qué puedes hacer cuando no hay datos guardados.',
    encabezado: 'Sin conexión',
    etiqueta: 'Sin dato',
    estadoTitulo: 'No hay datos guardados',
    explicacion:
      'Estás sin conexión y este dispositivo no tiene una copia de lo que buscas. Para usar AgroShift sin conexión, ábrelo una vez con internet y espera el aviso de que quedó listo. Una primera visita sin red no se puede abrir.',
    siguientePaso: 'Vuelve al inicio: ahí puedes ver los planes que ya guardaste.',
    volver: 'Volver al inicio',
  },
} as const;

export const FORMULARIO_EXTRA = {
  diaSiembra: 'Día de siembra',
  mesSiembra: 'Mes de siembra',
  ayudaMes: 'Si no ves un calendario, escribe el año y el mes así: 2027-06.',
  notaFinal: 'Después del resultado podrás sumar datos de tu suelo y de tus cultivos anteriores.',
  eligeLocalidad: 'Elige tu localidad',
} as const;

export const SECCIONES_PLAN = {
  queFalta: 'Qué falta',
  cuandoCambiar: 'Cuándo cambiar al otro plan',
  porQue: 'Por qué',
  tenEnCuenta: 'Ten en cuenta',
  queHacer: 'Qué hacer',
  queRevisar: 'Qué revisar',
  preguntas: 'Preguntas sobre tu plan',
  alertas: 'Alertas de tu zona',
} as const;

export const PANEL_FUENTES = {
  resumen: 'Fuentes Científicas Utilizadas',
  queMide: 'Qué mide',
  unidad: 'Unidad',
  periodo: 'Periodo',
  fechaDato: 'Fecha del dato',
  escala: 'Escala',
  vigencia: 'Vigencia',
  origen: 'Origen',
  limitaciones: 'Limitaciones',
  version: (v: string) => `versión ${v}`,
  rango: (inicio: string, fin: string) => `${inicio} a ${fin}`,
  vigenteHasta: (fecha: string) => `Vigente hasta ${fecha}`,
  sinVencimiento: 'Copia guardada, sin fecha de vencimiento',
  validos: (n: number, total: number) => `Datos válidos: ${n} de ${total}`,
} as const;

/** Detalle que se suma al aviso de fuego. `km` ya viene formateado. */
export const detalleFuego = (cantidad: number, km: string) =>
  `Detecciones en las últimas 24 horas: ${cantidad}; la más cercana, a unos ${km} km.`;

export const PLANES_GUARDADOS = {
  tituloError: 'No se guardó',
  tituloGuardado: 'Plan guardado',
  tituloQuitado: 'Plan quitado',
  ver: (etiqueta: string) => `Ver ${etiqueta}`,
  quitar: (etiqueta: string) => `Quitar ${etiqueta}`,
  /** Nombre de un plan guardado: cultivo · coordenadas · fecha. */
  etiqueta: (cultivo: string | null, lat: number, lon: number, fecha: string) =>
    `${cultivo ?? 'Cultivo sin indicar'} · ${lat.toFixed(2)}, ${lon.toFixed(2)} · ${fecha}`,
  separadorCultivos: ', luego ',
} as const;
