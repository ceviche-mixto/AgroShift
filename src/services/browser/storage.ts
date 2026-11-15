import type { AnalyzeResponse, FarmInput } from '../../domain/contracts.ts';
import { ENGINE_VERSION } from '../../domain/rotation.ts';
import { analyzeResponseSchema, CONTRACT_VERSION, farmInputSchema, utcInstantSchema } from '../../domain/schemas.ts';
import { z } from 'zod';

// Caché local del navegador. IndexedDB (`agroshift`, v1) guarda el último plan, los planes
// guardados y las instantáneas por clave compatible; localStorage solo preferencias pequeñas.
// Nada aquí lanza hacia la UI: con IndexedDB ausente, bloqueado, rechazado o sin cuota se degrada
// a memoria de sesión y `persistent` pasa a false. Sin Supabase, NASA, Bedrock ni `node:*`.

export const DB_NAME = 'agroshift';
export const DB_VERSION = 1;
const OPEN_TIMEOUT_MS = 3_000;
/** Instantáneas por clave: se conservan las más recientes para no agotar la cuota. */
const MAX_SNAPSHOTS = 20;
const PREF_PREFIX = 'agroshift:pref:';

type StoreName = 'last' | 'saved' | 'snapshots';
const STORES: StoreName[] = ['last', 'saved', 'snapshots'];

/** Número a 4 decimales (~11 m) sin «-0». */
const round4 = (x: number) => String(Number(x.toFixed(4)) + 0);

/**
 * Clave de compatibilidad: función pura de la entrada completa + versiones del contrato y del
 * motor. Otra parcela, otras respuestas u otra versión producen otra clave.
 */
export function farmKey(input: FarmInput): string {
  const { location: l, crop, planting } = input;
  return JSON.stringify([
    CONTRACT_VERSION,
    ENGINE_VERSION,
    round4(l.lat),
    round4(l.lon),
    crop.status === 'known' ? [crop.stage, crop.name] : null,
    input.goal,
    input.water,
    planting.status === 'known' ? [planting.date, planting.precision] : null,
  ]);
}

export interface StoredPlan {
  /** `farmKey` de la entrada. */
  planKey: string;
  /** Instante UTC en que se obtuvo la respuesta. */
  savedAt: string;
  input: FarmInput;
  response: AnalyzeResponse;
}

export interface SavedPlan extends StoredPlan {
  id: string;
  /** Etiqueta legible para la lista de planes guardados. */
  label: string;
}

const recordSchema = z.object({
  key: z.string(),
  planKey: z.string(),
  savedAt: utcInstantSchema,
  label: z.string().max(200).optional(),
  input: farmInputSchema,
  response: analyzeResponseSchema,
});
type StoredRecord = z.infer<typeof recordSchema>;

/** Revalida todo lo leído: forma, versión del contrato y del motor, y que la clave corresponda a la entrada. */
function revive(raw: unknown): StoredRecord | null {
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  if (r.response.result.contractVersion !== CONTRACT_VERSION || r.response.result.engineVersion !== ENGINE_VERSION) return null;
  return r.planKey === farmKey(r.input) ? r : null;
}

// ---------- Respaldos: IndexedDB y memoria ----------

interface Backend {
  get(store: StoreName, key: string): Promise<unknown>;
  put(store: StoreName, value: { key: string }): Promise<void>;
  del(store: StoreName, key: string): Promise<void>;
  all(store: StoreName): Promise<unknown[]>;
}

function memoryBackend(): Backend {
  const data = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));
  return {
    get: async (s, k) => data.get(s)!.get(k),
    put: async (s, v) => void data.get(s)!.set(v.key, structuredClone(v)),
    del: async (s, k) => void data.get(s)!.delete(k),
    all: async (s) => [...data.get(s)!.values()],
  };
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('open_timeout')), OPEN_TIMEOUT_MS);
    const done = <T>(f: (x: T) => void) => (x: T) => {
      clearTimeout(timer);
      f(x);
    };
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'key' });
    };
    req.onsuccess = done(() => resolve(req.result));
    req.onerror = done(() => reject(req.error ?? new Error('open_error')));
    req.onblocked = done(() => reject(new Error('open_blocked')));
  });
}

/** Una transacción por operación; resuelve al completarse, así una cuota excedida llega como rechazo. */
function idbBackend(db: IDBDatabase): Backend {
  const run = <T>(store: StoreName, mode: IDBTransactionMode, f: (os: IDBObjectStore) => IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let out: T;
      const req = f(tx.objectStore(store));
      req.onsuccess = () => (out = req.result);
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error ?? new Error('idb_error'));
    });
  return {
    get: (s, k) => run(s, 'readonly', (os) => os.get(k)),
    put: (s, v) => run(s, 'readwrite', (os) => os.put(v)).then(() => undefined),
    del: (s, k) => run(s, 'readwrite', (os) => os.delete(k)).then(() => undefined),
    all: (s) => run(s, 'readonly', (os) => os.getAll()),
  };
}

// ---------- API ----------

