import type { Alert, AnalyzeResponse, EvidenceRecord, FarmInput, Finding, Plan } from '../domain/contracts.ts';
import { answerLocally, cropName, explainFinding, listFacts, type QuestionId, QUESTION_IDS } from '../domain/explain.ts';
import { parseFarmInput } from '../domain/schemas.ts';
import {
  ALERTA_FUEGO,
  BOTON_ENVIAR,
  cupoAgotado,
  ESTADO_FUENTE,
  ESTADOS,
  FLUJO,
  FUENTES,
  fuenteAtrasada,
  GUARDADO_ESTADO,
  hace,
  CAMPOS,
  NATURALEZA_ESCENARIO,
  ORIGEN_DATO,
  planBPendiente,
  planGuardado,
  RESPUESTA_ORIGEN,
  RESULTADO,
  ROL_PLAN,
  TONOS,
  UBICACION_ESTADO,
  UBICACION_EXTRA,
  type Mensaje,
} from '../content/es.ts';
import { analyzeFarm, FRESH_MS, type AnalyzeSuccess } from '../services/browser/analyze.ts';
import { registerOffline } from '../services/browser/offline.ts';
import { browserStorage, type SavedPlan } from '../services/browser/storage.ts';

// Isla ligera: mejora el HTML estático (formulario, plantillas, ganchos data-ff). Sin Supabase, NASA
// ni Bedrock en el cliente: solo habla con /api/analyze, /api/explain y /api/location.

type Group = 'ubicacion' | 'cultivo' | 'objetivo' | 'agua' | 'siembra';
const GROUPS: Group[] = ['ubicacion', 'cultivo', 'objetivo', 'agua', 'siembra'];
const REQUEST_MS = 8_000;

const root = document.querySelector<HTMLElement>('[data-farm-flow]');
if (root) init(root);

