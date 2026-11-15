import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

// Páginas estáticas por defecto; las rutas /api optan por `prerender = false`.
export default defineConfig({
  adapter: vercel(),
  vite: { plugins: [tailwindcss()] },
});
