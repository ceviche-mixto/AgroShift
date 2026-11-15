import type { APIRoute } from 'astro';
import { z } from 'zod';
import { QUESTION_IDS } from '../../domain/explain.ts';
import { DEFAULT_LANG, LANGS } from '../../i18n/index.ts';
import { MAX_CONTEXT_CHARS, verifyContext } from '../../services/bedrock/context.ts';
import { explain } from '../../services/bedrock/explain.ts';
import { serverEnv } from '../../services/env.ts';
import { privateJson, readJsonBody } from '../../services/http.ts';

export const prerender = false;

const bodySchema = z.strictObject({
  context: z.string().max(MAX_CONTEXT_CHARS),
  questionId: z.enum(QUESTION_IDS),
  // Idioma de la respuesta (la página lo envía); sin él, el predeterminado de la aplicación
  lang: z.enum(LANGS).default(DEFAULT_LANG),
});

export const POST: APIRoute = async ({ request }) => {
  const body = bodySchema.safeParse(await readJsonBody(request, MAX_CONTEXT_CHARS + 512));
  const secret = serverEnv('EXPLAIN_CONTEXT_SECRET');
  // Firma, caducidad y tamaño: un contexto alterado o vencido no llega al modelo
  const facts = body.success && secret ? verifyContext(body.data.context, secret, new Date()) : null;
  if (!body.success || !facts) return privateJson(400, { status: 'invalid_context' });
  return privateJson(200, await explain(facts, body.data.questionId, {}, body.data.lang));
};
