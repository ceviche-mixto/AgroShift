import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { LOCAL_SNAPSHOT_URLS } from '../../src/services/browser/local.ts';

// public/sw.js se ejecuta tal cual en node:vm con self/caches/fetch simulados.

const ORIGIN = 'https://agro.test';
const code = readFileSync('public/sw.js', 'utf8');

// ---------- Cache Storage simulado ----------
const abs = (u: string | Request | URL) => new URL(typeof u === 'string' ? u : u instanceof URL ? u.href : u.url, ORIGIN).href;
class FakeCache {
  entries = new Map<string, Response>();
  puts: string[] = [];
  async put(req: string | Request, res: Response) {
    if (!res.ok) throw new TypeError('respuesta no guardable');
    this.puts.push(new URL(abs(req)).pathname);
    this.entries.set(abs(req), res);
  }
  async match(req: string | Request) {
    return this.entries.get(abs(req))?.clone();
  }
}
class FakeCaches {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  names = () => [...this.stores.keys()];
}

// ---------- Sitio simulado ----------
type Site = Record<string, string>;
const dataBodies = Object.fromEntries(LOCAL_SNAPSHOT_URLS.map((u) => [u, JSON.stringify({ u })]));
const baseSite = (tag = 'A'): Site => ({
  '/': `<!doctype html><link rel="stylesheet" href="/_astro/index.${tag}.css"><link rel="icon" href="/favicon.svg"><a href="/offline/">x</a><script type="module" src="/_astro/page.${tag}.js"></script><script type="module">import "/_astro/inline.${tag}.js"</script>`,
  '/offline/': `<!doctype html><link rel="stylesheet" href="/_astro/index.${tag}.css"><h1>Sin conexión</h1>`,
  '/fuentes/': `<!doctype html><link rel="stylesheet" href="/_astro/index.${tag}.css"><h1>Fuentes</h1>`,
  [`/_astro/index.${tag}.css`]: `@font-face{src:url(./font.${tag}.woff2)}`,
  [`/_astro/font.${tag}.woff2`]: 'fuente',
  [`/_astro/page.${tag}.js`]: `import"./chunk.${tag}.js";export const l=()=>import("./lazy.${tag}.js");`,
  [`/_astro/chunk.${tag}.js`]: `import{z}from"./zod.${tag}.js";`,
  [`/_astro/zod.${tag}.js`]: 'export const z={url(e){return e}}',
  [`/_astro/inline.${tag}.js`]: 'export default 1',
  [`/_astro/lazy.${tag}.js`]: `const deps=["_astro/dep.${tag}.js","_astro/extra.${tag}.css"];`,
  [`/_astro/dep.${tag}.js`]: 'export default 2',
  [`/_astro/extra.${tag}.css`]: 'body{}',
  '/favicon.svg': '<svg/>',
  ...dataBodies,
});
const SHELL_FILES = (tag = 'A') =>
  [
    '/',
    '/offline/',
    '/fuentes/',
    '/favicon.svg',
    ...LOCAL_SNAPSHOT_URLS,
    ...['index.%.css', 'font.%.woff2', 'page.%.js', 'chunk.%.js', 'zod.%.js', 'inline.%.js', 'lazy.%.js', 'dep.%.js', 'extra.%.css'].map((f) => `/_astro/${f.replace('%', tag)}`),
  ].sort();

function boot(initial: Site = baseSite()) {
  let site = initial;
  let online = true;
  const handlers: Record<string, (e: any) => void> = {};
  const caches = new FakeCaches();
  const fetched: { path: string; method: string }[] = [];
  const sandbox: Record<string, unknown> = {
    URL,
    Response,
    Request,
    Promise,
    JSON,
    Object,
    Math,
    Date,
    String,
    Error,
    TypeError,
    caches,
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: any) => void) => (handlers[type] = fn),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
    fetch: async (input: string | Request) => {
      const url = new URL(abs(input));
      fetched.push({ path: url.pathname, method: typeof input === 'string' ? 'GET' : input.method });
      if (!online) throw new TypeError('Failed to fetch');
      const body = site[url.pathname];
      return body === undefined ? new Response('no', { status: 404 }) : new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
    },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const dispatch = async (type: string, extra: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    handlers[type]!({ ...extra, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => (responded = p) });
    await Promise.all(waits);
    return responded;
  };
  const request = (path: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}) => {
    const req = new Request(abs(path), { method: init.method ?? 'GET', headers: init.headers });
    return init.mode === 'navigate' ? Object.defineProperty(req, 'mode', { value: 'navigate' }) : req;
  };
  const get = (path: string, init?: Parameters<typeof request>[1]) => dispatch('fetch', { request: request(path, init) });
  const messages: any[] = [];
  const post = (data: unknown) => dispatch('message', { data, source: { postMessage: (m: unknown) => messages.push(m) } });
  const prepare = () => post({ type: 'agroshift:prepare' });
  return {
    sandbox,
    caches,
    fetched,
    messages,
    post,
    get,
    prepare,
    install: () => dispatch('install'),
    activate: () => dispatch('activate'),
    setSite: (s: Site) => (site = s),
    setOnline: (v: boolean) => (online = v),
    deploy: async () => {
      await dispatch('install');
      await dispatch('activate');
    },
  };
}

