// Registro del service worker (public/sw.js). Informa `ready` SOLO cuando el worker confirma que
// el shell, el JS/CSS con hash y los JSON científicos están guardados y verificados en Cache Storage.
// Sin API disponible degrada sin lanzar. Sin dependencias de Supabase, NASA ni Bedrock.

export type OfflineState = 'unsupported' | 'preparing' | 'ready' | 'error';

export const SW_URL = '/sw.js';
export const MSG_PREPARE = 'agroshift:prepare';
export const MSG_READY = 'agroshift:ready';
export const MSG_ERROR = 'agroshift:error';
/** Si el worker no responde en este plazo (descarga muy lenta) se informa `error`. */
export const PREPARE_TIMEOUT_MS = 60_000;

export interface OfflineDeps {
  navigator?: Pick<Navigator, 'serviceWorker'> | { serviceWorker?: undefined };
  isSecureContext?: boolean;
  timeoutMs?: number;
}

/**
 * Registra el worker y avisa cada cambio de estado. Devuelve una función que deja de escuchar.
 * Requiere contexto seguro (HTTPS; `localhost` cuenta).
 */
export async function registerOffline(onState: (state: OfflineState) => void, deps: OfflineDeps = {}): Promise<() => void> {
  const nav = deps.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator);
  const secure = deps.isSecureContext ?? (typeof isSecureContext === 'undefined' ? false : isSecureContext);
  const sw = nav?.serviceWorker;
  if (!sw || !secure) {
    onState('unsupported');
    return () => {};
  }

  let last: OfflineState | null = null;
  const report = (state: OfflineState) => {
    if (state === last) return;
    last = state;
    if (state === 'ready') clearTimeout(timer);
    onState(state);
  };
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === MSG_READY) report('ready');
    else if (event.data?.type === MSG_ERROR) report('error');
  };
  const timer = setTimeout(() => last === 'preparing' && report('error'), deps.timeoutMs ?? PREPARE_TIMEOUT_MS);
  const stop = () => {
    clearTimeout(timer);
    sw.removeEventListener('message', onMessage);
  };

  report('preparing');
  sw.addEventListener('message', onMessage);
  try {
    await sw.register(SW_URL, { scope: '/' });
    const ready = await sw.ready; // registro con worker activo
    // Cada carga pide al worker que compruebe que su copia corresponde al despliegue actual
    (ready.active ?? sw.controller)?.postMessage({ type: MSG_PREPARE });
  } catch {
    stop();
    report('error');
    return () => {};
  }
  return stop;
}
