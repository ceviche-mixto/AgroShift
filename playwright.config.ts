import { defineConfig } from '@playwright/test';

// Usa el Edge instalado (sin descargar navegadores). `npm run test:e2e` construye antes y sirve
// la salida estática: el service worker se prueba como en producción (localhost cuenta como seguro).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4373', channel: 'msedge', locale: 'es-PE', timezoneId: 'America/Lima' },
  webServer: { command: 'node scripts/serve-static.mjs', url: 'http://localhost:4373/', reuseExistingServer: !process.env.CI },
});
