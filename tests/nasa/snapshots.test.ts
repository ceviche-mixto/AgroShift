import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evidenceRecordSchema } from '../../src/domain/schemas.ts';
import { DEMO_CASES, DEMO_WINDOW, matchSnapshot, SNAPSHOTS } from '../../src/services/nasa/fallback.ts';

describe('instantáneas locales de los tres casos', () => {
  it.each(DEMO_CASES)('$name: registros reales con metadatos, atribución y origen local', (c) => {
    const path = `src/data/nasa/${c.file}.json`;
    const raw = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as { meta: Record<string, unknown>; records: unknown[] };
    expect(statSync(path).size).toBeLessThan(150_000);
    expect(json.meta).toMatchObject({ name: c.name, window: DEMO_WINDOW });
    expect(String(json.meta.attribution)).toMatch(/NASA POWER/);
    expect(String(json.meta.command)).toContain('writeSnapshots');
    expect(Date.parse(String(json.meta.generatedAt))).not.toBeNaN();
    const omitted = (json.meta.omitted as { source: string; reason: string }[]).map((o) => o.source);
    const sources = new Set<string>();
    for (const r of json.records) {
      const rec = evidenceRecordSchema.parse(r);
      sources.add(rec.source);
      expect(rec.cache).toEqual({ origin: 'local_snapshot', expiresAt: null });
      expect(rec.period.start >= DEMO_WINDOW.start && rec.period.end <= DEMO_WINDOW.end).toBe(true);
    }
    // Cada fuente está en el respaldo o figura como omitida con motivo, nunca ambas
    for (const s of ['power', 'smap', 'giovanni', 'firms']) expect(sources.has(s)).toBe(!omitted.includes(s));
    expect(sources.has('power')).toBe(true);
    expect(sources.has('giovanni')).toBe(true);
    expect(sources.has('firms')).toBe(false);
    expect(raw).not.toMatch(/api[_-]?key|token|map_key|bearer/i);
  });

  it.each(DEMO_CASES)('$name: coincide con su celda y ventana, y con ninguna otra', (c) => {
    const q = { lat: c.lat, lon: c.lon, window: DEMO_WINDOW };
    expect(matchSnapshot(SNAPSHOTS, 'power', q)).toHaveLength(6);
    expect(matchSnapshot(SNAPSHOTS, 'giovanni', q)).toHaveLength(3);
    expect(matchSnapshot(SNAPSHOTS, 'firms', q)).toEqual([]);
    for (const source of ['power', 'smap', 'giovanni'] as const) {
      expect(matchSnapshot(SNAPSHOTS, source, { ...q, lat: c.lat + 3 })).toEqual([]);
      expect(matchSnapshot(SNAPSHOTS, source, { ...q, window: { start: '2025-01-02', end: '2025-12-31' } })).toEqual([]);
    }
  });

  it('Chiclayo trae ambos estratos reales de SMAP, con su escala, celda y cobertura', () => {
    const smap = matchSnapshot(SNAPSHOTS, 'smap', { lat: -6.77, lon: -79.84, window: DEMO_WINDOW });
    expect(smap.map((r) => r.variable)).toEqual([
      'Humedad del suelo, superficie (0-5 cm)',
      'Humedad del suelo, zona radicular (0-100 cm)',
    ]);
    for (const r of smap) {
      expect(r).toMatchObject({ unit: 'm^3/m^3', kind: 'modeled_estimate', dataset: { id: 'SPL4SMGP.008', version: '008' } });
      expect(r.grid).toMatchObject({ cellId: 'ease2-9km:r907c1072', nativeResolution: '9 km (EASE-Grid 2.0)' });
      expect(r.coverage).toMatchObject({ status: 'complete', validCount: 365, expectedCount: 365 });
    }
  });

  it('descarta registros que no son del respaldo local o que no cumplen el contrato', () => {
    const [first] = SNAPSHOTS[0]!.records as { cache: unknown }[];
    const live = { ...first, cache: { origin: 'live', expiresAt: null } };
    const broken = { ...first, unit: '' };
    const q = { lat: -6.77, lon: -79.84, window: DEMO_WINDOW };
    expect(matchSnapshot([{ records: [live, broken] }], 'power', q)).toEqual([]);
  });
});
