import { describe, expect, it } from 'vitest';
import { fetchGiovanniWindow, giovanniToken, parseGiovanniCsv } from '../../src/services/nasa/giovanni.ts';

// Servicio real Giovanni in Cloud. Solo con `npm run test:live` y credenciales de Earthdata
// cuya cuenta autorizó la aplicación Giovanni.
const live = Boolean(process.env.EARTHDATA_USERNAME && process.env.EARTHDATA_PASSWORD);

describe.skipIf(!live)('Giovanni in Cloud (en vivo)', () => {
  it('entrega la serie GLDAS de 3 h para la celda de Chiclayo, en kelvin convertido a Celsius', async () => {
    const token = await giovanniToken({ signal: AbortSignal.timeout(60_000) });
    const csv = await fetchGiovanniWindow(-6.77, -79.84, '2025-01-01', '2025-01-02', { token, signal: AbortSignal.timeout(120_000) });
    expect(csv).toContain('prod_name,GLDAS_NOAH025_3H.2.1');
    expect(csv).toContain('unit,K');
    expect(csv).toMatch(/lat,-6\.875\b[\s\S]*lon,-79\.875\b/);
    expect(csv).not.toContain(token);
    const readings = parseGiovanniCsv(csv);
    expect(readings).toHaveLength(16);
    expect(readings[0]?.t).toBe('2025-01-01 00:00');
    for (const r of readings) {
      expect(r.v).not.toBeNull();
      expect(r.v!).toBeGreaterThan(5);
      expect(r.v!).toBeLessThan(45);
    }
  }, 200_000);
});
