import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnalysisResult, Finding, Plan } from '../../src/domain/contracts.ts';
import { answerLocally, explainFinding, listFacts } from '../../src/domain/explain.ts';
import { POST } from '../../src/pages/api/explain.ts';
import { factsOf, signContext, verifyContext, MAX_CONTEXT_CHARS, type ExplainFacts } from '../../src/services/bedrock/context.ts';
import { explain } from '../../src/services/bedrock/explain.ts';

// Hermético: Bedrock y el presupuesto compartido se sustituyen por dobles.

const SECRET = 'secreto-de-prueba';
const now = new Date('2026-11-14T12:00:00Z');
const finding = (id: string): Finding => ({ id, ruleId: 'engine.test', evidenceIds: ['power:T2M:merra2:-7:-80'], params: { celsius: 24 } });
const plan = (role: 'A' | 'B'): Plan => ({
  role,
  completeness: 'complete',
  kind: 'crop',
  scenario: role === 'A' ? { id: 'reference', nature: 'observed_reference' } : { id: 'limited_water', nature: 'hypothetical' },
  cropIds: [role === 'A' ? 'maize' : 'cowpea'],
  reasons: [finding(`${role}.razon.1`), finding(`${role}.razon.2`)],
  restrictions: [finding(`${role}.restriccion`)],
  actions: [finding(`${role}.accion`)],
  reconsiderSignals: [finding(`${role}.senal`)],
  toVerify: [],
});
/** Hechos distintos por prueba: la memoria de respuestas es por versión de hechos. */
let serial = 0;
const facts = (): ExplainFacts =>
  factsOf({
    contractVersion: 1,
    status: 'ok',
    engineVersion: `test-${serial++}`,
    generatedAt: now.toISOString(),
    planA: plan('A'),
    planB: plan('B'),
    missing: [],
    climate: { query: { lat: -6.77, lon: -79.84, window: { start: '2025-01-01', end: '2025-12-31' } }, assembledAt: now.toISOString(), sources: [], records: [] },
  } satisfies AnalysisResult);

const reply = (text: string, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ output: { message: { content: [{ text }] } }, stopReason: 'end_turn' }), { status })) as unknown as typeof fetch &
    ReturnType<typeof vi.fn>;
const allow = async () => true;

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries({ AWS_BEARER_TOKEN_BEDROCK: 'CLAVE-DE-PRUEBA', AWS_REGION: 'us-east-1', BEDROCK_MODEL_ID: 'us.amazon.nova-lite-v1:0' })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterEach(() => vi.useRealTimers());

describe('contexto firmado', () => {
  it('lleva solo hechos permitidos: sin ubicación, sin evidencia y sin IDs de celda', () => {
    const token = signContext(facts(), SECRET, now)!;
    const payload = Buffer.from(token.split('.')[0]!, 'base64url').toString();
    expect(payload).not.toMatch(/-6\.77|-79\.84|lat|lon|climate|evidenceIds|merra2/);
    expect(verifyContext(token, SECRET, now)?.planB?.cropIds).toEqual(['cowpea']);
  });

  it('rechaza firma alterada, otro secreto, caducidad y tamaño excesivo', () => {
    const token = signContext(facts(), SECRET, now)!;
    const [body, signature] = token.split('.');
    const forged = Buffer.from(Buffer.from(body!, 'base64url').toString().replace('maize', 'wheat')).toString('base64url');
    expect(verifyContext(`${forged}.${signature}`, SECRET, now)).toBeNull();
    expect(verifyContext(token, 'otro-secreto', now)).toBeNull();
    expect(verifyContext(token, SECRET, new Date(now.getTime() + 16 * 60_000))).toBeNull();
    expect(verifyContext(token, SECRET, new Date(now.getTime() + 14 * 60_000))).not.toBeNull();
    expect(verifyContext(`${token}.extra`, SECRET, now)).toBeNull();
    expect(verifyContext('x'.repeat(MAX_CONTEXT_CHARS + 1), SECRET, now)).toBeNull();
    expect(verifyContext(undefined, SECRET, now)).toBeNull();
  });
});

