import { defineConfig } from 'vitest/config';

// Las pruebas de extremo a extremo (Playwright) tienen su propio comando: npm run test:e2e.
export default defineConfig({ test: { exclude: ['**/node_modules/**', 'tests/e2e/**'] } });
