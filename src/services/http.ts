// Utilidades de las rutas API. Solo servidor.

/** Lee un cuerpo JSON acotado. `undefined` si excede el tamaño o no es JSON. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Respuesta JSON privada: nunca se guarda en cachés intermedias. */
export function privateJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