describe('explicación con Bedrock Converse', () => {
  it('una invocación válida conserva exactamente los hechos del motor: solo elige y ordena', async () => {
    const f = facts();
    const net = reply('```json\n{"keys":["B:reasons:1","A:restrictions:0"]}\n```');
    const out = await explain(f, 'less_water', { fetch: net, consume: allow });
    const byKey = Object.fromEntries(listFacts(f).map((x) => [x.key, explainFinding(x.fact)]));
    expect(out).toEqual({
      questionId: 'less_water',
      source: 'model',
      items: [
        { key: 'B:reasons:1', text: byKey['B:reasons:1'] },
        { key: 'A:restrictions:0', text: byKey['A:restrictions:0'] },
      ],
    });
    // Una sola invocación, con límite de tokens, sin ubicación y con la clave solo en la cabecera
    expect(net).toHaveBeenCalledTimes(1);
    const [url, init] = net.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-lite-v1%3A0/converse');
    const sent = JSON.parse(String(init.body));
    expect(sent.inferenceConfig).toEqual({ maxTokens: 120, temperature: 0 });
    expect(String(init.body)).not.toMatch(/CLAVE-DE-PRUEBA|-6\.77|-79\.84/);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer CLAVE-DE-PRUEBA');
  });

  it('reutiliza la explicación por versión de hechos y pregunta', async () => {
    const f = facts();
    const net = reply('{"keys":["A:reasons:0"]}');
    const first = await explain(f, 'why_plan_a', { fetch: net, consume: allow });
    const second = await explain(f, 'why_plan_a', { fetch: net, consume: allow });
    expect(second).toEqual(first);
    expect(net).toHaveBeenCalledTimes(1);
    await explain(f, 'when_to_switch', { fetch: net, consume: allow });
    expect(net).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['clave inventada', '{"keys":["A:reasons:0","Z:inventada:9"]}'],
    ['texto libre', 'Te conviene sembrar maíz porque lloverá mucho.'],
    ['demasiadas claves', '{"keys":["A:reasons:0","A:reasons:1","A:restrictions:0","A:actions:0","B:reasons:0"]}'],
    ['campo extra', '{"keys":["A:reasons:0"],"consejo":"riega más"}'],
    ['lista vacía', '{"keys":[]}'],
  ])('salida inválida (%s): queda la explicación local', async (_, text) => {
    const f = facts();
    const out = await explain(f, 'why_plan_a', { fetch: reply(text), consume: allow });
    expect(out.source).toBe('local');
    expect(out.items.map((i) => i.key)).toEqual(answerLocally('why_plan_a', f));
    expect(out.items.length).toBeGreaterThan(0);
  });

  it('cuota agotada o caída: explicación local sin invocar el modelo', async () => {
    const net = reply('{"keys":["A:reasons:0"]}');
    expect((await explain(facts(), 'what_to_check', { fetch: net, consume: async () => false })).source).toBe('local');
    expect((await explain(facts(), 'what_to_check', { fetch: net, consume: async () => Promise.reject(new Error('caído')) })).source).toBe('local');
    expect(net).not.toHaveBeenCalled();
  });

  it('error de Bedrock: explicación local y sin reintentos de inferencia', async () => {
    const net = reply('{"message":"Too many tokens per day"}', 429);
    expect((await explain(facts(), 'less_water', { fetch: net, consume: allow })).source).toBe('local');
    expect(net).toHaveBeenCalledTimes(1);
  });

  it('timeout de 6 s: explicación local sin retrasar más', async () => {
    vi.useFakeTimers();
    const hung = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const pending = explain(facts(), 'less_water', { fetch: hung, consume: allow });
    await vi.advanceTimersByTimeAsync(5_900);
    let done = false;
    void pending.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).source).toBe('local');
  });

  it('sin credenciales: explicación local', async () => {
    const key = process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    try {
      const net = reply('{"keys":["A:reasons:0"]}');
      expect((await explain(facts(), 'why_plan_a', { fetch: net, consume: allow })).source).toBe('local');
      expect(net).not.toHaveBeenCalled();
    } finally {
      process.env.AWS_BEARER_TOKEN_BEDROCK = key;
    }
  });
});

describe('POST /api/explain', () => {
  const call = (body: unknown) =>
    POST({ request: new Request('http://localhost/api/explain', { method: 'POST', body: JSON.stringify(body) }) } as Parameters<typeof POST>[0]);

  it('rechaza contexto ausente, alterado o pregunta fuera de la lista, sin almacenar la respuesta', async () => {
    const savedSecret = process.env.EXPLAIN_CONTEXT_SECRET;
    process.env.EXPLAIN_CONTEXT_SECRET = SECRET;
    try {
      const context = signContext(facts(), SECRET, new Date())!;
      for (const body of [{}, { context: 'a.b', questionId: 'less_water' }, { context, questionId: 'pregunta libre' }, { context, questionId: 'less_water', extra: 1 }]) {
        const res = await call(body);
        expect(res.status).toBe(400);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({ status: 'invalid_context' });
      }
    } finally {
      if (savedSecret === undefined) delete process.env.EXPLAIN_CONTEXT_SECRET;
      else process.env.EXPLAIN_CONTEXT_SECRET = savedSecret;
    }
  });
});

describe('idioma de la explicación', () => {
  it('en inglés: texto local y consulta al modelo en inglés', async () => {
    const f = facts();
    const net = reply('{"keys":["A:reasons:0"]}');
    const out = await explain(f, 'why_plan_a', { fetch: net, consume: allow }, 'en');
    expect(out.source).toBe('model');
    expect(out.items[0]!.text).toBe(explainFinding(listFacts(f)[0]!.fact, 'en'));
    expect(out.items[0]!.text).toMatch(/local technician/);
    const sent = JSON.parse(String((net.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.messages[0].content[0].text).toContain('Question: Why is Plan A proposed to me?');
    expect(sent.system[0].text).toMatch(/^You are a fact selector/);
  });

  it('sin modelo: la explicación local también sale en el idioma pedido', async () => {
    const out = await explain(facts(), 'what_to_check', { fetch: reply('no es json'), consume: allow }, 'en');
    expect(out.source).toBe('local');
    expect(out.items.length).toBeGreaterThan(0);
    for (const i of out.items) expect(i.text).not.toMatch(/técnico/);
  });
});
