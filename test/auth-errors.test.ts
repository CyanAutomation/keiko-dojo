import { describe, expect, it } from 'vitest';
import { AuthFailure } from '../src/auth/bearer-auth';
import { authFailureResponse } from '../src/http/auth-errors';

describe('authFailureResponse', () => {
  it('returns retry guidance for rate limits', async () => {
    const response = authFailureResponse(
      new AuthFailure('rate_limited', 'Too many requests'),
      'request-1'
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toMatchObject({
      error: { code: 'rate_limited', message: 'Too many requests' },
      requestId: 'request-1',
    });
  });

  it.each([
    ['unauthorized', 401, 'authentication_required'],
    ['forbidden', 403, 'insufficient_scope'],
    ['unavailable', 503, 'authentication_unavailable'],
  ] as const)('maps %s failures consistently', async (kind, status, code) => {
    const response = authFailureResponse(new AuthFailure(kind, 'Auth failure'), 'request-2');

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      error: { code, message: kind === 'unavailable' ? 'Authentication service unavailable' : 'Auth failure' },
      requestId: 'request-2',
    });
    if (kind === 'unauthorized') {
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
  });
});
