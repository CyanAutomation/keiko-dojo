import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export const testAuthIssuer = 'https://auth.example.test';
export const testAuthAudience = 'keiko-dojo-api';
const testAuthKeyId = 'keiko-test-key';

export type TestTokenOptions = {
  aud?: string;
  scope?: string;
  expired?: boolean;
  issuedAtOffsetSeconds?: number;
  subject?: string;
  appUserId?: string;
};

export async function createTestAuthKeys(): Promise<{ privateKey: CryptoKey; publicJwk: JWK }> {
  const keys = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  return {
    privateKey: keys.privateKey,
    publicJwk: {
      ...(await exportJWK(keys.publicKey)),
      alg: 'EdDSA',
      kid: testAuthKeyId,
      use: 'sig',
    },
  };
}

export async function createTestToken(
  privateKey: CryptoKey,
  userId: string,
  options: TestTokenOptions = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = options.expired
    ? now - 600
    : now + (options.issuedAtOffsetSeconds ?? 0);
  return new SignJWT({
    appUserId: options.appUserId ?? userId,
    scope: options.scope ?? 'sessions:read sessions:write',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: testAuthKeyId })
    .setSubject(options.subject ?? userId)
    .setIssuer(testAuthIssuer)
    .setAudience(options.aud ?? testAuthAudience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(options.expired ? now - 300 : issuedAt + 300)
    .sign(privateKey);
}

export function credentialBearingVideoUrl(): string {
  const url = new URL('https://videos.example.test/clip');
  url.username = 'athlete';
  url.password = 'password';
  return url.toString();
}
