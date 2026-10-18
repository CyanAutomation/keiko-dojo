import { isBlockedNetworkHostname } from './network-safety';

const SESSION_CATEGORIES = [
  'Technical',
  'Randori',
  'Shiai',
  'Cardio',
  'S&C',
] as const;

export type SessionCategory = (typeof SESSION_CATEGORIES)[number];
export type EffortLevel = 1 | 2 | 3 | 4 | 5;

export function isSessionCategory(value: string): value is SessionCategory {
  return SESSION_CATEGORIES.some((category) => category === value);
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

export type JudoSession = {
  id: string;
  date: string;
  description?: string;
  techniques: string[];
  effort: EffortLevel;
  category: SessionCategory;
  notes?: string;
  duration?: number;
  videoUrl?: string;
};

export type SessionRecord = {
  session: JudoSession;
  revision: number;
};

export type SessionValidation =
  | { ok: true; session: JudoSession }
  | { ok: false; error: string };

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_SESSION_ID_LENGTH = 100;

export function validateSessionId(
  value: unknown,
  generateWhenMissing: boolean
): { ok: true; value: string } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return generateWhenMissing
      ? { ok: true, value: `session-${Date.now()}-${crypto.randomUUID()}` }
      : { ok: false, error: 'Missing required field: id' };
  }

  if (typeof value !== 'string') {
    return { ok: false, error: 'Invalid id: expected a string' };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: 'Invalid id: expected a non-empty string' };
  }
  if (trimmed.length > MAX_SESSION_ID_LENGTH) {
    return {
      ok: false,
      error: `Invalid id: exceeds maximum length of ${MAX_SESSION_ID_LENGTH} characters`,
    };
  }
  if (!SESSION_ID_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error:
        'Invalid id: contains invalid characters; only letters, digits, "-" and "_" are allowed',
    };
  }

  return { ok: true, value: trimmed };
}

function validateDate(
  value: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: 'Invalid date: expected YYYY-MM-DD format',
    };
  }
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return {
      ok: false,
      error: 'Invalid date: expected YYYY-MM-DD format',
    };
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return {
      ok: false,
      error: 'Invalid date: must be a real calendar date',
    };
  }
  return { ok: true, value };
}

function validateVideoUrl(
  value: unknown
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string') {
    return { ok: false, error: 'Invalid videoUrl: expected a string' };
  }

  const trimmed = value.trim();
  if (!trimmed) return { ok: true };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: 'Invalid videoUrl: expected a valid absolute URL',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: 'Invalid videoUrl: protocol must be http or https',
    };
  }
  if (isBlockedNetworkHostname(parsed.hostname)) {
    return {
      ok: false,
      error:
        'Invalid videoUrl: private or internal network addresses are not allowed',
    };
  }
  return { ok: true, value: parsed.toString() };
}

function validateTechniques(value: unknown):
  | { ok: true; techniques: string[] }
  | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: 'Invalid techniques: expected an array of non-empty strings',
    };
  }
  const techniques: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const technique: unknown = value[index];
    if (typeof technique !== 'string') {
      return {
        ok: false,
        error: `Invalid techniques[${index}]: expected a string`,
      };
    }
    const trimmed = technique.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: `Invalid techniques[${index}]: value cannot be empty`,
      };
    }
    techniques.push(trimmed);
  }
  return { ok: true, techniques: [...new Set(techniques)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateSessionPayload(
  payload: Record<string, unknown>,
  options: { routeId?: string; generateIdWhenMissing: boolean }
): SessionValidation {
  const idResult = validateSessionId(
    options.routeId ?? payload.id,
    options.generateIdWhenMissing
  );
  if (!idResult.ok) return idResult;

  const dateResult = validateDate(payload.date);
  if (!dateResult.ok) return dateResult;

  if (!isEffortLevel(payload.effort)) {
    return {
      ok: false,
      error: 'Invalid effort level (must be an integer 1-5)',
    };
  }

  if (
    typeof payload.category !== 'string' ||
    !isSessionCategory(payload.category)
  ) {
    return { ok: false, error: 'Invalid category' };
  }

  const techniquesResult = validateTechniques(payload.techniques);
  if (!techniquesResult.ok) return techniquesResult;

  if (payload.description !== undefined && typeof payload.description !== 'string') {
    return { ok: false, error: 'Invalid description: expected a string' };
  }
  if (payload.notes !== undefined && typeof payload.notes !== 'string') {
    return { ok: false, error: 'Invalid notes: expected a string' };
  }

  const videoUrlResult = validateVideoUrl(payload.videoUrl);
  if (!videoUrlResult.ok) return videoUrlResult;

  if (
    payload.duration !== undefined &&
    (typeof payload.duration !== 'number' ||
      !Number.isInteger(payload.duration) ||
      payload.duration < 0)
  ) {
    return {
      ok: false,
      error: 'Invalid duration: expected a non-negative integer',
    };
  }

  return {
    ok: true,
    session: {
      id: idResult.value,
      date: dateResult.value,
      effort: payload.effort,
      category: payload.category,
      techniques: techniquesResult.techniques,
      ...(payload.description !== undefined
        ? { description: payload.description }
        : {}),
      ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
      ...(videoUrlResult.value !== undefined
        ? { videoUrl: videoUrlResult.value }
        : {}),
      ...(payload.duration !== undefined
        ? { duration: payload.duration }
        : {}),
    },
  };
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
