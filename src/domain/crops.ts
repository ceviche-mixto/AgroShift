import { z } from 'zod';
import cropsJson from '../data/agronomy/crops.json' with { type: 'json' };
import rulesJson from '../data/agronomy/rules.json' with { type: 'json' };

// Catálogo agronómico puro: sin imports de servidor. Un valor sin respaldo es `null`, nunca 0
// ni una aproximación. La falta de cobertura regional es explícita (`coverage: 'none'`).

const text = (max: number) => z.string().trim().min(1).max(max);
const idSchema = z.string().regex(/^[a-z0-9]+([_-][a-z0-9]+)*$/, 'ID inválido');

export const agronomySourceSchema = z.strictObject({
  id: idSchema,
  title: text(300),
  organization: text(300),
  url: z.url({ protocol: /^https?$/ }),
  /** Fecha en que se leyó la fuente, `YYYY-MM-DD`. */
  consultedAt: z.iso.date(),
  /** Escala, región y limitaciones. */
  note: text(1000),
});

/** `null` = desconocido. */
const rangeSchema = z
  .strictObject({ min: z.number().nullable(), max: z.number().nullable() })
  .refine((r) => r.min === null || r.max === null || r.min <= r.max, 'min supera max');

const requirement = <U extends string>(unit: U) =>
  z.strictObject({
    unit: z.literal(unit),
    /** Base temporal o de medición tal como la declara la fuente. */
    basis: text(300),
    optimal: rangeSchema,
    absolute: rangeSchema,
  });

export const regionSchema = z.strictObject({
  id: idSchema,
  name: text(100),
  /** Caja geográfica WGS84 en grados decimales. */
  bbox: z.strictObject({
    latMin: z.number().min(-90).max(90),
    latMax: z.number().min(-90).max(90),
    lonMin: z.number().min(-180).max(180),
    lonMax: z.number().min(-180).max(180),
  }),
  note: text(300),
});

/** Temporada de cultivo en meses calendario (1-12); si `endMonth < startMonth` cruza fin de año. */
const windowSchema = z.strictObject({
  kind: z.literal('cropping_season'),
  label: text(100),
  startMonth: z.int().min(1).max(12),
  endMonth: z.int().min(1).max(12),
});

export const cropRegionSchema = z
  .strictObject({
    id: idSchema,
    coverage: z.enum(['supported', 'none']),
    windows: z.array(windowSchema),
    sourceIds: z.array(idSchema),
    note: text(500),
  })
  .refine(
    (r) => (r.coverage === 'supported' ? r.windows.length > 0 && r.sourceIds.length > 0 : r.windows.length === 0 && r.sourceIds.length === 0),
    "Cobertura 'supported' exige ventana y fuente; 'none' no puede traer ninguna",
  );

export const cropSchema = z.strictObject({
  id: idSchema,
  version: text(20),
  scientificName: text(120),
  family: text(60),
  group: z.enum(['cereal', 'legume']),
  /** Nombres que la persona puede escribir. Se comparan sin tildes ni mayúsculas. */
  aliases: z.array(text(60)).min(1),
  temperature: requirement('°C'),
  /** Lluvia anual en mm, como la rotula ECOCROP; no es lluvia del ciclo. */
  rainfall: requirement('mm'),
  ph: requirement('pH'),
  cycle: z.strictObject({ unit: z.literal('días'), basis: text(300), range: rangeSchema }),
  sourceIds: z.array(idSchema).min(1),
  regions: z.array(cropRegionSchema),
});

export const RULE_TYPES = [
  'rotation_same_crop',
  'rotation_same_family',
  'rotation_legume_cereal',
  'thermal_limit',
  'water_minimum',
] as const;

export const ruleSchema = z
  .strictObject({
    id: idSchema,
    type: z.enum(RULE_TYPES),
    /** discard: excluye el cultivo; warn: advierte; prefer: favorece. */
    effect: z.enum(['discard', 'warn', 'prefer']),
    description: text(300),
    scope: z.strictObject({
      kind: z.enum(['global', 'region']),
      regionIds: z.array(idSchema),
      condition: text(300).nullable(),
    }),
    params: z.array(
      z.strictObject({ name: text(60), value: z.union([z.number(), text(100)]), unit: text(20).nullable() }),
    ),
    sourceIds: z.array(idSchema).min(1),
    version: text(20),
    active: z.boolean(),
    note: text(500),
  })
  .refine((r) => (r.scope.kind === 'region') === (r.scope.regionIds.length > 0), 'Ámbito de región sin regionIds');

