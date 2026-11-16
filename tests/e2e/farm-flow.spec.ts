import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import type { AnalyzeResponse, FarmInput } from '../../src/domain/contracts.ts';
import { cropName } from '../../src/domain/explain.ts';
import { evaluateRotation } from '../../src/domain/rotation.ts';
import { analyzeResponseSchema } from '../../src/domain/schemas.ts';
import { farm, responseFor } from '../browser/fixtures.ts';

// Flujo completo contra la salida estática del build (service worker real). Las API se simulan con
// el MISMO motor y contrato que usa el servidor: la respuesta sale de computeLocal / evaluateRotation.

const INDIA = { lat: '12,97', lon: '77,59' };
const NOW = new Date('2026-11-15T12:00:00Z');

/** Entrada de India que corresponde a lo que escribe `fillForm` con los valores por defecto. */
const indiaInput = (extra: Partial<FarmInput> = {}): FarmInput =>
  farm(12.97, 77.59, { planting: { status: 'known', date: '2027-06-01', precision: 'month' }, ...extra });

// El formulario es un quiz de 5 pasos: «Siguiente» solo se habilita con el paso respondido.
async function next(page: Page, times = 1) {
  for (let i = 0; i < times; i++) await page.getByRole('button', { name: 'Siguiente' }).click();
}
async function back(page: Page, times = 1) {
  for (let i = 0; i < times; i++) await page.getByRole('button', { name: 'Atrás' }).click();
}
const stepLabel = (page: Page, n: number) => expect(page.locator('[data-ff="step-count"]')).toHaveText(`Paso ${n} de 5`);

