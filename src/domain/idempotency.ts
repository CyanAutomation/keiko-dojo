export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]+$/;

export function isValidIdempotencyKey(value: string): boolean {
  return value.length > 0 &&
    value.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
    IDEMPOTENCY_KEY_PATTERN.test(value);
}
