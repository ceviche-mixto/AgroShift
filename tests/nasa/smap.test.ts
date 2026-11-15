import { describe, expect, it } from 'vitest';
import { cellSmap } from '../../src/services/nasa/grid.ts';
import { normalizeSmap, smapKey, SMAP_LAYERS } from '../../src/services/nasa/smap.ts';

// Fixture sintético con el formato de columnas de AppEEARS (<producto>_<versión>_<capa>).
// No es un bundle real: la prueba con bundle real queda bloqueada sin credenciales AppEEARS.
const S = 'SPL4SMGP_008_Geophysical_Data_sm_surface';
const R = 'SPL4SMGP_008_Geophysical_Data_sm_rootzone';
const q = { lat: -6.77, lon: -79.84, window: { start: '2025-01-01', end: '2025-01-05' } } as const;
const cell = cellSmap(q.lat, q.lon);
const csv = (rows: string[], head = `ID,Category,Latitude,Longitude,Date,${S},${R}`) => [head, ...rows].join('\n');
const at = (d: string, s: string, r: string, lat = cell.lat, lon = cell.lon) => `1,agroshift,${lat},${lon},${d},${s},${r}`;
const now = new Date('2026-11-14T12:00:00Z');
const pts = (rec?: { data: { type: string; points?: { v: number | null }[] } }) => rec?.data.points?.map((p) => p.v);

describe('normalizeSmap', () => {
  const rows = [
    at('2025-01-01', '0.30', '0.40'),
    at('2025-01-01', '0.34', '0.42'), // segunda lectura del mismo día: promedio
    at('2025-01-02', '-9999', '-9999'), // relleno
    at('2025-01-03', '0.95', '0.41'), // fuera del rango válido 0-0.9 en superficie
    at('2025-01-04', '0.28', '0.39'),
    at('2025-01-05', '0.9', '-9999'),
    at('2025-01-01', '0.77', '0.77', -6.0, -79.0), // otra celda: se descarta
  ];
  const { records, observedUntil } = normalizeSmap(csv(rows), q, q.window, now);

  it('aporta ambos estratos, en m^3/m^3, con escala y celda', () => {
    expect(records.map((r) => r.variable)).toEqual(SMAP_LAYERS.map((l) => l.variable));
    expect(records.map((r) => r.variable).join(' ')).toMatch(/0-5 cm.*0-100 cm/);
    for (const r of records) {
      expect(r.unit).toBe('m^3/m^3');
      expect(r.dataset).toMatchObject({ id: 'SPL4SMGP.008', version: '008' });
      expect(r.grid).toMatchObject({ cellId: cell.cellId, nativeResolution: '9 km (EASE-Grid 2.0)' });
      expect(r.kind).toBe('modeled_estimate');
      expect(r.limitations.join(' ')).toMatch(/modelado y asimilado/);
    }
  });

  it('promedia lecturas por fecha, y relleno y fuera de rango son null', () => {
    expect(pts(records[0])).toEqual([0.32, null, null, 0.28, 0.9]);
    expect(pts(records[1])).toEqual([0.41, null, 0.41, 0.39, null]);
    expect(records[0]?.coverage).toMatchObject({ status: 'partial', validCount: 3, expectedCount: 5 });
    expect(observedUntil).toBe('2025-01-05');
  });

  it('una celda sin datos queda con cobertura none, explícita, sin ceros', () => {
    const empty = normalizeSmap(csv([at('2025-01-01', '-9999', '-9999')]), q, q.window, now);
    for (const r of empty.records) {
      expect(r.coverage.status).toBe('none');
      expect(pts(r)?.every((v) => v === null)).toBe(true);
    }
    expect(empty.observedUntil).toBeNull();
    const other = normalizeSmap(csv([at('2025-01-01', '0.3', '0.4', -6.0, -79.0)]), q, q.window, now);
    expect(other.records[0]?.coverage.status).toBe('none');
  });

  it('falla claro si falta una capa o la fecha', () => {
    expect(() => normalizeSmap(csv([], `Latitude,Longitude,Date,${S}`), q, q.window, now)).toThrow(/sm_rootzone/);
    expect(() => normalizeSmap(csv([], `Latitude,${S},${R}`), q, q.window, now)).toThrow(/Date/);
  });

  it('la clave de caché usa la celda del producto, no la coordenada', () => {
    const key = smapKey(q);
    expect(key).toMatchObject({ source: 'smap', productVersion: 'SPL4SMGP.008', cellId: cell.cellId });
    expect(JSON.stringify(key)).not.toContain('79.84');
  });
});
