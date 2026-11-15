import { describe, expect, it } from 'vitest';
import cropsJson from '../../src/data/agronomy/crops.json' with { type: 'json' };
import {
  AGRONOMY_SOURCES,
  CATALOG_VERSION,
  CROPS,
  REGIONS,
  RULES,
  agronomySourceSchema,
  cropRegionSchema,
  cropSchema,
  findCrop,
  findGeneralGroup,
  regionFor,
  suggestCrops,
  ruleSchema,
} from '../../src/domain/crops.ts';

const sourceIds = new Set(AGRONOMY_SOURCES.map((s) => s.id));

describe('catálogo agronómico', () => {
  it('el JSON valida contra los esquemas', () => {
    expect(CATALOG_VERSION).toBe(cropsJson.version);
    expect(CROPS.length).toBeGreaterThanOrEqual(5);
    expect(CROPS.length).toBeLessThanOrEqual(8);
    for (const s of AGRONOMY_SOURCES) expect(agronomySourceSchema.safeParse(s).success).toBe(true);
    for (const c of CROPS) expect(cropSchema.safeParse(c).success).toBe(true);
    for (const r of RULES) expect(ruleSchema.safeParse(r).success).toBe(true);
  });

  it('cada ficha y cobertura regional referencia fuentes existentes', () => {
    for (const c of CROPS) {
      for (const id of c.sourceIds) expect(sourceIds.has(id), `${c.id}: ${id}`).toBe(true);
      for (const r of c.regions) for (const id of r.sourceIds) expect(sourceIds.has(id), `${c.id}/${r.id}: ${id}`).toBe(true);
    }
    for (const s of AGRONOMY_SOURCES) expect(s.url.startsWith('http')).toBe(true);
  });

  it('cada regla activa enlaza evidencia existente y tiene ámbito', () => {
    const active = RULES.filter((r) => r.active);
    expect(active.length).toBeGreaterThan(0);
    for (const r of active) {
      expect(r.sourceIds.length).toBeGreaterThan(0);
      for (const id of r.sourceIds) expect(sourceIds.has(id), `${r.id}: ${id}`).toBe(true);
      expect(r.scope.kind === 'global' || r.scope.regionIds.length > 0).toBe(true);
    }
    expect(RULES.some((r) => !r.active)).toBe(true);
  });

  it('todo cultivo declara cobertura de todas las regiones; sin respaldo es none y sin ventanas', () => {
    for (const c of CROPS) {
      expect(c.regions.map((r) => r.id).sort()).toEqual(REGIONS.map((r) => r.id).sort());
      for (const r of c.regions) {
        if (r.coverage === 'none') {
          expect(r.windows).toEqual([]);
          expect(r.sourceIds).toEqual([]);
        } else {
          expect(r.windows.length).toBeGreaterThan(0);
          expect(r.sourceIds.length).toBeGreaterThan(0);
        }
      }
    }
    const none = CROPS.flatMap((c) => c.regions).filter((r) => r.coverage === 'none');
    expect(none.length).toBeGreaterThan(0);
    // Un 'supported' sin ventana o con 'none' con ventana inventada se rechaza.
    const base = { id: 'x', sourceIds: [], note: 'n' };
    expect(cropRegionSchema.safeParse({ ...base, coverage: 'supported', windows: [] }).success).toBe(false);
    expect(
      cropRegionSchema.safeParse({
        ...base,
        coverage: 'none',
        windows: [{ kind: 'cropping_season', label: 'x', startMonth: 1, endMonth: 3 }],
      }).success,
    ).toBe(false);
  });

  it('ningún valor numérico conocido vale 0 y los rangos son coherentes', () => {
    for (const c of CROPS) {
      for (const k of ['rainfall', 'ph'] as const) {
        const { optimal: o, absolute: a } = c[k];
        for (const v of [o.min, o.max, a.min, a.max]) expect(v).not.toBe(0);
        if (a.min !== null && o.min !== null) expect(a.min).toBeLessThanOrEqual(o.min);
        if (a.max !== null && o.max !== null) expect(a.max).toBeGreaterThanOrEqual(o.max);
      }
      const t = c.temperature;
      if (t.absolute.min !== null && t.optimal.min !== null) expect(t.absolute.min).toBeLessThanOrEqual(t.optimal.min);
      if (t.absolute.max !== null && t.optimal.max !== null) expect(t.absolute.max).toBeGreaterThanOrEqual(t.optimal.max);
      expect(c.cycle.range.min).not.toBe(0);
      expect(c.cycle.range.max).not.toBe(0);
    }
  });
});

