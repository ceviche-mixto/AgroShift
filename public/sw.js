/* AgroShift service worker (JS plano, sin build).
 *
 * Lista y versión: en `install` y a cada mensaje `agroshift:prepare` el worker descarga `/` y
 * `/offline/`, extrae de su HTML las URLs de `<link>`/`<script>` y todo `/_astro/*`, sigue
 * recursivamente los imports (`./x.js`, `url(...)`, mapas de dependencias de Vite) de cada JS/CSS y
 * añade los JSON de /data/nasa/. La caché se llama `agroshift-<hash>`: el hash cubre ambos HTML, la
 * lista de URLs y el contenido de los JSON, así que cambia en cada despliegue. Un manifiesto (que se
 * escribe al final) marca la caché como completa; las demás `agroshift-*` se borran.
 * Como /sw.js no cambia entre despliegues, el cliente reenvía `prepare` en cada carga.
 *
 * Nunca se cachea nada que no sea GET, nada bajo /api/ ni respuestas redirigidas o con error.
 */
var PREFIX = 'agroshift-';
var MANIFEST = '/__agroshift_manifest__';
var ROOTS = ['/', '/offline/'];
var DATA = ['/data/nasa/chiclayo.json', '/data/nasa/india.json', '/data/nasa/kenia.json'];
var MAX_FILES = 300;
var NAVIGATION_FALLBACK_STATUS = 500;

var current = null; // nombre de la caché vigente (se resuelve perezosamente)
var preparing = null; // un solo `prepare` a la vez

/* ---------- URLs ---------- */

function sameOriginPath(spec, base) {
  try {
    var u = new URL(spec, base);
    if (u.origin !== self.location.origin) return null;
    if (u.pathname === '/api' || u.pathname.indexOf('/api/') === 0) return null;
    return u.pathname;
  } catch (e) {
    return null;
  }
}

/** URLs de recursos que declara un HTML: link/script con ruta absoluta y todo lo que cuelgue de /_astro/. */
function extractFromHtml(html, base) {
  var found = {};
  var tag = /<(?:link|script)\b[^>]*?\b(?:href|src)=["']([^"']+)["']/gi;
  var m;
  while ((m = tag.exec(html))) {
    var p = sameOriginPath(m[1], base);
    if (p && p !== '/' && p.slice(-1) !== '/') found[p] = true;
  }
  var astro = /\/_astro\/[A-Za-z0-9._\-\/]+/g;
  while ((m = astro.exec(html))) found[m[0]] = true;
  return Object.keys(found);
}

