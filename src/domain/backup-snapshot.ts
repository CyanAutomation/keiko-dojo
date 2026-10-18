import { isEffortLevel, isJsonObject, isSessionCategory, validateSessionPayload } from './session';

export type SnapshotSession = {
  id: string;
  session_date: string;
  category: string;
  effort: number;
  payload: string;
  revision: number;
  updated_at: string;
};

export type BackupSnapshotRow = {
  id: string;
  created_at: string;
  session_count: number;
  checksum: string;
  payload: string;
};

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  try {
    return new Date(timestamp).toISOString() === value;
  } catch {
    return false;
  }
}

function hasValidMetadata(snapshot: BackupSnapshotRow): boolean {
  return Boolean(snapshot.id) &&
    isCanonicalTimestamp(snapshot.created_at) &&
    Number.isInteger(snapshot.session_count) && snapshot.session_count >= 0 &&
    /^[a-f0-9]{64}$/.test(snapshot.checksum);
}

export async function snapshotChecksum(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(payload)
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');
}

async function hasMatchingChecksum(snapshot: BackupSnapshotRow): Promise<boolean> {
  return await snapshotChecksum(snapshot.payload) === snapshot.checksum;
}

function parseSnapshotPayload(snapshot: BackupSnapshotRow): unknown[] | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(snapshot.payload) as unknown;
  } catch {
    return null;
  }
  return Array.isArray(decoded) && decoded.length === snapshot.session_count
    ? decoded
    : null;
}

function payloadMatchesSnapshotRow(row: SnapshotSession): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload) as unknown;
  } catch {
    return false;
  }
  if (!isJsonObject(payload)) return false;
  const validation = validateSessionPayload(payload, {
    routeId: row.id,
    generateIdWhenMissing: false,
  });
  return validation.ok &&
    payload.id === row.id &&
    validation.session.id === row.id &&
    validation.session.date === row.session_date &&
    validation.session.category === row.category &&
    validation.session.effort === row.effort;
}

function hasSnapshotSessionFields(
  value: Record<string, unknown>
): value is Record<string, unknown> & Pick<SnapshotSession,
  'id' | 'session_date' | 'category' | 'effort' | 'payload'> {
  return typeof value.id === 'string' &&
    typeof value.session_date === 'string' &&
    typeof value.category === 'string' &&
    isSessionCategory(value.category) &&
    isEffortLevel(value.effort) &&
    typeof value.payload === 'string';
}

function hasSnapshotRevisionFields(
  value: Record<string, unknown>
): value is Record<string, unknown> & Pick<SnapshotSession, 'revision' | 'updated_at'> {
  return typeof value.revision === 'number' &&
    Number.isInteger(value.revision) &&
    value.revision >= 1 &&
    typeof value.updated_at === 'string' &&
    isCanonicalTimestamp(value.updated_at);
}

function isSnapshotSession(value: unknown): value is SnapshotSession {
  if (
    !isJsonObject(value) ||
    !hasSnapshotSessionFields(value) ||
    !hasSnapshotRevisionFields(value)
  ) {
    return false;
  }
  return payloadMatchesSnapshotRow(value as SnapshotSession);
}

export async function validatedSnapshotRows(
  snapshot: BackupSnapshotRow
): Promise<SnapshotSession[] | null> {
  if (!hasValidMetadata(snapshot) || !(await hasMatchingChecksum(snapshot))) {
    return null;
  }
  const decoded = parseSnapshotPayload(snapshot);
  if (!decoded) return null;

  const seenIds = new Set<string>();
  const rows: SnapshotSession[] = [];
  for (const value of decoded) {
    if (!isSnapshotSession(value) || seenIds.has(value.id)) return null;
    seenIds.add(value.id);
    rows.push(value);
  }
  return rows;
}
