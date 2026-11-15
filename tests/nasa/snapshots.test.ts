import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evidenceRecordSchema } from '../../src/domain/schemas.ts';
import { DEMO_CASES, DEMO_WINDOW, matchSnapshot, SNAPSHOTS } from '../../src/services/nasa/fallback.ts';

describe('instantáneas locales de los tres casos', () => {
  it.each(DEMO_CASES)('$name: registros reales con metadatos, atribución y origen local', (c) => {
    const path = `src/data/nasa/${c.file}.json`;
    const raw = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as { meta: Record<string, unknown>; records: unknown[] };
    expect(statSync(path).size).toBeLessThan(100_000);
    expect(json.meta).toMatchObject({ name: c.name, window: DEMO_WINDOW });
    expect(String(json.meta.attribution)).toMatch(/NASA POWER/);
    expect(String(json.meta.command)).toContain('writeSnapshots');
    expect(Date.parse(String(json.meta.generatedAt))).not.toBeNaN();
    expect((json.meta.omitted as { source: string; reason: string }[]).map((o) => o.source)).toEqual(['smap', 'giovanni', 'firms']);
    expect(json.records).toHaveLength(6);
    for (const r of json.records) {
      const rec = evidenceRecordSchema.parse(r);
      expect(rec.cache).toEqual({ origin: 'local_snapshot', expiresAt: null });
      expect(rec.dataset.version).toMatch(/^v\d/);
      expect(rec.period).toEqual(DEMO_WINDOW);
    }
    expect(raw).not.toMatch(/api[_-]?key|token|map_key|bearer/i);
  });

  it.each(DEMO_CASES)('$name: coincide con su celda y ventana, y con ninguna otra', (c) => {
    const q = { lat: c.lat, lon: c.lon, window: DEMO_WINDOW };
    expect(matchSnapshot(SNAPSHOTS, 'power', q)).toHaveLength(6);
    expect(matchSnapshot(SNAPSHOTS, 'smap', q)).toEqual([]);
    expect(matchSnapshot(SNAPSHOTS, 'firms', q)).toEqual([]);
    expect(matchSnapshot(SNAPSHOTS, 'power', { ...q, lat: c.lat + 3 })).toEqual([]);
    expect(matchSnapshot(SNAPSHOTS, 'power', { ...q, window: { start: '2025-01-02', end: '2025-12-31' } })).toEqual([]);
  });

  it('descarta registros que no son del respaldo local o que no cumplen el contrato', () => {
    const [first] = SNAPSHOTS[0]!.records as { cache: unknown }[];
    const live = { ...first, cache: { origin: 'live', expiresAt: null } };
    const broken = { ...first, unit: '' };
    const q = { lat: -6.77, lon: -79.84, window: DEMO_WINDOW };
    expect(matchSnapshot([{ records: [live, broken] }], 'power', q)).toEqual([]);
  });
});
