/**
 * Lee una variable de servidor en tiempo de ejecución desde `process.env`.
 * Vale igual en Astro, Vercel, Vitest y scripts, y evita incrustar secretos en el build.
 * En desarrollo `astro.config.mjs` carga `.env` en `process.env`.
 */
export function serverEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}