const text = async (p: Promise<Response | undefined>) => (await p)?.text();

describe('precache', () => {
  it('guarda shell, /offline/, JS/CSS con hash (incluidos imports, dinámicos y mapas), recursos y JSON', async () => {
    const sw = boot();
    await sw.install();
    expect(sw.caches.names()).toHaveLength(1);
    const [name] = sw.caches.names();
    expect(name).toMatch(/^agroshift-[0-9a-f]+$/);
    const cache = sw.caches.stores.get(name!)!;
    const paths = [...cache.entries.keys()].map((u) => new URL(u).pathname).filter((p) => p !== '/__agroshift_manifest__');
    expect(paths.sort()).toEqual(SHELL_FILES());
    expect(sw.sandbox.skipWaiting).toHaveBeenCalled();
    const manifest = await (await cache.match('/__agroshift_manifest__'))!.json();
    expect(manifest.urls.sort()).toEqual(SHELL_FILES());
    expect(manifest.version).toBe(name);
  });

  it('no precarga nada bajo /api/ ni enlaces de otro origen', async () => {
    const site = baseSite();
    site['/'] += '<link rel="preconnect" href="https://fonts.example/"><script src="/api/analyze"></script><link href="/api/explain">';
    const sw = boot(site);
    await sw.install();
    expect(sw.fetched.some((f) => f.path.startsWith('/api'))).toBe(false);
    expect(sw.fetched.every((f) => f.method === 'GET')).toBe(true);
  });

  it('un recurso que falla aborta la instalación (no queda una copia a medias)', async () => {
    const site = baseSite();
    delete site['/_astro/zod.A.js'];
    const sw = boot(site);
    await expect(sw.install()).rejects.toThrow(/zod\.A\.js/);
    expect(sw.caches.names()).toEqual([]);
  });

  it('la lista de JSON del worker coincide con la del cliente', () => {
    for (const u of LOCAL_SNAPSHOT_URLS) expect(code).toContain(`'${u}'`);
  });
});

describe('versión por despliegue y limpieza', () => {
  it('activate borra las agroshift-* obsoletas, conserva las ajenas y reclama los clientes', async () => {
    const sw = boot();
    await sw.caches.open('agroshift-viejo');
    await sw.caches.open('otra-app-v1');
    await sw.deploy();
    expect(sw.caches.names().sort()).toEqual([expect.stringMatching(/^agroshift-[0-9a-f]+$/), 'otra-app-v1'].sort());
    expect((sw.sandbox.clients as any).claim).toHaveBeenCalled();
  });

  it('mismo despliegue → mismo nombre y no reescribe; nuevo despliegue → nombre nuevo y borra el anterior', async () => {
    const sw = boot();
    await sw.deploy();
    const [first] = sw.caches.names();
    const writes = sw.caches.stores.get(first!)!.puts.length;
    await sw.prepare();
    expect(sw.caches.names()).toEqual([first]);
    expect(sw.caches.stores.get(first!)!.puts.length).toBe(writes);

    sw.setSite(baseSite('B')); // nuevos hashes tras un despliegue
    await sw.prepare();
    const names = sw.caches.names();
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe(first);
    expect(sw.messages.at(-1)).toMatchObject({ type: 'agroshift:ready', version: names[0], files: SHELL_FILES('B').length });
  });

  it('cambia la versión si solo cambia un JSON científico', async () => {
    const sw = boot();
    await sw.deploy();
    const [first] = sw.caches.names();
    sw.setSite({ ...baseSite(), '/data/nasa/india.json': '{"nuevo":true}' });
    await sw.prepare();
    expect(sw.caches.names()[0]).not.toBe(first);
  });
});

