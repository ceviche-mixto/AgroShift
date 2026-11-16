import { describe, expect, it } from 'vitest';
import type { EvidenceRecord } from '../../src/domain/contracts.ts';
import { climateSummary } from '../../src/domain/climate-summary.ts';

const MONTHS = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`);

function rec(source: 'power' | 'smap', variable: string, unit: string, points: { t: string; v: number | null }[], period = { start: '2025-01-01', end: '2025-12-31' }): EvidenceRecord {
  return { id: `${source}:${variable}:cell:${period.start}:${period.end}`, source, unit, period, data: { type: 'series', step: points[0]?.t.length === 7 ? 'month' : 'day', points } } as unknown as EvidenceRecord;
}

describe('climateSummary', () => {
  it('sin registros todo es null', () => {
    expect(climateSummary([])).toEqual({ meanTempC: null, annualRainMm: null, soilMoisture: null });
  });

  it('temperatura, lluvia anual y humedad desde series mensuales', () => {
    const s = climateSummary([
      rec('power', 'T2M', 'C', MONTHS.map((t) => ({ t, v: 20 }))),
      rec('power', 'PRECTOTCORR', 'mm/day', MONTHS.map((t) => ({ t, v: 2 }))), // 2 mm/día x 365 días
      rec('smap', 'sm_surface', 'm^3/m^3', MONTHS.map((t) => ({ t, v: 0.1 }))),
      rec('smap', 'sm_rootzone', 'm^3/m^3', MONTHS.map((t) => ({ t, v: 0.3 }))),
    ]);
    expect(s.meanTempC?.value).toBeCloseTo(20, 6);
    expect(s.annualRainMm?.value).toBeCloseTo(730, 6);
    expect(s.soilMoisture).toMatchObject({ source: 'smap', period: { start: '2025-01-01', end: '2025-12-31' } });
    expect(s.soilMoisture?.value).toBeCloseTo(0.3, 6); // zona radicular antes que superficie
  });

  it('series diarias: la lluvia es la suma', () => {
    const days = Array.from({ length: 365 }, (_, i) => ({ t: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), v: 1 }));
    expect(climateSummary([rec('power', 'PRECTOTCORR', 'mm/day', days)]).annualRainMm?.value).toBe(365);
  });

  it('un mes sin dato: no hay lluvia anual (subestimaría), pero sí temperatura', () => {
    const gap = MONTHS.map((t, i) => ({ t, v: i === 3 ? null : 5 }));
    const s = climateSummary([rec('power', 'PRECTOTCORR', 'mm/day', gap), rec('power', 'T2M', 'C', gap)]);
    expect(s.annualRainMm).toBeNull();
    expect(s.meanTempC?.value).toBeCloseTo(5, 6);
  });

  it('con menos del 80 % de cobertura no hay media; unidad desconocida se ignora', () => {
    const few = MONTHS.map((t, i) => ({ t, v: i < 3 ? 10 : null }));
    const s = climateSummary([rec('power', 'T2M', 'C', few), rec('smap', 'sm_rootzone', '%', MONTHS.map((t) => ({ t, v: 30 })))]);
    expect(s.meanTempC).toBeNull();
    expect(s.soilMoisture).toBeNull();
  });
});
