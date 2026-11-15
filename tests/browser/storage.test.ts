import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_VERSION } from '../../src/domain/rotation.ts';
import { createStorage, DB_NAME, farmKey } from '../../src/services/browser/storage.ts';
import { CASES, farm, NOW, responseFor } from './fixtures.ts';

const chiclayo = farm(CASES[0].lat, CASES[0].lon);
const india = farm(CASES[1].lat, CASES[1].lon);
const make = (idb: IDBFactory | null = new IDBFactory()) => createStorage({ indexedDB: idb, localStorage: null, now: () => NOW });

/** Escribe un registro sin pasar por la API, como lo dejaría otra versión o un navegador dañado. */
function rawPut(idb: IDBFactory, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 1);
    open.onsuccess = () => {
      const tx = open.result.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

afterEach(() => vi.restoreAllMocks());

describe('IndexedDB', () => {
  it('guarda y lee último plan, planes guardados e instantánea', async () => {
    const s = make();
    const res = responseFor(chiclayo);
    expect(await s.ready()).toBe(true);
    expect(await s.loadLast()).toBeNull();

    await s.saveLast(chiclayo, res);
    await s.putSnapshot(chiclayo, res);
    const plan = await s.savePlan(chiclayo, res, '  Lote norte ');
    expect(plan.label).toBe('Lote norte');

    expect(await s.loadLast()).toEqual({ planKey: farmKey(chiclayo), savedAt: NOW.toISOString(), input: chiclayo, response: res });
    expect((await s.getSnapshot(chiclayo))?.response).toEqual(res);
    const saved = await s.listSaved();
    expect(saved.map((p) => [p.id, p.label])).toEqual([[plan.id, 'Lote norte']]);

    await s.deletePlan(plan.id);
    expect(await s.listSaved()).toEqual([]);
    expect(s.persistent).toBe(true);
  });

  it('persiste entre instancias y pone etiqueta legible por defecto', async () => {
    const idb = new IDBFactory();
    await make(idb).savePlan(chiclayo, responseFor(chiclayo));
    const [p] = await make(idb).listSaved();
    expect(p?.label).toBe('Maíz · -6.77, -79.84 · 2026-11-15');
  });

  it('lista los planes guardados del más reciente al más antiguo', async () => {
    const s = make();
    await s.savePlan(chiclayo, responseFor(chiclayo), 'viejo', '2026-01-01T00:00:00Z');
    await s.savePlan(india, responseFor(india), 'nuevo', '2026-06-01T00:00:00Z');
    expect((await s.listSaved()).map((p) => p.label)).toEqual(['nuevo', 'viejo']);
  });

  it('descarta lo que viene de otra versión del motor o del contrato', async () => {
    const idb = new IDBFactory();
    const s = make(idb);
    const res = responseFor(chiclayo);
    const oldEngine = { ...res, result: { ...res.result, engineVersion: '0.0.0-vieja' } };
    expect(oldEngine.result.engineVersion).not.toBe(ENGINE_VERSION);
    await s.saveLast(chiclayo, oldEngine);
    await s.putSnapshot(chiclayo, oldEngine);
    await s.savePlan(chiclayo, oldEngine);
    expect(await s.loadLast()).toBeNull();
    expect(await s.getSnapshot(chiclayo)).toBeNull();
    expect(await s.listSaved()).toEqual([]);

    // contrato 2 o clave de otra versión
    const key = farmKey(chiclayo);
    const base = { planKey: key, savedAt: NOW.toISOString(), input: chiclayo };
    await rawPut(idb, 'snapshots', { key, ...base, response: { ...res, result: { ...res.result, contractVersion: 2 } } });
    expect(await s.getSnapshot(chiclayo)).toBeNull();
    await rawPut(idb, 'snapshots', { key, ...base, planKey: key.replace(ENGINE_VERSION, '9.9.9'), response: res });
    expect(await s.getSnapshot(chiclayo)).toBeNull();
  });

  it('descarta registros dañados o manipulados', async () => {
    const idb = new IDBFactory();
    const s = make(idb);
    await s.ready();
    await rawPut(idb, 'last', { key: 'last', basura: true });
    await rawPut(idb, 'saved', { key: 'x', planKey: 'y' });
    expect(await s.loadLast()).toBeNull();
    expect(await s.listSaved()).toEqual([]);

    // Un registro con la entrada de otra parcela bajo la clave de esta no se acepta
    const res = responseFor(india);
    await rawPut(idb, 'snapshots', { key: farmKey(chiclayo), planKey: farmKey(india), savedAt: NOW.toISOString(), input: india, response: res });
    expect(await s.getSnapshot(chiclayo)).toBeNull();
  });

  it('no reutiliza el dato de otra parcela ni de otras respuestas', async () => {
    const s = make();
    await s.putSnapshot(chiclayo, responseFor(chiclayo));
    expect(await s.getSnapshot(india)).toBeNull();
    expect(await s.getSnapshot({ ...chiclayo, water: 'limited' })).toBeNull();
    expect(await s.getSnapshot({ ...chiclayo, goal: 'save_water' })).toBeNull();
    expect(await s.getSnapshot({ ...chiclayo, crop: { status: 'known', stage: 'last_harvested', name: 'Papa' } })).toBeNull();
    expect(await s.getSnapshot({ ...chiclayo, planting: { status: 'unknown' } })).toBeNull();
    expect(await s.getSnapshot({ ...chiclayo, location: { ...chiclayo.location, lat: chiclayo.location.lat + 0.01 } })).toBeNull();
    // A 4 decimales la misma parcela sí coincide (y el origen del punto no cambia el cálculo)
    const same = { ...chiclayo, location: { ...chiclayo.location, lat: chiclayo.location.lat + 0.00001, origin: 'gps' as const, accuracyM: 20 } };
    expect(await s.getSnapshot(same)).not.toBeNull();
    expect(farmKey(chiclayo)).toContain(ENGINE_VERSION);
  });

  it('conserva solo las instantáneas más recientes', async () => {
    const s = make();
    for (let i = 0; i < 23; i++) {
      const f = farm(-6.77, -79.84 + i / 100);
      await s.putSnapshot(f, responseFor(chiclayo), new Date(NOW.getTime() + i * 1000).toISOString());
    }
    expect(await s.getSnapshot(farm(-6.77, -79.84))).toBeNull(); // la más antigua salió
    expect(await s.getSnapshot(farm(-6.77, -79.84 + 22 / 100))).not.toBeNull();
  });
});

describe('almacenamiento bloqueado o lleno', () => {
  it('sin IndexedDB degrada a memoria de sesión y lo indica', async () => {
    const s = make(null);
    const res = responseFor(chiclayo);
    expect(s.persistent).toBe(false);
    await s.saveLast(chiclayo, res);
    await s.putSnapshot(chiclayo, res);
    const p = await s.savePlan(chiclayo, res);
    expect(await s.loadLast()).not.toBeNull();
    expect((await s.getSnapshot(chiclayo))?.response).toEqual(res);
    expect((await s.listSaved()).map((x) => x.id)).toEqual([p.id]);
    await s.deletePlan(p.id);
    expect(await s.listSaved()).toEqual([]);
  });

  it('open rechazado (modo privado) o que lanza: no lanza y degrada', async () => {
    const failing = {
      open: () => {
        throw new DOMException('bloqueado', 'SecurityError');
      },
    } as unknown as IDBFactory;
    const erroring = {
      open: () => {
        const req: { error: unknown; onerror?: () => void } = { error: new DOMException('fallo', 'UnknownError') };
        queueMicrotask(() => req.onerror?.());
        return req;
      },
    } as unknown as IDBFactory;
    for (const idb of [failing, erroring]) {
      const s = make(idb);
      expect(await s.ready()).toBe(false);
      await s.saveLast(chiclayo, responseFor(chiclayo));
      expect(await s.loadLast()).not.toBeNull();
    }
  });

  it('open que nunca responde no cuelga la interfaz (3 s)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const s = make({ open: () => ({}) } as unknown as IDBFactory);
      const ready = s.ready();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await ready).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cuota excedida al guardar: no lanza, sigue en memoria y marca persistent=false', async () => {
    const s = make();
    const res = responseFor(chiclayo);
    await s.saveLast(chiclayo, res);
    expect(s.persistent).toBe(true);
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('lleno', 'QuotaExceededError');
    });
    await expect(s.putSnapshot(chiclayo, res)).resolves.toBeUndefined();
    expect(s.persistent).toBe(false);
    expect((await s.getSnapshot(chiclayo))?.response).toEqual(res);
  });

  it('localStorage bloqueado o lleno: las preferencias quedan en memoria', () => {
    const blocked = createStorage({ indexedDB: null, localStorage: null });
    expect(blocked.setPreference('tamano', 'grande')).toBe(false);
    expect(blocked.getPreference('tamano')).toBe('grande');
    expect(blocked.getPreference('otra')).toBeNull();

    const full = createStorage({
      indexedDB: null,
      localStorage: {
        getItem: () => {
          throw new DOMException('x', 'SecurityError');
        },
        setItem: () => {
          throw new DOMException('x', 'QuotaExceededError');
        },
      },
    });
    expect(full.setPreference('a', '1')).toBe(false);
    expect(full.getPreference('a')).toBe('1');
    expect(full.getPreference('b')).toBeNull();

    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(createStorage({ indexedDB: null, localStorage: ls }).setPreference('modo', 'oscuro')).toBe(true);
    expect([...store.keys()]).toEqual(['agroshift:pref:modo']);
    expect(createStorage({ indexedDB: null, localStorage: ls }).getPreference('modo')).toBe('oscuro');
  });
});
