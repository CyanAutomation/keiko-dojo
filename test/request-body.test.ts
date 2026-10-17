import { describe, expect, it } from 'vitest';
import { readJsonBodyLimited } from '../src/http/request-body';

describe('readJsonBodyLimited', () => {
  it('parses valid JSON at the byte limit', async () => {
    const body = '{"ok":true}';
    const response = await readJsonBodyLimited(
      new Request('https://keiko.example.test', { method: 'POST', body }),
      new TextEncoder().encode(body).byteLength
    );
    expect(response).toEqual({ ok: true, value: { ok: true } });
  });

  it('rejects streamed bytes above the limit when Content-Length is absent', async () => {
    const request = new Request('https://keiko.example.test', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":"12345"}'));
          controller.close();
        },
      }),
    });
    expect(await readJsonBodyLimited(request, 8)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('counts actual bytes when Content-Length understates the body', async () => {
    const request = new Request('https://keiko.example.test', {
      method: 'POST',
      headers: { 'content-length': '1' },
      body: '{"value":"12345"}',
    });
    expect(await readJsonBodyLimited(request, 8)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('rejects malformed Content-Length values', async () => {
    const request = new Request('https://keiko.example.test', {
      method: 'POST',
      headers: { 'content-length': 'not-a-number' },
      body: '{}',
    });
    expect(await readJsonBodyLimited(request, 8)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
