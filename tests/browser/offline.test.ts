import { afterEach, describe, expect, it, vi } from 'vitest';
import { MSG_ERROR, MSG_PREPARE, MSG_READY, registerOffline, type OfflineState } from '../../src/services/browser/offline.ts';

/** navigator.serviceWorker simulado: el worker responde a `prepare` cuando el test lo decide. */
function fakeSw(opts: { registerError?: boolean } = {}) {
  const target = new EventTarget();
  const posted: unknown[] = [];
  const active = { postMessage: (m: unknown) => void posted.push(m) };
  const sw = Object.assign(target, {
    register: vi.fn(async () => {
      if (opts.registerError) throw new Error('SecurityError');
      return {};
    }),
    ready: Promise.resolve({ active }),
    controller: null,
  });
  const reply = (data: unknown) => target.dispatchEvent(Object.assign(new Event('message'), { data }));
  return { sw, posted, reply };
}

const run = async (deps: Parameters<typeof registerOffline>[1]) => {
  const states: OfflineState[] = [];
  const stop = await registerOffline((s) => states.push(s), deps);
  return { states, stop };
};

afterEach(() => vi.useRealTimers());

describe('registerOffline', () => {
  it('sin API de service worker: unsupported, sin lanzar', async () => {
    expect((await run({ navigator: {}, isSecureContext: true })).states).toEqual(['unsupported']);
  });

  it('sin contexto seguro: unsupported y no registra', async () => {
    const f = fakeSw();
    expect((await run({ navigator: { serviceWorker: f.sw as never }, isSecureContext: false })).states).toEqual(['unsupported']);
    expect(f.sw.register).not.toHaveBeenCalled();
  });

  it('registra /sw.js, pide preparar y solo informa ready cuando el worker confirma', async () => {
    const f = fakeSw();
    const { states } = await run({ navigator: { serviceWorker: f.sw as never }, isSecureContext: true });
    expect(f.sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(f.posted).toEqual([{ type: MSG_PREPARE }]);
    expect(states).toEqual(['preparing']); // registrado y activo no basta
    f.reply({ type: 'otra-cosa' });
    expect(states).toEqual(['preparing']);
    f.reply({ type: MSG_READY, version: 'agroshift-1', files: 9 });
    expect(states).toEqual(['preparing', 'ready']);
    f.reply({ type: MSG_READY });
    expect(states).toEqual(['preparing', 'ready']); // sin duplicados
  });

  it('el worker informa un fallo: error', async () => {
    const f = fakeSw();
    const { states } = await run({ navigator: { serviceWorker: f.sw as never }, isSecureContext: true });
    f.reply({ type: MSG_ERROR, message: 'No se pudo guardar /_astro/x.js (404)' });
    expect(states).toEqual(['preparing', 'error']);
  });

  it('el registro rechazado: error, sin lanzar', async () => {
    const f = fakeSw({ registerError: true });
    expect((await run({ navigator: { serviceWorker: f.sw as never }, isSecureContext: true })).states).toEqual(['preparing', 'error']);
  });

  it('sin respuesta del worker en el plazo: error; si responde después pasa a ready', async () => {
    vi.useFakeTimers();
    const f = fakeSw();
    const { states } = await run({ navigator: { serviceWorker: f.sw as never }, isSecureContext: true, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states).toEqual(['preparing', 'error']);
    f.reply({ type: MSG_READY });
    expect(states).toEqual(['preparing', 'error', 'ready']);
  });

  it('la función devuelta deja de escuchar', async () => {
    const f = fakeSw();
    const { states, stop } = await run({ navigator: { serviceWorker: f.sw as never }, isSecureContext: true });
    stop();
    f.reply({ type: MSG_READY });
    expect(states).toEqual(['preparing']);
  });
});