function init(root: HTMLElement) {
  const one = <T extends Element = HTMLElement>(sel: string, from: ParentNode = root): T => {
    const el = from.querySelector<T>(sel);
    if (!el) throw new Error(`Falta ${sel}`);
    return el;
  };
  const ff = <T extends HTMLElement = HTMLElement>(name: string) => one<T>(`[data-ff="${name}"]`);
  const clone = (name: string) => one<HTMLTemplateElement>(`template[data-ff-tpl="${name}"]`).content.firstElementChild!.cloneNode(true) as HTMLElement;
  const fill = (node: ParentNode, slots: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(slots)) {
      const el = node.querySelector<HTMLElement>(`[data-slot="${k}"]`);
      if (el) el.textContent = v ?? '';
    }
  };
  const list = (node: ParentNode, texts: string[], slot = 'list') => {
    const ul = one<HTMLElement>(`[data-slot="${slot}"]`, node);
    ul.replaceChildren(...texts.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  };

  const form = ff<HTMLFormElement>('form');
  const status = ff('status');
  const net = ff('net');
  const loading = ff('loading');
  const results = ff('results');
  const resultsTitle = ff('results-title');
  const field = <T extends HTMLElement = HTMLInputElement>(name: string) => one<T>(`[name="${name}"]`, form);
  const checked = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]:checked`)?.value ?? null;
  const storage = browserStorage();

  // Los contenedores en vivo existen desde la carga: así los lectores de pantalla anuncian los cambios.
  for (const el of [net, loading]) {
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
  }

  // ---------- Mensajes ----------

  function message(m: Mensaje): HTMLElement {
    const el = clone('message');
    el.classList.add(`estado--${m.tono}`);
    fill(el, { symbol: TONOS[m.tono].simbolo, label: TONOS[m.tono].etiqueta, title: m.titulo, text: m.explicacion, step: m.siguientePaso });
    if (!m.siguientePaso) el.querySelector('[data-slot="step"]')?.remove();
    return el;
  }
  const show = (target: HTMLElement, m: Mensaje | null) => {
    target.replaceChildren(...(m ? [message(m)] : []));
    target.hidden = !m;
  };
  const setStatus = (m: Mensaje | null) => show(status, m);

  // ---------- Errores por campo ----------

  const errorEl = (g: Group) => one<HTMLElement>(`[data-ff-error="${g}"]`);
  const controlsOf = (g: Group) => [...form.querySelectorAll<HTMLElement>(`[aria-describedby~="error-${g}"]`)];
  function setError(g: Group, text: string | null) {
    const el = errorEl(g);
    el.textContent = text ?? '';
    el.hidden = !text;
    for (const c of controlsOf(g)) text ? c.setAttribute('aria-invalid', 'true') : c.removeAttribute('aria-invalid');
  }
  function focusFirstError() {
    for (const g of GROUPS) {
      if (errorEl(g).hidden) continue;
      controlsOf(g).find((c) => c.offsetParent !== null)?.focus();
      return;
    }
  }
  form.addEventListener('input', (e) => {
    const g = GROUPS.find((x) => (e.target as HTMLElement).getAttribute('aria-describedby')?.split(' ').includes(`error-${x}`));
    if (g) setError(g, null);
  });

  // ---------- Lectura del formulario ----------

  const num = (s: string) => {
    const t = s.trim().replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  };

  function readForm(): { input: FarmInput | null; errors: Partial<Record<Group, string>> } {
    const errors: Partial<Record<Group, string>> = {};
    const lat = num(field('lat').value);
    const lon = num(field('lon').value);
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) errors.ubicacion = CAMPOS.ubicacion.error;
    const accuracy = Number(field('accuracy').value);
    const origin = field('origin').value as FarmInput['location']['origin'];

    const name = field('crop_name').value.trim();
    const cropStage = (checked('crop_stage') ?? 'current') as 'current' | 'last_harvested';
    const cropUnknown = field('crop_unknown').checked;
    if (!cropUnknown && (!name || name.length > 80)) errors.cultivo = CAMPOS.cultivo.error;

    const goal = checked('goal');
    if (!goal) errors.objetivo = CAMPOS.objetivo.error;
    const water = checked('water');
    if (!water) errors.agua = CAMPOS.agua.error;

    const precision = (checked('planting_precision') ?? 'day') as 'day' | 'month';
    const month = field('planting_month').value.trim();
    const day = field('planting_date').value.trim();
    const date = precision === 'month' ? (/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? `${month}-01` : '') : day;
    if (!field('planting_unknown').checked && !(date && date >= '2000-01-01')) errors.siembra = CAMPOS.siembra.error;

    if (Object.keys(errors).length) return { input: null, errors };
    const parsed = parseFarmInput({
      location: { lat, lon, origin, accuracyM: Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 100_000 ? accuracy : null },
      crop: cropUnknown ? { status: 'unknown' } : { status: 'known', stage: cropStage, name },
      goal,
      water,
      planting: field('planting_unknown').checked ? { status: 'unknown' } : { status: 'known', date, precision },
    });
    if (parsed.ok) return { input: parsed.value, errors };
    for (const i of parsed.error.issues) {
      const g = ({ location: 'ubicacion', crop: 'cultivo', goal: 'objetivo', water: 'agua', planting: 'siembra' } as const)[i.path.split('.')[0] as 'location'];
      if (g) errors[g] = CAMPOS[g].error;
    }
    return { input: null, errors };
  }

  const commaNum = (n: number) => String(n).replace('.', ',');
  function applyInput(input: FarmInput) {
    field('lat').value = commaNum(input.location.lat);
    field('lon').value = commaNum(input.location.lon);
    field('origin').value = input.location.origin;
    field('accuracy').value = input.location.accuracyM === null ? '' : String(input.location.accuracyM);
    field('place').value = '';
    placeResults.hidden = true;
    const pick = (name: string, value: string) => {
      const r = form.querySelector<HTMLInputElement>(`[name="${name}"][value="${value}"]`);
      if (r) r.checked = true;
    };
    field('crop_unknown').checked = input.crop.status === 'unknown';
    field('crop_name').value = input.crop.status === 'known' ? input.crop.name : '';
    pick('crop_stage', input.crop.status === 'known' ? input.crop.stage : 'current');
    pick('goal', input.goal);
    pick('water', input.water);
    field('planting_unknown').checked = input.planting.status === 'unknown';
    pick('planting_precision', input.planting.status === 'known' ? input.planting.precision : 'day');
    field('planting_date').value = input.planting.status === 'known' && input.planting.precision === 'day' ? input.planting.date : '';
    field('planting_month').value = input.planting.status === 'known' && input.planting.precision === 'month' ? input.planting.date.slice(0, 7) : '';
    for (const g of GROUPS) setError(g, null);
  }

  // ---------- Ubicación: GPS y búsqueda ----------

  const locStatus = ff('location-status');
  const placeResults = ff<HTMLFieldSetElement>('place-results');
  const say = (text: string) => (locStatus.textContent = text);
  const manual = () => {
    field('origin').value = 'manual_coordinates';
    field('accuracy').value = '';
  };
  for (const n of ['lat', 'lon']) field(n).addEventListener('input', manual);

  ff('gps').addEventListener('click', () => {
    setError('ubicacion', null);
    if (!('geolocation' in navigator)) return say(CAMPOS.ubicacion.errorGps);
    say(UBICACION_ESTADO.buscandoGps);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        field('lat').value = commaNum(Number(p.coords.latitude.toFixed(5)));
        field('lon').value = commaNum(Number(p.coords.longitude.toFixed(5)));
        field('origin').value = 'gps';
        field('accuracy').value = String(Math.round(p.coords.accuracy));
        placeResults.hidden = true;
        say(p.coords.accuracy > 1000 ? UBICACION_ESTADO.gpsAproximada(p.coords.accuracy) : UBICACION_ESTADO.gpsListo);
      },
      () => say(CAMPOS.ubicacion.errorGps),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  });

  interface Place { name: string; detail: string; lat: number; lon: number }
  let searchId = 0;
  async function search() {
    const q = field('place').value.trim();
    if (q.length < 2) return say(UBICACION_EXTRA.escribeLocalidad);
    const id = ++searchId;
    placeResults.hidden = true;
    say(UBICACION_ESTADO.buscandoLocalidad);
    try {
      const res = await fetch('/api/location', { method: 'POST', body: JSON.stringify({ q }), signal: AbortSignal.timeout(REQUEST_MS) });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { places: Place[]; attribution?: string };
      if (id !== searchId) return;
      if (!body.places.length) return say(UBICACION_ESTADO.sinCoincidencias);
      const options = body.places.map((p) => {
        const label = clone('place-option');
        fill(label, { name: p.detail ? `${p.name}, ${p.detail}` : p.name, coords: `${commaNum(p.lat)}, ${commaNum(p.lon)}` });
        const radio = one<HTMLInputElement>('input', label);
        radio.addEventListener('change', () => {
          field('lat').value = commaNum(p.lat);
          field('lon').value = commaNum(p.lon);
          field('origin').value = 'place_search';
          field('accuracy').value = '';
          setError('ubicacion', null);
          say(`${UBICACION_ESTADO.elegida(p.name)} ${UBICACION_ESTADO.coincidenciaAproximada}`);
        });
        return label;
      });
      placeResults.replaceChildren(placeResults.querySelector('legend')!, ...options);
      if (body.attribution) placeResults.append(Object.assign(document.createElement('p'), { className: 'texto-suave', textContent: body.attribution }));
      placeResults.hidden = false;
      say(body.places.length > 1 ? UBICACION_ESTADO.variasCoincidencias : UBICACION_EXTRA.unaCoincidencia);
    } catch {
      if (id === searchId) say(UBICACION_ESTADO.errorBusqueda);
    }
  }
  ff('search').addEventListener('click', () => void search());
  field('place').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      void search();
    }
  });

  // ---------- Resultado ----------

  let current: { input: FarmInput; response: AnalyzeResponse; origin: AnalyzeSuccess['origin'] } | null = null;
  const facts = (f: Finding[]) => f.map(explainFinding);

  function renderPlan(role: 'A' | 'B', plan: Plan | null) {
    const mount = ff(role === 'A' ? 'plan-a' : 'plan-b');
    const el = clone('plan');
    if (!plan) {
      fill(el, { role: ROL_PLAN[role], title: FLUJO.sinPlan.titulo });
      el.querySelector('[data-slot="state"]')!.replaceChildren(message(role === 'B' ? planBPendiente() : FLUJO.sinPlan));
      el.querySelectorAll('[data-group]').forEach((g) => ((g as HTMLElement).hidden = true));
      el.querySelector('[data-slot="intro"]')?.remove();
    } else {
      fill(el, {
        role: ROL_PLAN[role],
        title: plan.cropIds.length ? plan.cropIds.map(cropName).join(', luego ') : 'Cultivo por definir',
        intro: NATURALEZA_ESCENARIO[plan.scenario.nature],
      });
      if (plan.completeness === 'incomplete') {
        const first = plan.toVerify[0];
        el.querySelector('[data-slot="state"]')!.replaceChildren(message(role === 'B' ? planBPendiente(first && explainFinding(first)) : FLUJO.planIncompleto));
      }
      const groups = { signals: plan.reconsiderSignals, reasons: plan.reasons, restrictions: plan.restrictions, actions: plan.actions, toverify: plan.toVerify };
      for (const [name, findings] of Object.entries(groups)) {
        const g = one<HTMLElement>(`[data-group="${name}"]`, el);
        list(g, facts(findings));
        g.hidden = findings.length === 0;
      }
    }
    mount.replaceChildren(el);
  }

  const day = (iso: string) => new Date(iso).toLocaleDateString('es', { dateStyle: 'medium' });

  function renderSources(response: AnalyzeResponse) {
    const { records, sources } = response.result.climate;
    type Item = { r: EvidenceRecord | null; state: (typeof sources)[number]['state']; source: (typeof sources)[number]['source'] };
    const items: Item[] = sources
      .filter((s) => s.source !== 'complement')
      .flatMap((s): Item[] => {
        const mine = records.filter((r) => r.source === s.source);
        return mine.length ? mine.map((r) => ({ r, state: s.state, source: s.source })) : [{ r: null, state: s.state, source: s.source }];
      });
    const nodes = items.map((it) => {
      const li = clone('source');
      const r = it.r;
      one('[data-slot="state"]', li).replaceChildren(...(it.state === 'available' ? [] : [message(ESTADO_FUENTE[it.state])]));
      if (!r) {
        fill(li, { name: FUENTES[it.source] });
        li.querySelector('[data-slot="link"]')?.parentElement?.remove();
        li.querySelector('dl')?.remove();
        return li;
      }
      const link = one<HTMLAnchorElement>('[data-slot="link"]', li);
      link.href = r.dataset.url;
      link.textContent = `${r.dataset.product} (versión ${r.dataset.version})`;
      fill(li, {
        name: FUENTES[r.source],
        variable: r.variable,
        unit: r.unit,
        period: `${r.period.start} a ${r.period.end}`,
        retrieved: day(r.retrievedAt),
        scale: r.grid.nativeResolution,
        validity: r.cache.expiresAt ? `Vigente hasta ${day(r.cache.expiresAt)}` : 'Copia guardada, sin fecha de vencimiento',
        origin: ORIGEN_DATO[r.cache.origin],
      });
      list(li, [`Datos válidos: ${r.coverage.validCount} de ${r.coverage.expectedCount}`, ...r.limitations], 'limitations');
      return li;
    });
    ff('sources-list').replaceChildren(...nodes);
  }

  function renderAlerts(alerts: Alert[]) {
    const box = ff('alerts');
    box.replaceChildren(
      ...alerts.map((a) => {
        const km = a.nearestKm.toLocaleString('es', { maximumFractionDigits: 0 });
        return message({ ...ALERTA_FUEGO, explicacion: `${ALERTA_FUEGO.explicacion} Detecciones en las últimas 24 horas: ${a.count}; la más cercana, a unos ${km} km.` });
      }),
    );
    box.hidden = alerts.length === 0;
  }

  function originMessage(s: AnalyzeSuccess): Mensaje | null {
    if (s.origin === 'network') return null;
    const age = hace(Date.now() - Date.parse(s.savedAt));
    if (s.origin === 'local') return FLUJO.planLocal;
    if (s.stale) return fuenteAtrasada(age);
    return navigator.onLine ? planGuardado(age) : ESTADOS.sinRedConPlan;
  }

  function render(s: AnalyzeSuccess, input: FarmInput) {
    const { result, alerts } = s.response;
    current = { input, response: s.response, origin: s.origin };
    show(ff('result-state'), RESULTADO[result.status]);
    renderPlan('A', result.planA);
    renderPlan('B', result.planB);
    const missing = ff('missing');
    list(missing, facts(result.missing));
    missing.hidden = result.missing.length === 0;
    renderAlerts(alerts);
    renderSources(s.response);
    ff('answer').replaceChildren();
    ff('refresh').hidden = s.origin === 'network' || !navigator.onLine;
    results.hidden = false;
    setStatus(originMessage(s));
  }

  // ---------- Envío ----------

  const submit = ff<HTMLButtonElement>('submit');
  let runId = 0;

  async function run(input: FarmInput) {
    const id = ++runId;
    loading.hidden = false;
    submit.textContent = BOTON_ENVIAR.enviando;
    submit.setAttribute('aria-busy', 'true');
    const done = () => {
      if (id !== runId) return false;
      loading.hidden = true;
      submit.textContent = BOTON_ENVIAR.reposo;
      submit.removeAttribute('aria-busy');
      return true;
    };
    const out = await analyzeFarm(input, {
      onCached: (c) => {
        if (id !== runId) return;
        render(c, input);
        setStatus(FLUJO.mostrandoGuardado);
      },
    });
    if (out.kind === 'superseded' || !done()) return;
    switch (out.kind) {
      case 'result':
        render(out, input);
        resultsTitle.focus();
        return;
      case 'invalid':
        for (const i of out.issues) {
          const g = ({ location: 'ubicacion', crop: 'cultivo', goal: 'objetivo', water: 'agua', planting: 'siembra' } as const)[i.path.split('.')[0] as 'location'];
          if (g) setError(g, CAMPOS[g].error);
        }
        setStatus(ESTADOS.entradaInvalida);
        focusFirstError();
        return;
      case 'rate_limited':
        setStatus(cupoAgotado(out.retryAfterSeconds * 1000));
        return;
      case 'offline_no_data':
        setStatus(navigator.onLine ? ESTADOS.sinRed : FLUJO.sinDatosLocales);
        return;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { input, errors } = readForm();
    for (const g of GROUPS) setError(g, errors[g] ?? null);
    if (!input) {
      setStatus(ESTADOS.entradaInvalida);
      focusFirstError();
      return;
    }
    setStatus(null);
    void run(input);
  });

  ff('refresh').addEventListener('click', () => current && void run(current.input));
  ff('edit').addEventListener('click', () => {
    results.hidden = true;
    ff('gps').focus();
  });

  // ---------- Preguntas ----------

  let askId = 0;
  for (const btn of root.querySelectorAll<HTMLButtonElement>('[data-ff-question]')) {
    btn.addEventListener('click', () => {
      if (!current) return;
      const questionId = btn.dataset.ffQuestion as QuestionId;
      if (!QUESTION_IDS.includes(questionId)) return;
      const id = ++askId;
      const { result, explain } = current.response;
      const texts = (keys: string[]) => {
        const byKey = new Map(listFacts(result).map((f) => [f.key, explainFinding(f.fact)]));
        return keys.flatMap((k) => byKey.get(k) ?? []);
      };
      const box = ff('answer');
      const paint = (origin: string, items: string[]) => {
        const el = clone('answer');
        fill(el, { origin });
        list(el, items);
        box.replaceChildren(el);
      };
      const localItems = texts(answerLocally(questionId, result));
      paint(RESPUESTA_ORIGEN.local, localItems);
      // Bedrock solo se invoca por esta pregunta, y la respuesta local ya está en pantalla
      if (!explain || !navigator.onLine) return;
      void fetch('/api/explain', { method: 'POST', body: JSON.stringify({ context: explain, questionId }), signal: AbortSignal.timeout(REQUEST_MS) })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { source?: string; items?: { text?: unknown }[] } | null) => {
          if (id !== askId || body?.source !== 'model' || !Array.isArray(body.items)) return;
          const items = body.items.flatMap((i) => (typeof i.text === 'string' ? [i.text] : []));
          if (items.length && items.join('\n') !== localItems.join('\n')) paint(RESPUESTA_ORIGEN.ia, items);
        })
        .catch(() => {});
    });
  }

  // ---------- Planes guardados ----------

  const saved = ff('saved');
  const savedList = ff('saved-list');
  const savedTitle = one<HTMLElement>('#saved-title');
  savedTitle.tabIndex = -1;
  async function refreshSaved() {
    const plans = await storage.listSaved();
    savedList.replaceChildren(
      ...plans.map((p) => {
        const li = clone('saved-item');
        li.dataset.id = p.id;
        fill(li, { title: p.label, date: new Date(p.savedAt).toLocaleDateString('es', { dateStyle: 'medium' }) });
        one('[data-act="open"]', li).setAttribute('aria-label', `Ver ${p.label}`);
        one('[data-act="delete"]', li).setAttribute('aria-label', `Quitar ${p.label}`);
        return li;
      }),
    );
    saved.hidden = plans.length === 0;
    return plans;
  }

  ff('save').addEventListener('click', async () => {
    if (!current) return;
    await storage.ready();
    if (!storage.persistent) return setStatus({ tono: 'aviso', titulo: 'No se guardó', explicacion: GUARDADO_ESTADO.error });
    await storage.savePlan(current.input, current.response);
    await refreshSaved();
    setStatus({ tono: 'exito', titulo: 'Plan guardado', explicacion: GUARDADO_ESTADO.guardado });
  });

  savedList.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    const id = btn?.closest<HTMLElement>('li')?.dataset.id;
    if (!btn || !id) return;
    if (btn.dataset.act === 'delete') {
      await storage.deletePlan(id);
      await refreshSaved();
      setStatus({ tono: 'info', titulo: 'Plan quitado', explicacion: GUARDADO_ESTADO.quitado });
      savedTitle.focus();
      return;
    }
    const plan: SavedPlan | undefined = (await storage.listSaved()).find((p) => p.id === id);
    if (!plan) return;
    runId++; // cancela cualquier análisis en curso: manda el plan abierto
    loading.hidden = true;
    applyInput(plan.input);
    render({ kind: 'result', origin: 'saved', savedAt: plan.savedAt, stale: Date.now() - Date.parse(plan.savedAt) > FRESH_MS, response: plan.response }, plan.input);
    resultsTitle.focus();
  });

  // ---------- Red y modo sin conexión ----------

  let offlineReady = false;
  function paintNet() {
    show(net, !navigator.onLine ? FLUJO.sinConexion : offlineReady ? FLUJO.listoSinRed : null);
    if (current) ff('refresh').hidden = current.origin === 'network' || !navigator.onLine;
  }
  window.addEventListener('online', paintNet);
  window.addEventListener('offline', paintNet);
  void registerOffline((state) => {
    offlineReady = state === 'ready';
    paintNet();
  });
  paintNet();

  void refreshSaved();
}
