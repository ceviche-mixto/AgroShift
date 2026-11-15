import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchText, parseRetryAfter, redact } from '../../src/services/nasa/fetch.ts';

const ok = (body = 'ok') => new Response(body, { status: 200 });
/** Espera el rechazo y devuelve el error. */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('no falló');
    },
    (e: Error) => e,
  );
const status = (code: number, headers: Record<string, string> = {}) => new Response('x', { status: code, headers });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('fetchText', () => {
  it('reintenta una vez un 5xx con backoff y jitter', async () => {
    const f = vi.fn().mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok('dato'));
    const p = fetchText('https://x.test/', { fetch: f, random: () => 0 });
    await vi.advanceTimersByTimeAsync(149);
    expect(f).toHaveBeenCalledTimes(1); // backoff = 300 * 2^0 * 0.5 = 150 ms
    await vi.advanceTimersByTimeAsync(2);
    await expect(p).resolves.toBe('dato');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('no reintenta más de una vez ni errores no transitorios', async () => {
    const f = vi.fn().mockResolvedValue(status(500));
    const p = fetchText('https://x.test/', { fetch: f, random: () => 0 });
    const caught = failure(p);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await caught).message).toBe('HTTP 500');
    expect(f).toHaveBeenCalledTimes(2);

    const g = vi.fn().mockResolvedValue(status(404));
    await expect(fetchText('https://x.test/', { fetch: g })).rejects.toThrow('HTTP 404');
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('respeta Retry-After si cabe en el plazo y no reintenta si no cabe', async () => {
    const f = vi.fn().mockResolvedValueOnce(status(429, { 'retry-after': '2' })).mockResolvedValueOnce(ok());
    const p = fetchText('https://x.test/', { fetch: f, deadlineAt: Date.now() + 6000 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(p).resolves.toBe('ok');

    const h = vi.fn().mockResolvedValue(status(429, { 'retry-after': '30' }));
    await expect(fetchText('https://x.test/', { fetch: h, deadlineAt: Date.now() + 6000 })).rejects.toThrow('HTTP 429');
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('AbortController corta el backoff y la petición', async () => {
    const ac = new AbortController();
    const f = vi.fn().mockResolvedValue(status(503));
    const p = fetchText('https://x.test/', { fetch: f, signal: ac.signal, random: () => 1 });
    const caught = failure(p);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    expect((await caught).name).toBe('AbortError');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('errores de red no filtran la URL ni los secretos', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('fetch failed https://x.test/SECRET123/area'));
    const caught = failure(fetchText('https://x.test/SECRET123/area', { fetch: f, secrets: ['SECRET123'], random: () => 0 }));
    await vi.advanceTimersByTimeAsync(5000);
    const e = await caught;
    expect(e.message).toBe('Fallo de red');
    expect(JSON.stringify(e)).not.toContain('SECRET123');
  });
});

describe('utilidades', () => {
  it('parseRetryAfter acepta segundos y fechas HTTP', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('basura')).toBeNull();
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
  });
  it('redact', () => expect(redact('a SECRET b SECRET', ['SECRET', undefined])).toBe('a *** b ***'));
});
