// Utilidad compartida de red para los proveedores NASA. Solo servidor.
// Un reintento transitorio con backoff exponencial y jitter, `Retry-After` si cabe en el plazo,
// y corte inmediato con `AbortSignal`. Los errores nunca incluyen la URL ni secretos.

export class HttpError extends Error {
  status: number;
  /** `Retry-After` del proveedor en ms, si lo envió. */
  retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface FetchOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Instante (ms epoch) en que vence el plazo. Un reintento que no cabe antes de él no se hace. */
  deadlineAt?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Valores que no deben aparecer en ningún mensaje de error. */
  secrets?: (string | undefined)[];
  random?: () => number;
}

const BACKOFF_MS = 300;
const MAX_RETRY_AFTER_MS = 10_000;

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const abortError = () => Object.assign(new Error('Solicitud cancelada por plazo'), { name: 'AbortError' });

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const isTransient = (e: unknown) =>
  e instanceof HttpError ? e.status === 408 || e.status === 429 || e.status >= 500 : e instanceof TypeError;

export function redact(text: string, secrets: (string | undefined)[] = []): string {
  return secrets.reduce<string>((acc, s) => (s ? acc.split(s).join('***') : acc), text);
}

/** GET (o el método indicado) con plazo y reintento. Devuelve el cuerpo como texto. */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const random = opts.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await doFetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        signal: opts.signal,
      });
      if (!res.ok) throw new HttpError(res.status, parseRetryAfter(res.headers.get('retry-after')));
      return await res.text();
    } catch (e) {
      if (opts.signal?.aborted) throw abortError();
      const delay =
        (e instanceof HttpError ? e.retryAfterMs : null) ?? BACKOFF_MS * 2 ** attempt * (0.5 + random());
      const fits =
        delay <= (opts.deadlineAt === undefined ? MAX_RETRY_AFTER_MS : opts.deadlineAt - Date.now());
      if (attempt >= 1 || !isTransient(e) || !fits) {
        throw new Error(redact(e instanceof HttpError ? e.message : 'Fallo de red', opts.secrets));
      }
      await sleep(delay, opts.signal);
    }
  }
}

export async function fetchJson(url: string, opts: FetchOptions = {}): Promise<unknown> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Respuesta no es JSON');
  }
}
