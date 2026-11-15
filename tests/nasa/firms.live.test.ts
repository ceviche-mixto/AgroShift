import { describe, expect, it } from 'vitest';
import { fetchFirms } from '../../src/services/nasa/firms.ts';

const key = process.env.FIRMS_MAP_KEY;

describe.skipIf(!key)('NASA FIRMS (en vivo)', () => {
  it('confirma el acceso: respuesta válida, vigente y sin filtrar la clave', async () => {
    const { records } = await fetchFirms(
      { lat: -6.77, lon: -79.84, window: { start: '2025-01-01', end: '2025-12-31' } },
      { signal: AbortSignal.timeout(30_000) },
    );
    const rec = records[0]!;
    expect(rec.data.type).toBe('detections');
    expect(rec.coverage.status).not.toBe('none');
    expect(rec.dataset.id).toBe('VIIRS_NOAA20_NRT');
    expect(JSON.stringify(records)).not.toContain(key!);
  }, 40_000);
});
