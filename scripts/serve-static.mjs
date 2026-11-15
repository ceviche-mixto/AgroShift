// Sirve la salida estática del build (.vercel/output/static) para las pruebas e2e.
// Rutas como Vercel: "/" y "/offline/" resuelven a su index.html, sin redirecciones.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = normalize(join(process.cwd(), '.vercel/output/static'));
const PORT = Number(process.env.PORT ?? 4373);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
  try {
    if (!file.startsWith(ROOT)) throw new Error('fuera de la raíz');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('No encontrado');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
