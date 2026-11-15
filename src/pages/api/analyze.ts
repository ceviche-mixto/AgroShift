import type { APIRoute } from 'astro';
import { analyze } from '../../services/analysis.ts';
import { privateJson, readJsonBody } from '../../services/http.ts';

export const prerender = false;

/** Tamaño máximo del formulario. La entrada válida ocupa unos 300 bytes. */
const MAX_BODY_BYTES = 4_096;

export const POST: APIRoute = async ({ request }) => {
  const started = Date.now();
  try {
    // Un cuerpo ausente, excesivo o que no es JSON cae en el error de entrada del contrato
    const outcome = await analyze(await readJsonBody(request, MAX_BODY_BYTES));
    // Sin coordenadas ni texto del agricultor en logs: solo estado y duración
    console.info(`[analyze] ${outcome.status} ${Date.now() - started}ms`);
    return privateJson(
      outcome.status,
      outcome.body,
      outcome.status === 429 ? { 'Retry-After': String(outcome.body.retryAfterSeconds) } : {},
    );
  } catch (e) {
    console.error(`[analyze] 500 ${Date.now() - started}ms ${e instanceof Error ? e.name : 'error'}`);
    return privateJson(500, { status: 'error' });
  }
};
