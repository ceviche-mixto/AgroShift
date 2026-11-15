import { describe, expect, it } from 'vitest';
import { fetchPower, POWER_VARIABLES } from '../../src/services/nasa/power.ts';

// POWER es público, pero se ejecuta solo con `npm run test:live` (que carga .env) para que `npm test` sea hermético.
const live = Boolean(process.env.NASA_API_KEY);

describe.skipIf(!live)('NASA POWER (en vivo)', () => {
  it('Chiclayo 2025: seis variables con unidades verificadas y 365 días', async () => {
    const { records } = await fetchPower(
      { lat: -6.77, lon: -79.84, window: { start: '2025-01-01', end: '2025-12-31' } },
      { signal: AbortSignal.timeout(30_000) },
    );
    expect(records.map((r) => r.variable)).toEqual([...POWER_VARIABLES]);
    const units = Object.fromEntries(records.map((r) => [r.variable, r.unit]));
    expect(units).toEqual({ PRECTOTCORR: 'mm/day', T2M: 'C', T2M_MIN: 'C', T2M_MAX: 'C', RH2M: '%', ALLSKY_SFC_SW_DWN: 'MJ/m^2/day' });
    for (const r of records) {
      expect(r.coverage.expectedCount).toBe(365);
      expect(r.data.type === 'series' && r.data.points.every((p) => p.v === null || p.v > -999)).toBe(true);
    }
  }, 40_000);

  it('el relleno de los días recientes llega como null', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { records } = await fetchPower({ lat: -6.77, lon: -79.84, window: { start: today, end: today } });
    const solar = records.find((r) => r.variable === 'ALLSKY_SFC_SW_DWN');
    expect(solar?.data.type === 'series' && solar.data.points.map((p) => p.v)).toEqual([null]);
    expect(solar?.coverage.status).toBe('none');
  }, 40_000);
});