/** Dependencias de un JS/CSS: imports relativos, rutas /_astro/ absolutas, mapas de Vite y url(). */
function extractFromAsset(text, assetUrl) {
  var found = {};
  var m;
  var rel = /["'`]((?:\.{1,2}\/)[A-Za-z0-9._\-\/]+\.(?:m?js|css|woff2?|ttf|otf|svg|png|jpe?g|webp|avif|gif|ico|json|wasm))["'`]/g;
  while ((m = rel.exec(text))) {
    var p = sameOriginPath(m[1], assetUrl);
    if (p) found[p] = true;
  }
  // url() solo en CSS: en JS aparece como método (p. ej. `url(e){...}` de Zod)
  var cssUrl = /url\(\s*["']?([^"')\s]+)["']?\s*\)/g;
  while (/\.css$/.test(assetUrl) && (m = cssUrl.exec(text))) {
    if (/^(?:data:|#)/.test(m[1])) continue;
    var q = sameOriginPath(m[1], assetUrl);
    if (q && q.slice(-1) !== '/') found[q] = true;
  }
  var abs = /\/_astro\/[A-Za-z0-9._\-\/]+/g;
  while ((m = abs.exec(text))) found[m[0]] = true;
  var vite = /["'`](_astro\/[A-Za-z0-9._\-\/]+\.(?:m?js|css))["'`]/g; // __vite__mapDeps
  while ((m = vite.exec(text))) found['/' + m[1]] = true;
  return Object.keys(found);
}

function isTextAsset(path) {
  return /\.(?:m?js|css)$/.test(path);
}

/** Hash no criptográfico (cyrb53) para versionar la caché. */
function hashOf(text) {
  var h1 = 0xdeadbeef;
  var h2 = 0x41c6ce57;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/* ---------- Prepare (precache + verificación) ---------- */

async function fetchOk(path, fresh) {
  var res = await fetch(path, fresh ? { cache: 'no-cache' } : undefined);
  // Una respuesta redirigida o con error no sirve como copia local del recurso
  if (!res.ok || res.redirected) throw new Error('No se pudo guardar ' + path + ' (' + res.status + ')');
  return res;
}

/** Descarga shell, JS/CSS con hash y JSON. Devuelve { responses: {path: Response}, pages: [html], data: [texto] }. */
async function collect() {
  var responses = {};
  var pages = [];
  var queue = [];
  var seen = {};
  function enqueue(p) {
    if (!seen[p]) {
      seen[p] = true;
      queue.push(p);
    }
  }
  for (var i = 0; i < ROOTS.length; i++) {
    var res = await fetchOk(ROOTS[i], true);
    var html = await res.clone().text();
    pages.push(html);
    responses[ROOTS[i]] = res;
    seen[ROOTS[i]] = true;
    extractFromHtml(html, self.location.origin + ROOTS[i]).forEach(enqueue);
  }
  DATA.forEach(enqueue);
  var data = [];
  while (queue.length) {
    if (Object.keys(responses).length > MAX_FILES) throw new Error('Demasiados recursos');
    var path = queue.shift();
    var r = await fetchOk(path, DATA.indexOf(path) >= 0);
    if (isTextAsset(path)) {
      var text = await r.clone().text();
      extractFromAsset(text, self.location.origin + path).forEach(enqueue);
    } else if (DATA.indexOf(path) >= 0) {
      data.push(await r.clone().text());
    }
    responses[path] = r;
  }
  return { responses: responses, pages: pages, data: data };
}

async function readManifest(cache) {
  try {
    var res = await cache.match(MANIFEST);
    return res ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

/** Manifiesto de una caché si TODAS sus URLs están guardadas; si no, null. */
async function verify(cache) {
  var manifest = await readManifest(cache);
  if (!manifest || !manifest.urls) return null;
  for (var i = 0; i < manifest.urls.length; i++) {
    if (!(await cache.match(manifest.urls[i]))) return null;
  }
  return manifest;
}

/** Caché `agroshift-*` completa más reciente (manifiesto verificado), o null. */
async function latestComplete() {
  var names = (await caches.keys()).filter(function (n) {
    return n.indexOf(PREFIX) === 0;
  });
  var best = null;
  for (var i = 0; i < names.length; i++) {
    var cache = await caches.open(names[i]);
    var manifest = await verify(cache);
    if (manifest && (!best || manifest.at > best.manifest.at)) best = { name: names[i], manifest: manifest };
  }
  return best;
}

async function dropOthers(keep) {
  var names = await caches.keys();
  await Promise.all(
    names
      .filter(function (n) {
        return n.indexOf(PREFIX) === 0 && n !== keep;
      })
      .map(function (n) {
        return caches.delete(n);
      }),
  );
  if (current !== keep) current = keep;
}

async function prepare() {
  var got = await collect();
  var urls = Object.keys(got.responses).sort();
  var name = PREFIX + hashOf(got.pages.join('\u0000') + '\u0000' + urls.join('\n') + '\u0000' + got.data.join('\u0000'));
  var cache = await caches.open(name);
  var manifest = await verify(cache);
  if (!manifest) {
    for (var i = 0; i < urls.length; i++) await cache.put(urls[i], got.responses[urls[i]]);
    manifest = { version: name, urls: urls, at: Date.now() };
    // El manifiesto va al final: sin él la caché se considera incompleta
    await cache.put(MANIFEST, new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } }));
    manifest = await verify(cache);
    if (!manifest) throw new Error('La copia local quedó incompleta');
  }
  await dropOthers(name);
  return manifest;
}

function prepareOnce() {
  if (!preparing) {
    preparing = prepare().then(
      function (m) {
        preparing = null;
        return m;
      },
      function (e) {
        preparing = null;
        throw e;
      },
    );
  }
  return preparing;
}

async function readyMessage() {
  var manifest;
  try {
    manifest = await prepareOnce();
  } catch (e) {
    // Sin red: vale la copia anterior si sigue completa
    var latest = await latestComplete();
    if (!latest) return { type: 'agroshift:error', message: String((e && e.message) || e) };
    manifest = latest.manifest;
    current = latest.name;
  }
  return { type: 'agroshift:ready', version: manifest.version, files: manifest.urls.length };
}

/* ---------- Ciclo de vida ---------- */

self.addEventListener('install', function (event) {
  event.waitUntil(
    prepareOnce().then(function () {
      return self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      var latest = await latestComplete();
      // Sin ninguna completa se borran todas (restos de instalaciones fallidas)
      await dropOthers(latest ? latest.name : '');
      current = latest ? latest.name : null;
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', function (event) {
  if (!event.data || event.data.type !== 'agroshift:prepare') return;
  var source = event.source;
  event.waitUntil(
    readyMessage().then(function (msg) {
      if (source && source.postMessage) source.postMessage(msg);
    }),
  );
});

/* ---------- Ruteo ---------- */

async function currentCache() {
  if (!current) {
    var latest = await latestComplete();
    current = latest ? latest.name : null;
  }
  return current ? caches.open(current) : null;
}

/** Variantes de la ruta con y sin barra final. */
function pathVariants(pathname) {
  var alt = pathname.slice(-1) === '/' ? pathname.slice(0, -1) || '/' : pathname + '/';
  return [pathname, alt];
}

async function fromCache(pathnames) {
  var cache = await currentCache();
  if (!cache) return undefined;
  for (var i = 0; i < pathnames.length; i++) {
    var hit = await cache.match(pathnames[i]);
    if (hit) return hit;
  }
  return undefined;
}

/** Sin red: la propia ruta si está guardada, luego el shell `/`, luego `/offline/`. */
async function offlineNavigation(url) {
  return (await fromCache(pathVariants(url.pathname).concat(['/', '/offline/']))) || Response.error();
}

async function navigate(request, url) {
  try {
    var res = await fetch(request);
    if (res.status < NAVIGATION_FALLBACK_STATUS) return res;
    var fallback = await fromCache(pathVariants(url.pathname).concat(['/', '/offline/']));
    return fallback || res;
  } catch (e) {
    return offlineNavigation(url);
  }
}

/** Recursos estáticos: copia local primero; solo lo que cuelga de /_astro/ (inmutable por hash) se completa en línea. */
async function cacheFirst(request, url) {
  var hit = await fromCache([url.pathname]);
  if (hit) return hit;
  var res = await fetch(request);
  if (res.ok && !res.redirected && url.pathname.indexOf('/_astro/') === 0) {
    var cache = await currentCache();
    if (cache) await cache.put(url.pathname, res.clone());
  }
  return res;
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  // Solo GET: los POST (y cualquier cuerpo privado) nunca pasan por Cache Storage
  if (request.method !== 'GET' || request.headers.get('range')) return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.indexOf('/api/') === 0) return;
  if (url.pathname === '/sw.js') return;
  if (request.mode === 'navigate') event.respondWith(navigate(request, url));
  else event.respondWith(cacheFirst(request, url));
});
