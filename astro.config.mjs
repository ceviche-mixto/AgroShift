import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

// En desarrollo carga .env en process.env para el código de servidor (src/services/env.ts).
// En Vercel no existe el archivo y las variables llegan del proyecto.
try {
  process.loadEnvFile();
} catch {}

// Páginas estáticas por defecto; las rutas /api optan por `prerender = false`.
export default defineConfig({
  adapter: vercel(),
  vite: { plugins: [tailwindcss()] },
});
