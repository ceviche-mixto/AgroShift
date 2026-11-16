import type { Alert, AnalyzeResponse, EvidenceRecord, FarmInput, Finding, Plan } from '../domain/contracts.ts';
import { climateSummary, type ClimateFigure } from '../domain/climate-summary.ts';
import type { LatLon, ParcelShape } from '../domain/parcel.ts';
import { findCrop, nameKeys, suggestCrops, type CropSuggestion } from '../domain/crops.ts';
import { answerLocally, cropName, explainFinding, familyName, listFacts, needsIrrigation, type QuestionId, QUESTION_IDS } from '../domain/explain.ts';
import { parseFarmInput } from '../domain/schemas.ts';
import { DEFAULT_LANG, dict, isLang, type Lang } from '../i18n/index.ts';
import { evidenceText } from '../i18n/evidence-en.ts';
import type { Mensaje } from '../i18n/es.ts';
import { analyzeFarm, FRESH_MS, type AnalyzeSuccess } from '../services/browser/analyze.ts';
import { registerOffline } from '../services/browser/offline.ts';
import { browserStorage, type SavedPlan } from '../services/browser/storage.ts';

// El idioma lo fija la ruta (`/` inglés, `/es/` español): `<html lang>` ya viene en el HTML.
const htmlLang = document.documentElement.lang;
const lang: Lang = isLang(htmlLang) ? htmlLang : DEFAULT_LANG;
const {
  ALERTA_FUEGO,
  BOTON_ENVIAR,
  cupoAgotado,
  detalleFuego,
  ESTADO_FUENTE,
  ESTADO_FUENTE_FIRMS,
  ESTADOS,
  FLUJO,
  FUENTES,
  fuenteAtrasada,
  GUARDADO_ESTADO,
  hace,
  CAMPOS,
  CLIMA_ZONA,
  MAPA_PARCELA,
  NATURALEZA_ESCENARIO,
  ORIGEN_DATO,
  PANEL_FUENTES,
  PASOS,
  PLAN_INSIGNIA,
  PLAN_TITULO,
  PLANES_GUARDADOS,
  planGuardado,
  RESPUESTA_ORIGEN,
  RESULTADO,
  ROL_PLAN,
  TONOS,
  UBICACION_ESTADO,
  UBICACION_EXTRA,
} = dict(lang);

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
  // Un error en otro paso lleva a ese paso antes de enfocar el control.
  function focusFirstError() {
    const g = GROUPS.find((x) => !errorEl(x).hidden);
    if (!g) return;
    goTo(GROUPS.indexOf(g));
    controlsOf(g).find((c) => c.offsetParent !== null)?.focus();
  }
  form.addEventListener('input', (e) => {
    const g = GROUPS.find((x) => (e.target as HTMLElement).getAttribute('aria-describedby')?.split(' ').includes(`error-${x}`));
    if (g) setError(g, null);
    sync();
  });
  form.addEventListener('change', sync);

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
    const monthPart = field<HTMLSelectElement>('planting_month_m').value;
    const yearPart = field<HTMLSelectElement>('planting_month_y').value;
    const month = monthPart && yearPart ? `${yearPart}-${monthPart}` : '';
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

  /** Decimal de la ruta: coma en español, punto en inglés. */
  const localNum = (n: number) => (lang === 'en' ? String(n) : String(n).replace('.', ','));
  function applyInput(input: FarmInput) {
    field('lat').value = localNum(input.location.lat);
    field('lon').value = localNum(input.location.lon);
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
    const ym = input.planting.status === 'known' && input.planting.precision === 'month' ? input.planting.date.slice(0, 7) : '-';
    field<HTMLSelectElement>('planting_month_y').value = ym.split('-')[0] ?? '';
    field<HTMLSelectElement>('planting_month_m').value = ym.split('-')[1] ?? '';
    for (const g of GROUPS) setError(g, null);
    showCoords(input.location.origin === 'manual_coordinates');
    sync();
  }

  // ---------- Cultivo: opciones grandes y autocompletado con sinónimos ----------

  const cropInput = field('crop_name');
  const cropUnknownBox = field('crop_unknown');
  const cropPicks = [...form.querySelectorAll<HTMLButtonElement>('[data-ff-crop-pick]')];
  const cropOther = ff<HTMLButtonElement>('crop-other');
  const cropList = ff<HTMLUListElement>('crop-suggestions');
  const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  let activeOption = -1;

  /** Marca la opción grande que coincide con lo escrito (sinónimos incluidos); «Otro cultivo» si no hay ficha. */
  function paintCropPicks() {
    const typed = cropInput.value.trim();
    const hit = typed ? findCrop(typed) : null;
    for (const b of cropPicks) b.setAttribute('aria-pressed', String(!cropUnknownBox.checked && !!hit && b.dataset.cropId === hit.id));
    cropOther.setAttribute('aria-pressed', String(!cropUnknownBox.checked && !!typed && !hit));
  }
  const notifyCrop = () => cropInput.dispatchEvent(new Event('input', { bubbles: true }));

  function closeCropList() {
    cropList.style.visibility = '';
    cropList.hidden = true;
    cropList.replaceChildren();
    activeOption = -1;
    cropInput.setAttribute('aria-expanded', 'false');
    cropInput.removeAttribute('aria-activedescendant');
  }
  function chooseCrop(value: string) {
    cropUnknownBox.checked = false;
    cropInput.value = value;
    notifyCrop();
    closeCropList();
  }
  const suggestionValue = (s: CropSuggestion) => (s.kind === 'catalog' ? capital(cropName(s.cropId, lang)) : capital(s.alias));
  function renderCropList() {
    const items = cropUnknownBox.checked ? [] : suggestCrops(cropInput.value);
    if (!items.length) return closeCropList();
    cropList.replaceChildren(
      ...items.map((s, i) => {
        const li = document.createElement('li');
        li.id = `crop-opt-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.className = 'combo__opcion';
        const value = suggestionValue(s);
        li.dataset.value = value;
        const hint =
          s.kind === 'family'
            ? CAMPOS.cultivo.sugerenciaFamilia(familyName(s.groupId, lang))
            : nameKeys(s.alias).join() !== nameKeys(value).join()
              ? s.alias
              : '';
        li.append(Object.assign(document.createElement('strong'), { textContent: value }));
        if (hint) li.append(Object.assign(document.createElement('span'), { textContent: ` (${hint})`, className: 'texto-suave' }));
        return li;
      }),
    );
    activeOption = -1;
    cropList.style.visibility = '';
    cropList.hidden = false;
    cropInput.setAttribute('aria-expanded', 'true');
    cropInput.removeAttribute('aria-activedescendant');
  }
  function moveOption(to: number) {
    const opts = [...cropList.children] as HTMLElement[];
    if (!opts.length) return;
    activeOption = (to + opts.length) % opts.length;
    opts.forEach((o, i) => o.setAttribute('aria-selected', String(i === activeOption)));
    cropInput.setAttribute('aria-activedescendant', opts[activeOption]!.id);
    opts[activeOption]!.scrollIntoView?.({ block: 'nearest' });
  }

  for (const b of cropPicks) b.addEventListener('click', () => chooseCrop(b.dataset.ffCropPick!));
  cropOther.addEventListener('click', () => {
    cropUnknownBox.checked = false;
    if (findCrop(cropInput.value)) cropInput.value = '';
    notifyCrop();
    cropInput.focus();
  });
  cropInput.addEventListener('input', (e) => e.isTrusted && renderCropList());
  // Al salir del campo la lista se oculta pero conserva su espacio hasta terminar el clic: si se colapsara
  // en el mousedown, el botón que se está tocando («Siguiente») se movería y el clic se perdería.
  cropInput.addEventListener('blur', () => {
    if (cropList.hidden) return;
    cropList.style.visibility = 'hidden';
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('click', done, true);
      if (document.activeElement !== cropInput) closeCropList();
    };
    const timer = setTimeout(done, 600);
    window.addEventListener('click', done, true);
  });
  cropInput.addEventListener('keydown', (e) => {
    if (cropList.hidden) {
      if (e.key === 'ArrowDown') renderCropList(), moveOption(0);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveOption(activeOption + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && activeOption >= 0) {
      e.preventDefault(); // elegir la sugerencia no avanza de paso
      chooseCrop((cropList.children[activeOption] as HTMLElement).dataset.value!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCropList();
    }
  });
  // Mantiene el foco en el campo al tocar una sugerencia
  cropList.addEventListener('pointerdown', (e) => e.preventDefault());
  cropList.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (li) chooseCrop(li.dataset.value!);
  });

  // ---------- Pasos (una pregunta a la vez; los campos siguen en el DOM, solo se ocultan) ----------

  const steps = GROUPS.map((g) => one<HTMLElement>(`[data-ff-step="${g}"]`));
  const last = GROUPS.length - 1;
  const stepCount = ff('step-count');
  const progress = ff('progress');
  const progressBar = ff('progress-bar');
  const stepName = ff('step-name');
  const dots = [...form.querySelectorAll<HTMLElement>('[data-ff-dot]')];
  const back = ff<HTMLButtonElement>('back');
  const next = ff<HTMLButtonElement>('next');
  const stepHint = ff('step-hint');
  const lastNote = ff('last-note');
  let step = 0;

  const stepValid = () => !readForm().errors[GROUPS[step]!];

  /** Habilita «Siguiente» / «Ver mi plan» solo cuando el paso actual está bien respondido. */
  function sync() {
    paintCropPicks();
    const ok = stepValid();
    next.disabled = !ok;
    submit.disabled = !ok;
    stepHint.hidden = ok;
    paintLocationReady();
    saveDraft();
  }

  /** Tarjeta «Ubicación lista»: aparece en cuanto hay unas coordenadas válidas, vengan de donde vengan. */
  function paintLocationReady() {
    const p = typedPoint();
    locReady.hidden = !p;
    if (p) locReadyCoords.textContent = `${coord(p.lat)}, ${coord(p.lon)}`;
  }

  function goTo(i: number, focus = true) {
    step = Math.max(0, Math.min(last, i));
    steps.forEach((s, n) => (s.hidden = n !== step));
    const label = PASOS.conteo(step + 1, GROUPS.length);
    stepCount.textContent = label;
    progress.setAttribute('aria-valuenow', String(step + 1));
    progress.setAttribute('aria-valuetext', label);
    progressBar.style.width = `${(step / last) * 100}%`;
    stepName.textContent = PASOS.nombres[step] ?? '';
    dots.forEach((d, n) => (d.dataset.estado = n < step ? 'hecho' : n === step ? 'actual' : 'pendiente'));
    if (step === 0) parcelMap?.refresh(typedPoint()); // el mapa estuvo oculto: recalcula su tamaño
    back.hidden = step === 0;
    next.hidden = step === last;
    submit.hidden = step !== last;
    lastNote.hidden = step !== last;
    sync();
    if (focus) steps[step]!.querySelector<HTMLElement>('input:not([type="hidden"]), button')?.focus();
  }

  back.addEventListener('click', () => goTo(step - 1));
  next.addEventListener('click', () => stepValid() && goTo(step + 1));
  // Enter avanza (o envía en el último paso) si la respuesta es válida; en botones y en la búsqueda hace lo suyo.
  form.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || t instanceof HTMLButtonElement) return;
    e.preventDefault();
    if (!stepValid()) return;
    if (step === last) form.requestSubmit();
    else goTo(step + 1);
  });

  // ---------- Ubicación: GPS y búsqueda ----------

  const coords = ff('coords');
  const coordsToggle = ff<HTMLButtonElement>('coords-toggle');
  function showCoords(open: boolean) {
    coords.hidden = !open;
    coordsToggle.setAttribute('aria-expanded', String(open));
  }
  coordsToggle.addEventListener('click', () => showCoords(coordsToggle.getAttribute('aria-expanded') !== 'true'));

  const locStatus = ff('location-status');
  const placeResults = ff<HTMLFieldSetElement>('place-results');
  const say = (text: string) => (locStatus.textContent = text);
  /** Mensajes que mandan a escribir las coordenadas: las deja a la vista. */
  const sayManual = (text: string) => {
    showCoords(true);
    say(text);
  };
  const manual = () => {
    field('origin').value = 'manual_coordinates';
    field('accuracy').value = '';
  };
  for (const n of ['lat', 'lon']) field(n).addEventListener('input', manual);

  ff('gps').addEventListener('click', () => {
    setError('ubicacion', null);
    if (!('geolocation' in navigator)) return sayManual(CAMPOS.ubicacion.errorGps);
    say(UBICACION_ESTADO.buscandoGps);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        field('lat').value = localNum(Number(p.coords.latitude.toFixed(5)));
        field('lon').value = localNum(Number(p.coords.longitude.toFixed(5)));
        field('origin').value = 'gps';
        field('accuracy').value = String(Math.round(p.coords.accuracy));
        placeResults.hidden = true;
        sync();
        parcelMap?.refresh(typedPoint());
        say(p.coords.accuracy > 1000 ? UBICACION_ESTADO.gpsAproximada(p.coords.accuracy) : UBICACION_ESTADO.gpsListo);
      },
      () => sayManual(CAMPOS.ubicacion.errorGps),
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
      const body = (await res.json()) as { places: Place[] };
      if (id !== searchId) return;
      if (!body.places.length) return sayManual(UBICACION_ESTADO.sinCoincidencias);
      const options = body.places.map((p) => {
        const label = clone('place-option');
        fill(label, { name: p.detail ? `${p.name}, ${p.detail}` : p.name, coords: `${localNum(p.lat)}, ${localNum(p.lon)}` });
        const radio = one<HTMLInputElement>('input', label);
        radio.addEventListener('change', () => {
          field('lat').value = localNum(p.lat);
          field('lon').value = localNum(p.lon);
          field('origin').value = 'place_search';
          field('accuracy').value = '';
          setError('ubicacion', null);
          parcelMap?.refresh(typedPoint());
          say(`${UBICACION_ESTADO.elegida(p.name)} ${UBICACION_ESTADO.coincidenciaAproximada}`);
        });
        return label;
      });
      placeResults.replaceChildren(placeResults.querySelector('legend')!, ...options);
      placeResults.hidden = false;
      say(body.places.length > 1 ? UBICACION_ESTADO.variasCoincidencias : UBICACION_EXTRA.unaCoincidencia);
    } catch {
      if (id === searchId) sayManual(UBICACION_ESTADO.errorBusqueda);
    }
  }
  ff('search').addEventListener('click', () => void search());
  field('place').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      void search();
    }
  });

  // ---------- Ubicación: mapa satelital (Leaflet se descarga solo al abrirlo) ----------

  const mapBox = ff('map');
  const mapStatus = ff('map-status');
  const mapUse = ff<HTMLButtonElement>('map-use');
  const locReady = ff('loc-ready');
  const locReadyCoords = ff('loc-ready-coords');
  let parcelMap: import('./parcel-map.ts').ParcelMap | null = null;
  let mapLoading = false;
  let draftPoints: LatLon[] = []; // esquinas del borrador, hasta que el mapa se monte

  const typedPoint = (): LatLon | null => {
    const lat = num(field('lat').value);
    const lon = num(field('lon').value);
    return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 ? { lat, lon } : null;
  };
  const coord = (n: number) => localNum(Number(n.toFixed(5)));
  function describeMap(points: LatLon[], shape: ParcelShape | null) {
    draftPoints = points;
    saveDraft();
    mapUse.disabled = !shape;
    if (!shape) {
      mapStatus.textContent = MAPA_PARCELA.vacio;
      return;
    }
    const lat = coord(shape.center.lat);
    const lon = coord(shape.center.lon);
    const ha = shape.hectares?.toLocaleString(lang, { maximumFractionDigits: shape.hectares < 1 ? 2 : 1 });
    mapStatus.textContent = ha ? MAPA_PARCELA.parcela(points.length, lat, lon, ha) : MAPA_PARCELA.centro(lat, lon);
  }

  // El mapa está a la vista en el paso 1, pero Leaflet (chunk aparte) solo se descarga cuando el mapa entra en pantalla.
  async function loadMap() {
    if (parcelMap || mapLoading) return;
    mapLoading = true;
    mapStatus.textContent = MAPA_PARCELA.cargando;
    try {
      const { mountParcelMap } = await import('./parcel-map.ts');
      const start = typedPoint() ?? draftPoints[0] ?? null;
      parcelMap = mountParcelMap({ el: ff('map-canvas'), start, text: MAPA_PARCELA, initial: draftPoints, onChange: describeMap });
      if (!draftPoints.length) mapStatus.textContent = MAPA_PARCELA.vacio;
    } catch {
      mapStatus.textContent = MAPA_PARCELA.errorCarga;
      showCoords(true);
    } finally {
      mapLoading = false;
    }
  }
  if ('IntersectionObserver' in window) {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      void loadMap();
    });
    seen.observe(mapBox);
  } else void loadMap();
  ff('map-center').addEventListener('click', () => parcelMap?.markCenter());
  ff('map-clear').addEventListener('click', () => parcelMap?.clear());
  // Mismo camino que escribir las coordenadas: los eventos `input` limpian el error, marcan el origen manual y sincronizan.
  mapUse.addEventListener('click', () => {
    const shape = parcelMap?.shape();
    if (!shape) return;
    const lat = coord(shape.center.lat);
    const lon = coord(shape.center.lon);
    field('lat').value = lat;
    field('lon').value = lon;
    placeResults.hidden = true;
    for (const n of ['lat', 'lon']) field(n).dispatchEvent(new Event('input', { bubbles: true }));
    say(MAPA_PARCELA.aplicada(lat, lon));
  });

  // ---------- Resultado ----------

  let current: { input: FarmInput; response: AnalyzeResponse; origin: AnalyzeSuccess['origin'] } | null = null;
  const facts = (f: Finding[]) => f.map((x) => explainFinding(x, lang));

  function renderPlan(role: 'A' | 'B', plan: Plan | null) {
    const mount = ff(role === 'A' ? 'plan-a' : 'plan-b');
    const el = clone('plan');
    if (!plan) {
      fill(el, { role: ROL_PLAN[role], title: FLUJO.sinPlan.titulo });
      // Sin plan: una frase, no otra caja (el resultado ya trae su aviso general)
      fill(el, { intro: (role === 'B' ? ESTADOS.planBPendiente : FLUJO.sinPlan).explicacion });
      el.querySelectorAll('[data-group]').forEach((g) => ((g as HTMLElement).hidden = true));
    } else {
      // Una sola señal por plan: «Requiere riego» es una condición de manejo; «Falta información» solo si la persona puede aportar el dato
      const condition = plan.completeness === 'incomplete' ? PLAN_INSIGNIA.falta : needsIrrigation(plan) ? PLAN_INSIGNIA.riego : '';
      fill(el, {
        role: ROL_PLAN[role],
        title: plan.kind === 'fallow' ? PLAN_TITULO.descanso : plan.cropIds.length ? plan.cropIds.map((c) => cropName(c, lang)).join(PLANES_GUARDADOS.separadorCultivos) : PLAN_TITULO.porDefinir,
        condition,
        intro: NATURALEZA_ESCENARIO[plan.scenario.nature],
      });
      const groups = { signals: plan.reconsiderSignals, reasons: plan.reasons, restrictions: plan.restrictions, actions: plan.actions, toverify: plan.toVerify };
      for (const [name, findings] of Object.entries(groups)) {
        const g = one<HTMLElement>(`[data-group="${name}"]`, el);
        list(g, facts(findings));
        g.hidden = findings.length === 0;
      }
    }
    mount.replaceChildren(el);
  }

  const day = (iso: string) => new Date(iso).toLocaleDateString(lang, { dateStyle: 'medium' });

  /** «Clima de tu zona»: cifras reales de NASA POWER y SMAP de la respuesta; sin dato, texto neutro. */
  function renderClimate(records: EvidenceRecord[]) {
    const s = climateSummary(records);
    const n = (v: number, digits: number) => v.toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const rows: [string, ClimateFigure | null, (v: number) => string][] = [
      ['temp', s.meanTempC, (v) => CLIMA_ZONA.grados(n(v, 1))],
      ['rain', s.annualRainMm, (v) => CLIMA_ZONA.milimetros(n(v, 0))],
      ['soil', s.soilMoisture, (v) => CLIMA_ZONA.porcentajeSuelo(n(v * 100, 0))],
    ];
    for (const [key, fig, text] of rows) {
      const row = one<HTMLElement>(`[data-row="${key}"]`, ff('climate'));
      fill(row, {
        value: fig ? text(fig.value) : CLIMA_ZONA.noDisponible,
        source: fig ? CLIMA_ZONA.fuente(CLIMA_ZONA.fuentes[fig.source]) : '',
        period: fig ? CLIMA_ZONA.periodo(PANEL_FUENTES.rango(day(fig.period.start), day(fig.period.end))) : '',
      });
    }
    ff('climate').hidden = false;
  }

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
      one('[data-slot="state"]', li).replaceChildren(...(it.state === 'available' ? [] : [message((it.source === 'firms' && ESTADO_FUENTE_FIRMS[it.state]) || ESTADO_FUENTE[it.state])]));
      if (!r) {
        fill(li, { name: FUENTES[it.source] });
        li.querySelector('[data-slot="link"]')?.parentElement?.remove();
        li.querySelector('dl')?.remove();
        return li;
      }
      const link = one<HTMLAnchorElement>('[data-slot="link"]', li);
      link.href = r.dataset.url;
      link.textContent = `${r.dataset.product} (${PANEL_FUENTES.version(r.dataset.version)})`;
      fill(li, {
        name: FUENTES[r.source],
        variable: evidenceText(lang, r.variable),
        unit: r.unit,
        period: PANEL_FUENTES.rango(r.period.start, r.period.end),
        retrieved: day(r.retrievedAt),
        scale: evidenceText(lang, r.grid.nativeResolution),
        validity: r.cache.expiresAt ? PANEL_FUENTES.vigenteHasta(day(r.cache.expiresAt)) : PANEL_FUENTES.sinVencimiento,
        origin: ORIGEN_DATO[r.cache.origin],
      });
      list(li, [PANEL_FUENTES.validos(r.coverage.validCount, r.coverage.expectedCount), ...r.limitations.map((l) => evidenceText(lang, l))], 'limitations');
      return li;
    });
    ff('sources-list').replaceChildren(...nodes);
  }

  function renderAlerts(alerts: Alert[]) {
    const box = ff('alerts');
    box.replaceChildren(
      ...alerts.map((a) => {
        const km = a.nearestKm.toLocaleString(lang, { maximumFractionDigits: 0 });
        return message({ ...ALERTA_FUEGO, explicacion: `${ALERTA_FUEGO.explicacion} ${detalleFuego(a.count, km)}` });
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
    renderClimate(result.climate.records);
    renderAlerts(alerts);
    renderSources(s.response);
    ff('answer').replaceChildren();
    ff('refresh').hidden = s.origin === 'network' || !navigator.onLine;
    if (results.hidden) results.setAttribute('data-anim', ''); // el escalonado solo en la primera aparición, no al sustituir el plan guardado por el de la red
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
    if (step < last) return; // Enter en un paso intermedio lo maneja el avance
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
    results.removeAttribute('data-anim');
    goTo(0);
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
        const byKey = new Map(listFacts(result).map((f) => [f.key, explainFinding(f.fact, lang)]));
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
      void fetch('/api/explain', { method: 'POST', body: JSON.stringify({ context: explain, questionId, lang }), signal: AbortSignal.timeout(REQUEST_MS) })
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
        fill(li, { title: p.label, date: new Date(p.savedAt).toLocaleDateString(lang, { dateStyle: 'medium' }) });
        one('[data-act="open"]', li).setAttribute('aria-label', PLANES_GUARDADOS.ver(p.label));
        one('[data-act="delete"]', li).setAttribute('aria-label', PLANES_GUARDADOS.quitar(p.label));
        return li;
      }),
    );
    saved.hidden = plans.length === 0;
    return plans;
  }

  ff('save').addEventListener('click', async () => {
    if (!current) return;
    await storage.ready();
    if (!storage.persistent) return setStatus({ tono: 'aviso', titulo: PLANES_GUARDADOS.tituloError, explicacion: GUARDADO_ESTADO.error });
    const { input } = current;
    const label = PLANES_GUARDADOS.etiqueta(input.crop.status === 'known' ? input.crop.name : null, input.location.lat, input.location.lon, new Date().toISOString().slice(0, 10));
    await storage.savePlan(input, current.response, label);
    await refreshSaved();
    setStatus({ tono: 'exito', titulo: PLANES_GUARDADOS.tituloGuardado, explicacion: GUARDADO_ESTADO.guardado });
  });

  savedList.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    const id = btn?.closest<HTMLElement>('li')?.dataset.id;
    if (!btn || !id) return;
    if (btn.dataset.act === 'delete') {
      await storage.deletePlan(id);
      await refreshSaved();
      setStatus({ tono: 'info', titulo: PLANES_GUARDADOS.tituloQuitado, explicacion: GUARDADO_ESTADO.quitado });
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

  // ---------- Borrador: cambiar EN | ES (otra ruta) no borra lo ya respondido ----------

  const DRAFT_KEY = 'agroshift.draft';
  interface Draft { step: number; fields: Record<string, string | boolean>; points: LatLon[] }
  let restoring = true; // hasta restaurar, sync() no debe pisar el borrador guardado
  const draftControls = () =>
    [...form.elements].filter((el): el is HTMLInputElement | HTMLSelectElement => (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && !!el.name && el.name !== 'place_choice');

  function saveDraft() {
    if (restoring) return;
    const fields: Draft['fields'] = {};
    for (const el of draftControls()) {
      const kind = el instanceof HTMLInputElement ? el.type : 'select';
      if (kind === 'radio') {
        if ((el as HTMLInputElement).checked) fields[el.name] = el.value;
      } else fields[el.name] = kind === 'checkbox' ? (el as HTMLInputElement).checked : el.value;
    }
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ step, fields, points: draftPoints } satisfies Draft));
    } catch {
      // sin almacenamiento: el formulario funciona igual
    }
  }

  /** Devuelve el paso guardado (0 si no hay borrador). Coordenadas y cultivo se reexpresan en el idioma de esta ruta. */
  function restoreDraft(): number {
    let d: Draft | null = null;
    try {
      d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null');
    } catch {
      return 0;
    }
    if (!d || typeof d.fields !== 'object' || d.fields === null) return 0;
    for (const el of draftControls()) {
      const saved = d.fields[el.name];
      const kind = el instanceof HTMLInputElement ? el.type : 'select';
      if (kind === 'radio') (el as HTMLInputElement).checked = saved === el.value;
      else if (kind === 'checkbox') (el as HTMLInputElement).checked = saved === true;
      else if (typeof saved === 'string') {
        let v = saved;
        if (el.name === 'lat' || el.name === 'lon') v = Number.isFinite(num(v)) ? localNum(num(v)) : v;
        else if (el.name === 'crop_name') {
          const hit = findCrop(v);
          if (hit) v = capital(cropName(hit.id, lang));
        }
        el.value = v;
      }
    }
    const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
    draftPoints = Array.isArray(d.points) ? d.points.filter((p) => ok(p?.lat) && ok(p?.lon)).slice(0, 4) : [];
    showCoords(field('origin').value === 'manual_coordinates' && !!field('lat').value);
    return Number.isInteger(d.step) ? Math.max(0, Math.min(last, d.step)) : 0;
  }
  window.addEventListener('pagehide', saveDraft);

  const startStep = restoreDraft();
  restoring = false;
  goTo(startStep, false);
  void refreshSaved();
}
