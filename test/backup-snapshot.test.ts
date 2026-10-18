import { describe, expect, it } from 'vitest';
import {
  snapshotChecksum,
  validatedSnapshotRows,
  type BackupSnapshotRow,
  type SnapshotSession,
} from '../src/domain/backup-snapshot';

const validRow: SnapshotSession = {
  id: 'session-1',
  session_date: '2026-10-16',
  category: 'Technical',
  effort: 3,
  payload: JSON.stringify({
    id: 'session-1',
    date: '2026-10-16',
    category: 'Technical',
    effort: 3,
    techniques: ['Uchi mata'],
  }),
  revision: 1,
  updated_at: '2026-10-16T12:00:00.000Z',
};

async function snapshotWith(rows: SnapshotSession[]): Promise<BackupSnapshotRow> {
  const payload = JSON.stringify(rows);
  const checksum = await snapshotChecksum(payload);
  return {
    id: 'snapshot-1',
    created_at: '2026-10-16T12:00:00.000Z',
    session_count: rows.length,
    checksum,
    payload,
  };
}

describe('validatedSnapshotRows', () => {
  it('accepts a well-formed snapshot', async () => {
    await expect(validatedSnapshotRows(await snapshotWith([validRow]))).resolves.toEqual([validRow]);
  });

  it('rejects duplicate session IDs', async () => {
    await expect(validatedSnapshotRows(await snapshotWith([validRow, validRow]))).resolves.toBeNull();
  });

  it('rejects row metadata that disagrees with the nested session', async () => {
    const mismatchedRow = { ...validRow, category: 'Randori' };
    await expect(validatedSnapshotRows(await snapshotWith([mismatchedRow]))).resolves.toBeNull();
  });

  it('rejects non-canonical timestamps', async () => {
    const nonCanonicalRow = { ...validRow, updated_at: '2026-10-16T12:00:00Z' };
    await expect(validatedSnapshotRows(await snapshotWith([nonCanonicalRow]))).resolves.toBeNull();
  });
});
