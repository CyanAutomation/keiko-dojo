import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type JWTPayload,
  type RemoteJWKSetOptions,
} from 'jose';

export type RequiredScope =
  | 'sessions:read'
  | 'sessions:write'
  | 'backups:read'
  | 'backups:write'
  | 'backups:restore';
export type AuthenticatedUser = { userId: string };
export type AuthFailureKind = 'unauthorized' | 'forbidden' | 'unavailable' | 'rate_limited';

export class AuthFailure extends Error {
  constructor(readonly kind: AuthFailureKind, message: string) {
    super(message);
    this.name = 'AuthFailure';
  }
}

let cachedJwksUrl = '';
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

class JwksFetchFailure extends Error {
  constructor() {
    super('Remote JWKS fetch failed');
    this.name = 'JwksFetchFailure';
  }
}

function readRequiredConfig(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new AuthFailure('unavailable', 'Authentication is unavailable');
  }
  return normalized;
}

function remoteJwks(urlText: string) {
  if (cachedJwks && cachedJwksUrl === urlText) return cachedJwks;

  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new AuthFailure('unavailable', 'Authentication is unavailable');
  }
  const isLocalHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new AuthFailure('unavailable', 'Authentication is unavailable');
  }

  const options: RemoteJWKSetOptions = {
    timeoutDuration: 5000,
    [customFetch]: async (url, requestOptions) => {
      try {
        return await fetch(url, requestOptions);
      } catch {
        throw new JwksFetchFailure();
      }
    },
  };
  cachedJwks = createRemoteJWKSet(url, options);
  cachedJwksUrl = urlText;
  return cachedJwks;
}

function isJwksUnavailable(error: unknown): boolean {
  return (
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    (error instanceof errors.JOSEError && error.code === 'ERR_JOSE_GENERIC') ||
    error instanceof JwksFetchFailure
  );
}

function validatePayload(
  payload: JWTPayload,
  requiredScope: RequiredScope
): AuthenticatedUser {
  const appUserId = payload.appUserId;
  if (
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    typeof appUserId !== 'string' ||
    appUserId.length === 0 ||
    payload.sub !== appUserId
  ) {
    throw new AuthFailure('unauthorized', 'Invalid access token');
  }

  if (
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 300
  ) {
    throw new AuthFailure('unauthorized', 'Invalid access token');
  }

  if (typeof payload.scope !== 'string') {
    throw new AuthFailure('unauthorized', 'Invalid access token');
  }
  const scopes = new Set(payload.scope.split(/\s+/).filter(Boolean));
  if (!scopes.has(requiredScope)) {
    throw new AuthFailure('forbidden', 'The token does not grant this operation');
  }

  return { userId: payload.sub };
}

export async function authenticateRequest(
  request: Request,
  env: Pick<Env, 'AUTH_JWKS_URL' | 'AUTH_ISSUER' | 'AUTH_AUDIENCE' | 'SESSION_READ_LIMITER' | 'SESSION_WRITE_LIMITER' | 'BACKUP_WRITE_LIMITER' | 'ENVIRONMENT'>,
  requiredScope: RequiredScope
): Promise<AuthenticatedUser> {
  const authorization = request.headers.get('authorization');
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/i);
  if (!match || match[1].length > 8192) {
    throw new AuthFailure('unauthorized', 'Authentication required');
  }

  const jwksUrl = readRequiredConfig(env.AUTH_JWKS_URL);
  const issuer = readRequiredConfig(env.AUTH_ISSUER);
  const audience = readRequiredConfig(env.AUTH_AUDIENCE);
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(match[1], remoteJwks(jwksUrl), {
      algorithms: ['EdDSA'],
      issuer,
      audience,
      maxTokenAge: '5m',
      clockTolerance: 5,
    });
    payload = verified.payload;
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    if (isJwksUnavailable(error)) {
      throw new AuthFailure('unavailable', 'Authentication service unavailable');
    }
    throw new AuthFailure('unauthorized', 'Invalid access token');
  }

  const principal = validatePayload(payload, requiredScope);
  const environment = env.ENVIRONMENT as string;
  if (environment === 'local' || environment === 'test') return principal;
  const limiter = requiredScope === 'sessions:read' || requiredScope === 'backups:read'
    ? env.SESSION_READ_LIMITER
    : requiredScope === 'sessions:write'
      ? env.SESSION_WRITE_LIMITER
      : env.BACKUP_WRITE_LIMITER;
  try {
    const result = await limiter.limit({ key: principal.userId });
    if (!result.success) {
      throw new AuthFailure('rate_limited', 'Too many requests');
    }
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    throw new AuthFailure('unavailable', 'Rate limiting is unavailable');
  }
  return principal;
}