export interface FarmStorage {
  /** `false` cuando se degradó a memoria de sesión (IndexedDB ausente, bloqueado o sin cuota). Cambia con el uso. */
  readonly persistent: boolean;
  /** Espera el primer intento de abrir IndexedDB y devuelve `persistent`. */
  ready(): Promise<boolean>;
  /** Último plan obtenido, o `null` si no hay uno válido y de la versión actual. */
  loadLast(): Promise<StoredPlan | null>;
  saveLast(input: FarmInput, response: AnalyzeResponse, savedAt?: string): Promise<void>;
  /** Planes guardados válidos y de la versión actual, el más reciente primero. */
  listSaved(): Promise<SavedPlan[]>;
  savePlan(input: FarmInput, response: AnalyzeResponse, label?: string, savedAt?: string): Promise<SavedPlan>;
  deletePlan(id: string): Promise<void>;
  /** Instantánea compatible con ESTA entrada (misma clave), o `null`. Nunca la de otra parcela. */
  getSnapshot(input: FarmInput): Promise<StoredPlan | null>;
  putSnapshot(input: FarmInput, response: AnalyzeResponse, savedAt?: string): Promise<void>;
  /** Preferencia pequeña (localStorage, con respaldo en memoria). */
  getPreference(name: string): string | null;
  /** `true` si quedó guardada de forma persistente. */
  setPreference(name: string, value: string): boolean;
}

export interface StorageOptions {
  /** `null` simula IndexedDB ausente. Por defecto `globalThis.indexedDB`. */
  indexedDB?: IDBFactory | null;
  /** `null` simula localStorage bloqueado. Por defecto `globalThis.localStorage`. */
  localStorage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => Date;
  newId?: () => string;
}

const safe = <T>(f: () => T, fallback: T): T => {
  try {
    return f() ?? fallback; // acceder a indexedDB/localStorage ya puede lanzar (modo privado, cookies bloqueadas)
  } catch {
    return fallback;
  }
};

export function defaultLabel(input: FarmInput, savedAt: string): string {
  const crop = input.crop.status === 'known' ? input.crop.name : 'Cultivo sin indicar';
  return `${crop} · ${input.location.lat.toFixed(2)}, ${input.location.lon.toFixed(2)} · ${savedAt.slice(0, 10)}`;
}

export function createStorage(opts: StorageOptions = {}): FarmStorage {
  const factory = opts.indexedDB === undefined ? safe(() => globalThis.indexedDB as IDBFactory | null, null) : opts.indexedDB;
  const ls = opts.localStorage === undefined ? safe(() => globalThis.localStorage as Storage | null, null) : opts.localStorage;
  const clock = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  const mem = memoryBackend();
  const prefs = new Map<string, string>();
  let persistent = factory !== null;
  let opening: Promise<Backend | null> | undefined;

  async function backend(): Promise<Backend> {
    if (!persistent || !factory) return mem;
    opening ??= openDb(factory).then(idbBackend, () => {
      persistent = false;
      return null;
    });
    return (await opening) ?? mem;
  }

  async function read<T>(f: (b: Backend) => Promise<T>): Promise<T> {
    const b = await backend();
    try {
      return await f(b);
    } catch {
      persistent = false;
      return f(mem);
    }
  }

  /** La memoria siempre queda al día; el disco es un extra que puede fallar (cuota, bloqueo). */
  async function write(f: (b: Backend) => Promise<void>): Promise<void> {
    await f(mem);
    const b = await backend();
    if (b === mem) return;
    try {
      await f(b);
    } catch {
      persistent = false;
    }
  }

  const toStored = (r: StoredRecord): StoredPlan => ({ planKey: r.planKey, savedAt: r.savedAt, input: r.input, response: r.response });
  const record = (key: string, input: FarmInput, response: AnalyzeResponse, savedAt: string, label?: string) => ({
    key,
    planKey: farmKey(input),
    savedAt,
    ...(label === undefined ? {} : { label }),
    input,
    response,
  });

  return {
    get persistent() {
      return persistent;
    },
    async ready() {
      await backend();
      return persistent;
    },
    async loadLast() {
      const r = revive(await read((b) => b.get('last', 'last')));
      return r && toStored(r);
    },
    saveLast: (input, response, savedAt = clock().toISOString()) =>
      write((b) => b.put('last', record('last', input, response, savedAt))),
    async listSaved() {
      const rows = await read((b) => b.all('saved'));
      return rows
        .flatMap((raw) => {
          const r = revive(raw);
          return r ? [{ ...toStored(r), id: r.key, label: r.label ?? defaultLabel(r.input, r.savedAt) }] : [];
        })
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    async savePlan(input, response, label, savedAt = clock().toISOString()) {
      const id = newId();
      const text = label?.trim() || defaultLabel(input, savedAt);
      await write((b) => b.put('saved', record(id, input, response, savedAt, text)));
      return { id, label: text, planKey: farmKey(input), savedAt, input, response };
    },
    deletePlan: (id) => write((b) => b.del('saved', id)),
    async getSnapshot(input) {
      const key = farmKey(input);
      const r = revive(await read((b) => b.get('snapshots', key)));
      return r && r.planKey === key ? toStored(r) : null;
    },
    async putSnapshot(input, response, savedAt = clock().toISOString()) {
      await write((b) => b.put('snapshots', record(farmKey(input), input, response, savedAt)));
      // Poda: conserva las más recientes
      const rows = (await read((b) => b.all('snapshots'))) as { key: string; savedAt?: string }[];
      const old = rows.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))).slice(MAX_SNAPSHOTS);
      for (const r of old) await write((b) => b.del('snapshots', r.key));
    },
    getPreference(name) {
      return prefs.get(name) ?? safe(() => ls?.getItem(PREF_PREFIX + name) ?? null, null);
    },
    setPreference(name, value) {
      prefs.set(name, value);
      try {
        if (!ls) return false;
        ls.setItem(PREF_PREFIX + name, value);
        return true;
      } catch {
        return false; // cuota o bloqueo: queda en memoria de sesión
      }
    },
  };
}

let shared: FarmStorage | undefined;
/** Almacenamiento compartido de la página (se crea al primer uso). */
export const browserStorage = (): FarmStorage => (shared ??= createStorage());