describe('mensaje prepare', () => {
  it('informa ready solo tras verificar que todo está en Cache Storage', async () => {
    const sw = boot();
    await sw.prepare();
    expect(sw.messages).toHaveLength(1);
    expect(sw.messages[0]).toMatchObject({ type: 'agroshift:ready', files: SHELL_FILES().length });
  });

  it('sin red y con copia completa: ready; con la copia incompleta: error', async () => {
    const sw = boot();
    await sw.deploy();
    sw.setOnline(false);
    await sw.prepare();
    expect(sw.messages.at(-1)).toMatchObject({ type: 'agroshift:ready' });

    const cache = sw.caches.stores.get(sw.caches.names()[0]!)!;
    cache.entries.delete(`${ORIGIN}/_astro/page.A.js`);
    await sw.prepare();
    expect(sw.messages.at(-1)).toMatchObject({ type: 'agroshift:error' });
  });

  it('sin red y sin copia: error', async () => {
    const sw = boot();
    sw.setOnline(false);
    await sw.prepare();
    expect(sw.messages[0]).toMatchObject({ type: 'agroshift:error' });
  });

  it('ignora otros mensajes', async () => {
    const sw = boot();
    await sw.post({ type: 'otra-cosa' });
    await sw.post(null);
    expect(sw.messages).toEqual([]);
    expect(sw.fetched).toEqual([]);
  });
});

describe('ruteo', () => {
  it('nunca intercepta POST, /api/, otro origen, /sw.js ni Range', async () => {
    const sw = boot();
    await sw.deploy();
    expect(await sw.get('/api/analyze', { method: 'POST' })).toBeUndefined();
    expect(await sw.get('/api/analyze')).toBeUndefined();
    expect(await sw.get('/api/explain')).toBeUndefined();
    expect(await sw.get('/sw.js')).toBeUndefined();
    expect(await sw.get('/_astro/page.A.js', { headers: { range: 'bytes=0-9' } })).toBeUndefined();
    expect(await sw.get('/', { method: 'POST', mode: 'navigate' })).toBeUndefined();
    expect(await sw.get('https://otro.test/_astro/x.js')).toBeUndefined();
  });

  it('nada de /api/ ni de POST entra en Cache Storage', async () => {
    const sw = boot();
    await sw.deploy();
    await sw.get('/api/analyze', { method: 'POST' });
    const cache = sw.caches.stores.get(sw.caches.names()[0]!)!;
    expect([...cache.entries.keys()].some((u) => u.includes('/api/'))).toBe(false);
  });

  it('navegación con red: red primero', async () => {
    const sw = boot();
    await sw.deploy();
    sw.setSite({ ...baseSite(), '/': 'html-nuevo' });
    expect(await text(sw.get('/', { mode: 'navigate' }))).toBe('html-nuevo');
  });

  it('navegación sin red: la ruta guardada, luego el shell, luego /offline/', async () => {
    const sw = boot();
    await sw.deploy();
    sw.setOnline(false);
    expect(await text(sw.get('/?x=1', { mode: 'navigate' }))).toContain('page.A.js');
    expect(await text(sw.get('/offline', { mode: 'navigate' }))).toContain('Sin conexión');
    expect(await text(sw.get('/offline/', { mode: 'navigate' }))).toContain('Sin conexión');
    expect(await text(sw.get('/otra/ruta', { mode: 'navigate' }))).toContain('page.A.js');
  });

  it('navegación con 5xx del servidor: usa la copia guardada', async () => {
    const sw = boot();
    await sw.deploy();
    const fetchOriginal = (sw.sandbox as any).fetch;
    (sw.sandbox as any).fetch = async () => new Response('caído', { status: 503 });
    expect(await text(sw.get('/', { mode: 'navigate' }))).toContain('page.A.js');
    (sw.sandbox as any).fetch = fetchOriginal;
  });

  it('sin copia guardada y sin red, la navegación falla como lo haría el navegador', async () => {
    const sw = boot();
    sw.setOnline(false);
    const res = await sw.get('/', { mode: 'navigate' });
    expect(res!.type).toBe('error');
  });

  it('activos con hash: caché primero, sin tocar la red', async () => {
    const sw = boot();
    await sw.deploy();
    const before = sw.fetched.length;
    expect(await text(sw.get('/_astro/page.A.js'))).toContain('chunk.A.js');
    expect(await text(sw.get('/data/nasa/kenia.json'))).toBe(dataBodies['/data/nasa/kenia.json']);
    expect(sw.fetched.length).toBe(before);
    sw.setOnline(false);
    expect(await text(sw.get('/_astro/zod.A.js'))).toBe('export const z={url(e){return e}}');
  });

  it('un activo de /_astro/ que faltaba se completa en línea; otros no se guardan', async () => {
    const sw = boot();
    await sw.deploy();
    sw.setSite({ ...baseSite(), '/_astro/nuevo.Z.js': 'z', '/otro.txt': 'o' });
    expect(await text(sw.get('/_astro/nuevo.Z.js'))).toBe('z');
    expect(await text(sw.get('/otro.txt'))).toBe('o');
    const cache = sw.caches.stores.get(sw.caches.names()[0]!)!;
    expect(cache.entries.has(`${ORIGIN}/_astro/nuevo.Z.js`)).toBe(true);
    expect(cache.entries.has(`${ORIGIN}/otro.txt`)).toBe(false);
  });
});