/** Las coordenadas están ocultas por defecto: se abren con el enlace discreto del paso 1. */
async function setCoords(page: Page, lat: string, lon: string) {
  const toggle = page.getByRole('button', { name: 'Ingresar coordenadas manualmente' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByLabel('Latitud').fill(lat);
  await page.getByLabel('Longitud').fill(lon);
}

/** Recorre los 5 pasos desde el primero y se queda en el último, listo para enviar. */
async function fillForm(page: Page, o: { coords?: { lat: string; lon: string }; crop?: string; goal?: string; water?: string } = {}) {
  const { lat, lon } = o.coords ?? INDIA;
  await setCoords(page, lat, lon);
  await next(page);
  await page.getByRole('radio', { name: 'Lo coseché por última vez' }).check();
  await page.getByLabel('Nombre del cultivo').fill(o.crop ?? 'Maíz');
  await next(page);
  await page.getByRole('radio', { name: o.goal ?? '¿Qué puedo sembrar después?' }).check();
  await next(page);
  await page.getByRole('radio', { name: o.water ?? 'Tengo suficiente agua' }).check();
  await next(page);
  await page.getByRole('radio', { name: 'Sé solo el mes' }).check();
  await page.getByLabel('Mes de siembra').fill('2027-06');
}
/** Desde «Cambiar mis respuestas» (paso 1, datos conservados) hasta el último paso. */
const toLastStep = (page: Page) => next(page, 4);
const submit = (page: Page) => page.getByRole('button', { name: 'Ver mi plan' }).click();
const planA = (page: Page) => page.locator('[data-ff="plan-a"]');

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const bodyOf = (route: Route) => route.request().postDataJSON() as FarmInput;

/** Servidor de pruebas: /api/analyze responde con el motor real y las fuentes locales. */
async function mockApi(context: BrowserContext, opts: { explain?: string | null; delayMs?: number; alerts?: AnalyzeResponse['alerts'] } = {}) {
  const calls: FarmInput[] = [];
  await context.route('**/api/analyze', async (route) => {
    const input = bodyOf(route);
    calls.push(input);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const base = responseFor(input);
    await json(route, { ...base, alerts: opts.alerts ?? [], explain: opts.explain ?? null }).catch(() => {});
  });
  return calls;
}

test.describe('formulario y resultado', () => {
  test('compara Plan A y Plan B antes del detalle y enlaza las fuentes recibidas', async ({ page, context }) => {
    await mockApi(context);
    await page.goto('/es/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await fillForm(page);
    await submit(page);

    const title = page.getByRole('heading', { name: 'Tu plan para esta siembra' });
    await expect(title).toBeFocused();
    await expect(page.getByText('Tu plan está listo')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Plan A/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Plan B/ })).toBeVisible();

    const summary = page.getByText('Fuentes Científicas Utilizadas', { exact: true });
    const [a, b, s] = await Promise.all([planA(page).boundingBox(), page.locator('[data-ff="plan-b"]').boundingBox(), summary.boundingBox()]);
    expect(a!.y).toBeLessThan(s!.y);
    expect(b!.y).toBeLessThan(s!.y);

    // Los enlaces del bloque científico son exactamente los datasets de la evidencia recibida
    const expected = responseFor(indiaInput()).result.climate.records.map((r) => r.dataset.url).sort();
    await summary.click();
    const hrefs = await page.locator('[data-ff="sources-list"] a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href).sort());
    expect(hrefs).toEqual(expected);
    for (const a of await page.locator('[data-ff="sources-list"] a').all()) {
      await expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  test('quiz de 5 pasos: avance accesible, «Siguiente» exige respuesta y «Atrás» conserva los datos', async ({ page }) => {
    await page.goto('/es/');
    await stepLabel(page, 1);
    await expect(page.locator('[data-ff="step-count"]')).toHaveAttribute('aria-live', 'polite');
    const bar = page.getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', '1');
    await expect(bar).toHaveAttribute('aria-valuemax', '5');
    await expect(page.getByRole('button', { name: 'Atrás' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Ver mi plan' })).toBeHidden();

    // Una sola pregunta visible, y sin coordenadas a la vista
    await expect(page.getByText('¿Dónde está tu campo?')).toBeVisible();
    await expect(page.getByText('¿Qué cultivas o qué cosechaste por última vez?')).toBeHidden();
    await expect(page.getByLabel('Latitud')).toBeHidden();
    await expect(page.getByText('GeoNames')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Siguiente' })).toBeDisabled();

    const toggle = page.getByRole('button', { name: 'Ingresar coordenadas manualmente' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.getByLabel('Latitud').fill('12,97');
    await expect(page.getByRole('button', { name: 'Siguiente' })).toBeDisabled(); // falta la longitud
    await page.getByLabel('Longitud').fill('77,59');
    await next(page);

    await stepLabel(page, 2);
    await expect(bar).toHaveAttribute('aria-valuenow', '2');
    await expect(page.getByRole('radio', { name: 'Lo cultivo ahora' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Siguiente' })).toBeDisabled(); // falta el cultivo
    await page.getByLabel('Nombre del cultivo').fill('Maíz');
    await next(page);
    await stepLabel(page, 3);
    await expect(page.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    await page.getByRole('radio', { name: 'Quiero cuidar mi suelo' }).check();

    // Atrás conserva todo lo escrito
    await back(page, 2);
    await stepLabel(page, 1);
    await expect(page.getByLabel('Latitud')).toHaveValue('12,97');
    await next(page);
    await expect(page.getByLabel('Nombre del cultivo')).toHaveValue('Maíz');
    await next(page);
    await expect(page.getByRole('radio', { name: 'Quiero cuidar mi suelo' })).toBeChecked();
    await page.getByRole('radio', { name: 'Quiero cuidar mi suelo' }).check();
    await next(page);
    await page.getByRole('radio', { name: 'Tengo poca agua' }).check();
    await next(page);
    await stepLabel(page, 5);
    await expect(page.getByRole('button', { name: 'Siguiente' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Ver mi plan' })).toBeVisible();
  });

  test('Enter avanza solo si la respuesta es válida', async ({ page }) => {
    await page.goto('/es/');
    await page.getByRole('button', { name: 'Ingresar coordenadas manualmente' }).click();
    await page.getByLabel('Latitud').fill('12,97');
    await page.getByLabel('Latitud').press('Enter');
    await stepLabel(page, 1);
    await page.getByLabel('Longitud').fill('77,59');
    await page.getByLabel('Longitud').press('Enter');
    await stepLabel(page, 2);
  });

  test('un error del servidor en un paso anterior lleva a ese paso, marca aria-invalid y se limpia al corregir', async ({ page, context }) => {
    await page.goto('/es/');
    await expect(page.locator('[data-ff="status"]')).toHaveAttribute('role', 'status');
    await context.route('**/api/analyze', (route) =>
      json(route, { contractVersion: 1, status: 'invalid_input', issues: [{ path: 'water', code: 'invalid' }] }, 400),
    );
    await fillForm(page);
    await submit(page);
    await expect(page.locator('[data-ff="status"]')).toContainText('Revisa tus respuestas');
    await stepLabel(page, 4);
    await expect(page.locator('#error-agua')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Tengo suficiente agua' })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('radio', { name: 'Tengo suficiente agua' })).toBeFocused();
    // Corregir un campo limpia su error sin esperar al próximo envío
    await page.getByRole('radio', { name: 'Tengo poca agua' }).check();
    await expect(page.locator('#error-agua')).toBeHidden();
  });

  test('con GPS denegado se completa y envía solo con teclado', async ({ page, context }) => {
    await mockApi(context);
    await page.goto('/es/');
    await page.getByRole('button', { name: 'Usar mi ubicación' }).click();
    await expect(page.locator('[data-ff="location-status"]')).toContainText('No pudimos usar tu ubicación');
    // Si falla el GPS, el aviso manda a escribir coordenadas: quedan a la vista
    await expect(page.getByLabel('Latitud')).toBeVisible();

    await page.getByLabel('Latitud').focus();
    const k = page.keyboard;
    await k.type('12,97');
    await k.press('Tab');
    await k.type('77,59');
    await k.press('Enter'); // avanza al paso 2
    await stepLabel(page, 2);
    await expect(page.getByRole('radio', { name: 'Lo cultivo ahora' })).toBeFocused(); // foco al primer control del paso
    for (let i = 0; i < 10; i++) await k.press('Tab'); // etapa → 8 cultivos + «Otro cultivo» → nombre del cultivo
    await expect(page.getByLabel('Nombre del cultivo')).toBeFocused();
    await k.type('Maíz');
    await k.press('Enter');
    await stepLabel(page, 3);
    await k.press('Space'); // objetivo: primer radio, con el foco ya puesto
    await k.press('Enter');
    await stepLabel(page, 4);
    await k.press('Space'); // agua
    await k.press('Enter');
    await stepLabel(page, 5);
    await k.press('ArrowRight'); // precisión de la siembra: mes
    await k.press('Tab'); // campo del mes: segmento del mes
    await k.press('Tab'); // segmento del año
    await k.press('Tab'); // "No sé todavía"
    await k.press('Space');
    await k.press('Tab'); // «Atrás»
    await k.press('Tab'); // botón de envío
    await expect(page.getByRole('button', { name: 'Ver mi plan' })).toBeFocused();
    await k.press('Enter');
    await expect(page.getByRole('heading', { name: 'Tu plan para esta siembra' })).toBeFocused();
    // Sin fecha de siembra el plan queda a medias y dice qué revisar
    await expect(page.getByText('Tu plan está a medias')).toBeVisible();
  });

  test('localidad ambigua: pide elegir y Enter busca sin enviar el formulario', async ({ page, context }) => {
    await mockApi(context);
    await context.route('**/api/location', (route) =>
      json(route, {
        status: 'ok',
        attribution: 'Búsqueda de localidades: GeoNames, a través de Open-Meteo (CC BY 4.0).',
        places: [
          { name: 'Bengaluru', detail: 'Karnataka, India', lat: 12.97, lon: 77.59 },
          { name: 'Bengaluru', detail: 'Otro lugar, India', lat: 13.5, lon: 77.1 },
        ],
      }),
    );
    await page.goto('/es/');
    await page.getByLabel('Nombre de tu localidad').fill('Bengaluru');
    await page.getByLabel('Nombre de tu localidad').press('Enter');
    await expect(page.locator('[data-ff="location-status"]')).toContainText('Elige el tuyo');
    await expect(page.locator('[data-ff="results"]')).toBeHidden();
    await expect(page.getByText('GeoNames')).toHaveCount(0); // la atribución vive en /fuentes
    await page.getByRole('radio', { name: /Karnataka, India/ }).check();
    await expect(page.getByLabel('Latitud')).toBeHidden(); // se rellenan internamente
    await expect(page.getByLabel('Latitud')).toHaveValue('12,97');
    await expect(page.getByRole('button', { name: 'Siguiente' })).toBeEnabled();
    await expect(page.locator('[data-ff="location-status"]')).toContainText('aproximada');
    await fillForm(page, { coords: { lat: '12,97', lon: '77,59' } });
    await submit(page);
    await expect(page.getByRole('heading', { name: /^Plan A/ })).toBeVisible();
  });

  test('preguntas: respuesta local inmediata y explicación del modelo solo tras elegir', async ({ page, context }) => {
    await mockApi(context, { explain: 'contexto-firmado' });
    let explainCalls = 0;
    await context.route('**/api/explain', async (route) => {
      explainCalls++;
      await json(route, { questionId: 'less_water', source: 'model', items: [{ key: 'B:reasons:0', text: 'Texto del modelo de prueba.' }] });
    });
    await page.goto('/es/');
    await fillForm(page);
    await submit(page);
    await expect(page.getByRole('heading', { name: /^Plan A/ })).toBeVisible();
    expect(explainCalls).toBe(0);

    await page.getByRole('button', { name: '¿Qué pasa si tengo menos agua?' }).click();
    await expect(page.locator('[data-ff="answer"]')).toContainText('Texto del modelo de prueba.');
    await expect(page.locator('[data-ff="answer"]')).toContainText('inteligencia artificial');
    expect(explainCalls).toBe(1);
  });

  test('guardar, editar, abrir y quitar un plan', async ({ page, context }) => {
    await mockApi(context);
    await page.goto('/es/');
    await fillForm(page);
    await submit(page);
    await page.getByRole('button', { name: 'Guardar este plan' }).click();
    await expect(page.getByRole('heading', { name: 'Tus planes guardados' })).toBeVisible();
    await expect(page.locator('[data-ff="status"]')).toContainText('Guardamos este plan');

    await page.getByRole('button', { name: 'Cambiar mis respuestas' }).click();
    await expect(page.locator('[data-ff="results"]')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Usar mi ubicación' })).toBeFocused();
    await expect(page.getByLabel('Latitud')).toHaveValue('12,97'); // conserva lo escrito
    await stepLabel(page, 1);
    await next(page, 2);
    await page.getByRole('radio', { name: 'Quiero cuidar mi suelo' }).check();
    await next(page, 2);
    await submit(page);
    await expect(page.getByRole('heading', { name: /^Plan A/ })).toBeVisible();

    await page.locator('[data-act="open"]').click();
    await expect(page.getByRole('heading', { name: 'Tu plan para esta siembra' })).toBeFocused();
    await expect(page.getByRole('radio', { name: '¿Qué puedo sembrar después?', includeHidden: true })).toBeChecked(); // el formulario (paso 3, oculto) vuelve al plan guardado

    await page.locator('[data-act="delete"]').click();
    await expect(page.getByRole('heading', { name: 'Tus planes guardados' })).toBeHidden();
  });

  test('reenvío seguido: solo se presenta el plan de la última entrada', async ({ page, context }) => {
    const first = indiaInput();
    const second = indiaInput({ crop: { status: 'known', stage: 'last_harvested', name: 'Garbanzo' } });
    const expectedA = responseFor(second).result.planA!.cropIds.map((c) => cropName(c)).join(', luego ');
    expect(responseFor(first).result.planA!.cropIds).not.toEqual(responseFor(second).result.planA!.cropIds);

    let n = 0;
    await context.route('**/api/analyze', async (route) => {
      const input = bodyOf(route);
      if (n++ === 0) await new Promise((r) => setTimeout(r, 2_000)); // la primera llega tarde
      await json(route, { ...responseFor(input), alerts: [], explain: null }).catch(() => {});
    });
    await page.goto('/es/');
    await fillForm(page);
    await submit(page);
    await back(page, 3);
    await page.getByLabel('Nombre del cultivo').fill('Garbanzo');
    await next(page, 3);
    await submit(page);
    await expect(planA(page)).toContainText(expectedA);
    await page.waitForTimeout(2_500); // da tiempo a que llegue la respuesta antigua
    await expect(planA(page)).toContainText(expectedA);
    await expect(page.locator('[data-ff="loading"]')).toBeHidden();
  });
});

test.describe('niveles de cobertura y alertas', () => {
  test('ok, parcial e insuficiente se distinguen, y una alerta no se confunde con falta de datos', async ({ page, context }) => {
    await mockApi(context);
    await page.goto('/es/');
    await fillForm(page);
    await submit(page);
    await expect(page.getByText('Tu plan está listo')).toBeVisible();

    // Chiclayo + poca agua con los 5 pasos completos: plan principal con riego como condición, sin cajas de "incompleto"
    await page.getByRole('button', { name: 'Cambiar mis respuestas' }).click();
    await fillForm(page, { coords: { lat: '-6,77', lon: '-79,84' }, water: 'Tengo poca agua' });
    await submit(page);
    await expect(page.getByText('Tu plan está listo')).toBeVisible();
    await expect(planA(page).getByText('Requiere riego suplementario')).toBeVisible();
    await expect(page.getByText('Tu plan está a medias')).toBeHidden();
    await expect(page.getByText('Plan incompleto')).toBeHidden();
    await expect(page.getByText('Cultivo por definir')).toBeHidden();

    // Parcial: agua "No sé" es un dato que el agricultor puede aportar
    await page.getByRole('button', { name: 'Cambiar mis respuestas' }).click();
    await fillForm(page, { coords: { lat: '-6,77', lon: '-79,84' }, water: 'No estoy seguro' });
    await submit(page);
    await expect(page.getByText('Tu plan está a medias')).toBeVisible();

    // Insuficiente: sin evidencia climática el motor no inventa planes y explica qué falta
    await context.unroute('**/api/analyze');
    await context.route('**/api/analyze', (route) => {
      const input = bodyOf(route);
      const climate = {
        query: { lat: input.location.lat, lon: input.location.lon, window: { start: '2025-01-01', end: '2025-12-31' } },
        assembledAt: NOW.toISOString(),
        sources: [{ source: 'power' as const, state: 'unavailable' as const, ageSeconds: null, detail: 'prueba' }],
        records: [],
      };
      const result = { contractVersion: 1 as const, ...evaluateRotation(input, climate), generatedAt: NOW.toISOString(), climate };
      return json(route, analyzeResponseSchema.parse({ result, alerts: [], explain: null }));
    });
    await page.getByRole('button', { name: 'Cambiar mis respuestas' }).click();
    await setCoords(page, '40,4', '-3,7');
    await toLastStep(page);
    await submit(page);
    await expect(page.getByText('Aún no hay datos suficientes')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Qué falta' })).toBeVisible();
    await expect(page.getByText('Posible foco de calor cerca')).toBeHidden();

    // Alerta vigente con datos completos
    await context.unroute('**/api/analyze');
    await mockApi(context, { alerts: [{ id: 'fire_hotspot_nearby', evidenceId: 'firms:prueba', count: 2, nearestKm: 12.4, latestAt: NOW.toISOString() }] });
    await page.getByRole('button', { name: 'Cambiar mis respuestas' }).click();
    await setCoords(page, '12,97', '77,59');
    await toLastStep(page);
    await submit(page);
    await expect(page.getByText('Posible foco de calor cerca')).toBeVisible();
    await expect(page.getByText('Aún no hay datos suficientes')).toBeHidden();
  });

  test('reflujo a 320 px sin desplazamiento horizontal, con resultados', async ({ page, context }) => {
    await mockApi(context);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/es/');
    await fillForm(page);
    await submit(page);
    await expect(page.getByRole('heading', { name: /^Plan B/ })).toBeVisible();
    await page.getByText('Fuentes Científicas Utilizadas', { exact: true }).click();
    const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scroll).toBe(inner);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, summary, a.boton')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 47.5).map((e) => e.textContent?.trim()),
    );
    expect(small).toEqual([]);
  });
});

test.describe('red lenta y sin conexión', () => {
  test('red lenta: pasados 8 s vuelve a un plan calculado en el dispositivo', async ({ page, context }) => {
    test.setTimeout(60_000);
    await mockApi(context, { delayMs: 12_000 });
    await page.goto('/es/');
    await fillForm(page);
    await submit(page);
    await expect(page.locator('[data-ff="loading"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revisando tu campo…' })).toBeVisible();
    await expect(page.getByText('Plan calculado en tu dispositivo')).toBeVisible({ timeout: 15_000 });
    await expect(planA(page)).toContainText(responseFor(indiaInput()).result.planA!.cropIds.map((c) => cropName(c)).join(', luego '));
    await expect(page.locator('[data-ff="loading"]')).toBeHidden();
  });

  test('tras una visita previa, recargar sin red abre el formulario y el plan guardado sin pedir nada', async ({ page, context }) => {
    test.setTimeout(60_000);
    await mockApi(context);
    await page.goto('/es/');
    await expect(page.getByText('Listo para usar sin internet')).toBeVisible({ timeout: 30_000 });
    await fillForm(page);
    await submit(page);
    await expect(page.getByRole('heading', { name: /^Plan A/ })).toBeVisible();
    const online = await planA(page).innerText();
    await page.getByRole('button', { name: 'Guardar este plan' }).click();
    await expect(page.getByRole('heading', { name: 'Tus planes guardados' })).toBeVisible();

    await context.setOffline(true);
    // Los dobles de ruta responderían aun sin red: aquí la API falla como fallaría sin conexión
    await context.unroute('**/api/analyze');
    await context.route('**/api/**', (route) => route.abort('internetdisconnected'));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Planea tu próxima siembra' })).toBeVisible();
    await expect(page.getByText('No hay conexión a internet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ingresar coordenadas manualmente' })).toBeVisible();

    // El plan guardado se abre sin red y muestra lo mismo que se vio en línea
    await page.locator('[data-act="open"]').click();
    await expect(page.getByRole('heading', { name: 'Tu plan para esta siembra' })).toBeFocused();
    expect(await planA(page).innerText()).toBe(online);

    // Una entrada nueva sin red se calcula en el dispositivo con la misma evidencia científica local
    await page.getByRole('button', { name: 'Cambiar mis respuestas' }).click();
    await next(page, 2);
    await page.getByRole('radio', { name: 'Quiero cuidar mi suelo' }).check();
    await next(page, 2);
    await submit(page);
    await expect(page.getByText('Plan calculado en tu dispositivo')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Plan B/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Actualizar con datos nuevos' })).toBeHidden();

    // Fuera de las zonas con datos locales no se inventa un plan
    await page.getByRole('button', { name: 'Cambiar mis respuestas' }).click();
    await setCoords(page, '40,4', '-3,7');
    await toLastStep(page);
    await submit(page);
    await expect(page.getByText('Sin internet y sin datos guardados de tu zona')).toBeVisible();

    // Al volver la red se ofrece actualizar
    await context.setOffline(false);
    await expect(page.getByText('No hay conexión a internet')).toBeHidden();
  });

  test('una primera visita sin copia previa muestra la pantalla sin datos', async ({ page }) => {
    await page.goto('/es/offline/');
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /./ }).first()).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText('NASA Space Apps Challenge Chiclayo 2026');
  });
});

test.describe('pie de página y fuentes', () => {
  test('el pie aparece en el inicio y lleva a /fuentes con las atribuciones técnicas', async ({ page }) => {
    await page.goto('/es/');
    const footer = page.getByRole('contentinfo');
    await expect(footer).toContainText('AgroShift');
    await expect(footer).toContainText('no reemplaza');
    await expect(footer).toContainText('NASA Space Apps Challenge Chiclayo 2026');
    await expect(footer).toContainText('Equipo OneCtrl: Giancarlo Luciano Larios Infantes, Enzo Gabriel García Infantes y Sergio Anibal Tuesta Rodas');
    await footer.getByRole('link', { name: 'Fuentes científicas y herramientas' }).click();
    await expect(page).toHaveURL(/\/fuentes\/?$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Fuentes científicas y herramientas' })).toBeVisible();
    await expect(page.getByText('GeoNames, a través de Open-Meteo').first()).toBeVisible();
    await expect(page.getByText('CC BY 4.0')).toBeVisible();
    for (const name of ['NASA POWER', 'NASA SMAP', 'NASA Giovanni', 'NASA FIRMS', 'Astro', 'Supabase', 'Amazon Bedrock', 'Vercel']) {
      await expect(page.getByRole('heading', { level: 3, name })).toBeVisible();
    }
    await expect(page.getByRole('contentinfo')).toBeVisible();
  });
});

test.describe('paso 2: elegir y reconocer el cultivo', () => {
  test('opciones grandes, sinónimos regionales y «Otro cultivo»', async ({ page, context }) => {
    await mockApi(context);
    await page.goto('/es/');
    await setCoords(page, INDIA.lat, INDIA.lon);
    await next(page);
    await stepLabel(page, 2);
    const crop = page.getByLabel('Nombre del cultivo');

    // Opciones táctiles grandes con los cultivos del catálogo
    for (const name of ['Maíz', 'Arroz', 'Trigo', 'Frijol', 'Caupí', 'Garbanzo', 'Sorgo', 'Mijo dedo']) {
      const b = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(b!.height).toBeGreaterThanOrEqual(47.5);
    }
    await page.getByRole('button', { name: 'Garbanzo', exact: true }).click();
    await expect(crop).toHaveValue('Garbanzo');
    await expect(page.getByRole('button', { name: 'Garbanzo', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // Un sinónimo regional se reconoce mientras se escribe y se elige con el teclado sin avanzar de paso
    await crop.fill('chocl');
    const option = page.getByRole('option', { name: /Maíz/ });
    await expect(option).toContainText('choclo');
    expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(47.5);
    await crop.press('ArrowDown');
    await crop.press('Enter');
    await expect(crop).toHaveValue('Maíz');
    await stepLabel(page, 2);
    await expect(page.getByRole('button', { name: 'Maíz', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // Mayúsculas y plurales también se entienden
    await crop.fill('FRIJOLES');
    await expect(page.getByRole('option', { name: /Frijol/ }).first()).toBeVisible();

    // Fuera del catálogo: se sugiere con su grupo, y «Otro cultivo» queda marcado
    await crop.fill('tomate');
    const tomato = page.getByRole('option', { name: /Tomate/ });
    await expect(tomato).toContainText('sin ficha propia');
    await tomato.click();
    await expect(crop).toHaveValue('Tomate');
    await expect(page.getByRole('button', { name: 'Otro cultivo', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Siguiente' })).toBeEnabled();
  });

  test('cultivo fuera de las fichas: plan completo con regla general por familia declarada', async ({ page, context }) => {
    await mockApi(context);
    await page.goto('/es/');
    await fillForm(page, { crop: 'Papa' });
    await submit(page);
    await expect(page.getByText('Tu plan está listo')).toBeVisible();
    await expect(page.getByText('Plan incompleto')).toBeHidden();
    await expect(page.locator('body')).toContainText('regla general por familia');
  });
});

test.describe('FIRMS sin respuesta', () => {
  test('aviso neutro y sin cuadro rojo de alerta que parezca un incendio', async ({ page, context }) => {
    await context.route('**/api/analyze', (route) => {
      const base = responseFor(bodyOf(route));
      const { climate } = base.result;
      const firms = { source: 'firms' as const, state: 'unavailable' as const, ageSeconds: null, detail: 'plazo_agotado' };
      const result = {
        ...base.result,
        climate: { ...climate, sources: [...climate.sources.filter((s) => s.source !== 'firms'), firms], records: climate.records.filter((r) => r.source !== 'firms') },
      };
      return json(route, { ...base, alerts: [], explain: null, result });
    });
    await page.goto('/es/');
    await fillForm(page);
    await submit(page);
    await page.getByText('Fuentes Científicas Utilizadas', { exact: true }).click();

    const aviso = page.locator('.estado', { hasText: 'Monitoreo satelital de focos de calor temporalmente no disponible (NASA FIRMS).' });
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('Verifica visualmente quemas cercanas antes de sembrar.');
    await expect(aviso).toHaveClass(/estado--sindato/);
    await expect(aviso).not.toContainText('Alerta');
    await expect(page.locator('.estado--alerta', { hasText: /calor|FIRMS/ })).toHaveCount(0);
    await expect(page.getByText('Posible foco de calor cerca')).toBeHidden();
  });
});

test.describe('idioma: inglés por defecto y selector EN | ES', () => {
  test('abre en inglés, cambia a español, recuerda la elección y vuelve a inglés', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Plan your next planting');
    await expect(page.locator('[data-ff="step-count"]')).toHaveText('Step 1 of 5');
    await expect(page.getByRole('contentinfo')).toContainText('Team OneCtrl: Giancarlo Luciano Larios Infantes, Enzo Gabriel García Infantes & Sergio Anibal Tuesta Rodas');

    // Dos selectores (cabecera y pie), con el idioma activo marcado y tamaño táctil de 48 px
    const switches = page.getByRole('navigation', { name: 'Language' });
    await expect(switches).toHaveCount(2);
    const active = switches.first().getByRole('link', { name: /^EN:/ });
    await expect(active).toHaveAttribute('aria-current', 'true');
    for (const link of await switches.first().getByRole('link').all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(48);

    await switches.first().getByRole('link', { name: /^ES:/ }).click();
    await expect(page).toHaveURL(/\/es\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Planea tu próxima siembra');
    expect(await page.evaluate(() => localStorage.getItem('agroshift.lang'))).toBe('es');

    // La preferencia guardada lleva de la ruta en inglés a la española
    await page.goto('/');
    await expect(page).toHaveURL(/\/es\/$/);

    await page.getByRole('contentinfo').getByRole('link', { name: /^EN:/ }).click();
    await expect(page).toHaveURL(/:4373\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Plan your next planting');
    await page.goto('/fuentes/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Scientific sources and tools');
  });

  test('flujo completo en inglés: quiz, plan y explicación con lang en la petición', async ({ page, context }) => {
    await mockApi(context, { explain: 'contexto-firmado' });
    let explainBody: { lang?: string; questionId?: string } = {};
    await context.route('**/api/explain', async (route) => {
      explainBody = route.request().postDataJSON();
      await json(route, { questionId: 'less_water', source: 'model', items: [{ key: 'B:reasons:0', text: 'Model text for the test.' }] });
    });
    await page.goto('/');
    const nextBtn = () => page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Enter coordinates manually' }).click();
    await page.getByLabel('Latitude').fill('12.97');
    await page.getByLabel('Longitude').fill('77.59');
    await nextBtn();
    await page.getByRole('radio', { name: 'I harvested it last' }).check();
    await page.getByLabel('Crop name').fill('Maize');
    await nextBtn();
    await page.getByRole('radio', { name: 'What can I plant next?' }).check();
    await nextBtn();
    await page.getByRole('radio', { name: 'I have enough water' }).check();
    await nextBtn();
    await page.getByRole('radio', { name: 'I only know the month' }).check();
    await page.getByLabel('Planting month').fill('2027-06');
    await page.getByRole('button', { name: 'See my plan' }).click();

    await expect(page.getByRole('heading', { name: 'Your plan for this planting' })).toBeFocused();
    await expect(page.getByText('Your plan is ready')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Plan A/ })).toBeVisible();
    await expect(page.getByText('Scientific sources used', { exact: true })).toBeVisible();
    await expect(page.locator('[data-ff="plan-a"]')).not.toContainText(/[áéíóúñ¿¡]/);

    await page.getByRole('button', { name: 'What if I have less water?' }).click();
    await expect(page.locator('[data-ff="answer"]')).toContainText('Model text for the test.');
    await expect(page.locator('[data-ff="answer"]')).toContainText('artificial intelligence');
    expect(explainBody).toMatchObject({ lang: 'en', questionId: 'less_water' });
  });
});