describe('findCrop', () => {
  it('resuelve ID y alias sin importar tildes, mayúsculas ni espacios', () => {
    expect(findCrop('Maíz')?.id).toBe('maize');
    expect(findCrop('  MAIZ  ')?.id).toBe('maize');
    expect(findCrop('Choclo')?.id).toBe('maize');
    expect(findCrop('Ragi')?.id).toBe('finger_millet');
    expect(findCrop('Arroz')?.id).toBe('rice');
    expect(findCrop('Caupí')?.id).toBe('cowpea');
    expect(findCrop('frijol   común')?.id).toBe('common_bean');
    expect(findCrop('common bean')?.id).toBe('common_bean');
    expect(findCrop('common_bean')?.id).toBe('common_bean');
  });

  it('devuelve null para lo que no está, sin acercar al más parecido', () => {
    expect(findCrop('quinua')).toBeNull();
    expect(findCrop('maizal')).toBeNull();
    expect(findCrop('')).toBeNull();
    expect(findCrop('   ')).toBeNull();
  });

  it.each([
    ['choclo', 'maize'],
    ['Elote', 'maize'],
    ['MAZORCA', 'maize'],
    ['frejol', 'common_bean'],
    ['Poroto', 'common_bean'],
    ['caraota', 'common_bean'],
    ['alubia', 'common_bean'],
    ['paddy', 'rice'],
    ['ARROZ', 'rice'],
    ['chana', 'chickpea'],
    ['frejol castilla', 'cowpea'],
  ])('sinónimo regional «%s» → %s', (name, id) => {
    expect(findCrop(name)?.id).toBe(id);
  });

  it('ignora tildes, mayúsculas, espacios extra, puntuación y plurales', () => {
    expect(findCrop('  MAÍZ.  ')?.id).toBe('maize');
    expect(findCrop('maices')?.id).toBe('maize');
    expect(findCrop('Maíces')?.id).toBe('maize');
    expect(findCrop('frijoles')?.id).toBe('common_bean');
    expect(findCrop('frijoles   comunes')?.id).toBe('common_bean');
    expect(findCrop('porotos')?.id).toBe('common_bean');
    expect(findCrop('garbanzos')?.id).toBe('chickpea');
    expect(findCrop('chocLOS')?.id).toBe('maize');
  });
});

describe('findGeneralGroup', () => {
  it.each([
    ['espárrago', 'perennial'],
    ['Caña de azúcar', 'perennial'],
    ['caña  de azucar', 'perennial'],
    ['tomate', 'vegetable'],
    ['Tomates', 'vegetable'],
    ['cebollas', 'vegetable'],
    ['patata', 'tuber'],
    ['PAPA', 'tuber'],
    ['papas', 'tuber'],
  ])('cultivo fuera de las fichas «%s» → grupo %s', (name, group) => {
    expect(findCrop(name)).toBeNull();
    expect(findGeneralGroup(name)?.id).toBe(group);
  });

  it('un cultivo con ficha o desconocido no cae en un grupo general', () => {
    expect(findGeneralGroup('maíz')).toBeNull();
    expect(findGeneralGroup('quinua')).toBeNull();
    expect(findGeneralGroup('')).toBeNull();
  });
});

describe('suggestCrops', () => {
  it('reconoce sinónimos mientras se escribe', () => {
    expect(suggestCrops('cho')[0]).toMatchObject({ kind: 'catalog', cropId: 'maize', alias: 'choclo' });
    expect(suggestCrops('fre')[0]).toMatchObject({ kind: 'catalog', cropId: 'common_bean' });
    expect(suggestCrops('ARR')[0]).toMatchObject({ kind: 'catalog', cropId: 'rice' });
    expect(suggestCrops('tom')[0]).toMatchObject({ kind: 'family', groupId: 'vegetable', alias: 'tomate' });
  });

  it('una coincidencia exacta con plural va primero y no repite cultivos', () => {
    expect(suggestCrops('papas')[0]).toMatchObject({ kind: 'family', groupId: 'tuber' });
    const out = suggestCrops('fr', 20);
    const ids = out.filter((s) => s.kind === 'catalog').map((s) => (s as { cropId: string }).cropId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sin texto o sin coincidencias no sugiere nada y respeta el límite', () => {
    expect(suggestCrops('   ')).toEqual([]);
    expect(suggestCrops('zzzz')).toEqual([]);
    expect(suggestCrops('a', 3).length).toBeLessThanOrEqual(3);
  });
});

describe('regionFor', () => {
  it('ubica los tres casos de demostración y devuelve null fuera de caja', () => {
    expect(regionFor(-6.77, -79.84)).toBe('pe-chiclayo');
    expect(regionFor(12.97, 77.59)).toBe('in-bengaluru');
    expect(regionFor(-1.29, 36.82)).toBe('ke-nairobi');
    expect(regionFor(40.4, -3.7)).toBeNull();
  });

  it('solo ragi tiene respaldo regional, en Bengaluru', () => {
    const supported = CROPS.flatMap((c) => c.regions.filter((r) => r.coverage === 'supported').map((r) => `${c.id}/${r.id}`));
    expect(supported).toEqual(['finger_millet/in-bengaluru']);
  });
});