const catalogFileSchema = z.strictObject({
  version: text(20),
  sources: z.array(agronomySourceSchema).min(1),
  regions: z.array(regionSchema).min(1),
  crops: z.array(cropSchema).min(1),
});
const rulesFileSchema = z.strictObject({ version: text(20), rules: z.array(ruleSchema) });

export type AgronomySource = z.infer<typeof agronomySourceSchema>;
export type Region = z.infer<typeof regionSchema>;
export type CropRegion = z.infer<typeof cropRegionSchema>;
export type Crop = z.infer<typeof cropSchema>;
export type Rule = z.infer<typeof ruleSchema>;

/** Normaliza para comparar nombres: sin tildes, minúsculas, espacios y guiones bajos colapsados. */
export const canonicalize = (name: string): string =>
  name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[_\s]+/g, ' ').trim();

// Un JSON inválido o con referencias rotas lanza al cargar el módulo.
const catalog = catalogFileSchema.parse(cropsJson);
const rulesFile = rulesFileSchema.parse(rulesJson);

const dup = (ids: string[], what: string) => {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${what} duplicado: ${id}`);
    seen.add(id);
  }
};
const sourceIds = new Set(catalog.sources.map((s) => s.id));
const regionIds = new Set(catalog.regions.map((r) => r.id));
const mustExist = (ids: string[], known: Set<string>, owner: string, what: string) => {
  for (const id of ids) if (!known.has(id)) throw new Error(`${owner}: ${what} inexistente ${id}`);
};

dup(catalog.sources.map((s) => s.id), 'Fuente');
dup(catalog.regions.map((r) => r.id), 'Región');
dup(catalog.crops.map((c) => c.id), 'Cultivo');
dup(rulesFile.rules.map((r) => r.id), 'Regla');
const namesOf = (c: Crop) => [...new Set([c.id, ...c.aliases].map(canonicalize))];
dup(catalog.crops.flatMap(namesOf), 'Alias entre cultivos');
for (const c of catalog.crops) {
  mustExist(c.sourceIds, sourceIds, c.id, 'fuente');
  dup(c.regions.map((r) => r.id), `Región de ${c.id}`);
  if (c.regions.length !== regionIds.size) throw new Error(`${c.id}: debe declarar cobertura de todas las regiones`);
  mustExist(c.regions.map((r) => r.id), regionIds, c.id, 'región');
  for (const r of c.regions) mustExist(r.sourceIds, sourceIds, `${c.id}/${r.id}`, 'fuente');
}
for (const r of rulesFile.rules) {
  mustExist(r.sourceIds, sourceIds, r.id, 'fuente');
  mustExist(r.scope.regionIds, regionIds, r.id, 'región');
}

export const CATALOG_VERSION: string = catalog.version;
export const AGRONOMY_SOURCES: AgronomySource[] = catalog.sources;
export const REGIONS: Region[] = catalog.regions;
export const CROPS: Crop[] = catalog.crops;
export const RULES: Rule[] = rulesFile.rules;

const byName = new Map<string, Crop>();
for (const c of CROPS) for (const n of namesOf(c)) byName.set(n, c);

/** Cultivo del catálogo por ID o alias exacto (sin tildes ni mayúsculas). `null` si no está: nunca el más parecido. */
export function findCrop(name: string): Crop | null {
  return byName.get(canonicalize(name)) ?? null;
}

/** ID de la región cuya caja contiene el punto, o `null` si ninguna. */
export function regionFor(lat: number, lon: number): string | null {
  const r = REGIONS.find(
    (x) => lat >= x.bbox.latMin && lat <= x.bbox.latMax && lon >= x.bbox.lonMin && lon <= x.bbox.lonMax,
  );
  return r?.id ?? null;
}
