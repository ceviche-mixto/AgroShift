import { z } from 'zod';
import { answerLocally, explainFinding, listFacts, questionText, type QuestionId } from '../../domain/explain.ts';
import type { Lang } from '../../i18n/index.ts';
import { serverEnv } from '../env.ts';
import { consumeBudget } from '../supabase/cache.ts';
import { factsVersion, type ExplainFacts } from './context.ts';

// Explicación bajo demanda con Amazon Bedrock Converse. El modelo solo ELIGE qué hechos del motor
// responden la pregunta; el texto visible sale siempre de plantillas, así no hay afirmaciones nuevas.
// Si falta acceso, vence el plazo, se agota la cuota o la salida no valida, responde el texto local.

export const EXPLAIN_DEADLINE_MS = 6_000;
/** Invocaciones por hora, compartidas entre instancias. */
export const EXPLAIN_BUDGET = { intervalSeconds: 3600, limit: 60 } as const;
const MAX_TOKENS = 120;
const MAX_KEYS = 4;
const MAX_CONCURRENT = 2;

export interface Explanation {
  questionId: QuestionId;
  /** 'model' = selección de Bedrock validada. 'local' = selección determinista. */
  source: 'model' | 'local';
  items: { key: string; text: string }[];
}

export interface ExplainDeps {
  fetch?: typeof fetch;
  consume?: typeof consumeBudget;
  deadlineMs?: number;
}

const outputSchema = z.strictObject({ keys: z.array(z.string().max(40)).min(1).max(MAX_KEYS) });

// shortcut: memoria por instancia, se vacía al llegar a 200 entradas; pasar a Supabase si el
// tráfico reparte las mismas preguntas entre muchas instancias.
const answers = new Map<string, string[]>();
let running = 0;

const PROMPTS: Record<Lang, { system: string; question: string; facts: string }> = {
  es: {
    system:
      'Eres un selector de hechos. Recibes una pregunta de un agricultor y una lista de hechos, cada uno con una clave. ' +
      `Elige hasta ${MAX_KEYS} claves de la lista, las que mejor responden la pregunta, en orden de importancia. ` +
      'Responde solo con JSON de la forma {"keys":["clave"]}. No escribas texto, no inventes claves y no añadas hechos.',
    question: 'Pregunta',
    facts: 'Hechos',
  },
  en: {
    system:
      'You are a fact selector. You receive a farmer\'s question and a list of facts, each with a key. ' +
      `Choose up to ${MAX_KEYS} keys from the list that best answer the question, in order of importance. ` +
      'Reply only with JSON of the form {"keys":["key"]}. Write no text, do not invent keys and do not add facts.',
    question: 'Question',
    facts: 'Facts',
  },
};

async function askModel(
  question: string,
  facts: { key: string; text: string }[],
  deps: ExplainDeps,
  lang: Lang,
): Promise<string[]> {
  const prompt = PROMPTS[lang];
  const token = serverEnv('AWS_BEARER_TOKEN_BEDROCK');
  const region = serverEnv('AWS_REGION');
  const model = serverEnv('BEDROCK_MODEL_ID');
  if (!token || !region || !model) throw new Error('bedrock_sin_configurar');
  if (!(await (deps.consume ?? consumeBudget)('explain', EXPLAIN_BUDGET.intervalSeconds, EXPLAIN_BUDGET.limit))) {
    throw new Error('cupo_agotado');
  }
  // Una sola invocación: sin reintentos de inferencia
  const res = await (deps.fetch ?? fetch)(
    `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: [{ text: prompt.system }],
        messages: [
          {
            role: 'user',
            content: [{ text: `${prompt.question}: ${question}\n${prompt.facts}:\n${facts.map((f) => `${f.key} | ${f.text}`).join('\n')}` }],
          },
        ],
        inferenceConfig: { maxTokens: MAX_TOKENS, temperature: 0 },
      }),
      signal: AbortSignal.timeout(deps.deadlineMs ?? EXPLAIN_DEADLINE_MS),
    },
  );
  if (!res.ok) throw new Error(`bedrock_http_${res.status}`);
  const body = (await res.json()) as { output?: { message?: { content?: { text?: string }[] } } };
  const text = body.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '';
  const { keys } = outputSchema.parse(JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? ''));
  const allowed = new Set(facts.map((f) => f.key));
  const unique = [...new Set(keys)];
  if (!unique.every((k) => allowed.has(k))) throw new Error('clave_no_permitida');
  return unique;
}

/** Nunca lanza: ante cualquier fallo devuelve la explicación local. El texto sale en el idioma pedido (español por defecto). */
export async function explain(facts: ExplainFacts, questionId: QuestionId, deps: ExplainDeps = {}, lang: Lang = 'es'): Promise<Explanation> {
  const all = listFacts(facts).map(({ key, fact }) => ({ key, text: explainFinding(fact, lang) }));
  const render = (keys: string[], source: Explanation['source']): Explanation => ({
    questionId,
    source,
    items: keys.flatMap((key) => all.filter((f) => f.key === key)),
  });
  const local = render(answerLocally(questionId, facts), 'local');
  if (all.length === 0) return local;

  const cacheKey = `${factsVersion(facts)}:${questionId}`;
  const known = answers.get(cacheKey);
  if (known) return render(known, 'model');
  if (running >= MAX_CONCURRENT) return local;

  running++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const keys = await Promise.race([
      askModel(questionText(questionId, lang), all, deps, lang),
      // El plazo cubre también la consulta de cuota, que no se puede abortar
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('plazo_agotado')), deps.deadlineMs ?? EXPLAIN_DEADLINE_MS);
      }),
    ]);
    if (answers.size >= 200) answers.clear();
    answers.set(cacheKey, keys);
    return render(keys, 'model');
  } catch {
    return local;
  } finally {
    clearTimeout(timer);
    running--;
  }
}
