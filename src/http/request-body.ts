export type LimitedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid' | 'too_large' };

/** Parse JSON while enforcing the limit against bytes actually streamed. */
export async function readJsonBodyLimited(
  request: Request,
  maxBytes: number
): Promise<LimitedJsonResult> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { ok: false, reason: 'invalid' };
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)) return { ok: false, reason: 'invalid' };
    if (declaredLength > maxBytes) return { ok: false, reason: 'too_large' };
  }

  if (!request.body) return { ok: false, reason: 'invalid' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
