// Textos visibles en español. Módulo puro: solo tipos del contrato (se borran al compilar).
// Los metadatos científicos (producto, versión, unidad, resolución) NO van aquí: salen del contrato.
import type {
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
