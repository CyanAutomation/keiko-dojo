import {
  isJsonObject,
  validateSessionPayload,
  type JudoSession,
  type SessionRecord,
} from '../domain/session';
import type { AnalyticsSummary } from '../application/session-service';
import {
  InvalidSessionCursorError,
  SessionAlreadyExistsError,
  SessionNotFoundError,
  SessionRevisionConflictError,
  type SessionFilters,
  type SessionPage,
  type SessionRepository,
} from '../application/session-service';

type SessionRow = {
  id: string;
  payload: string;
  revision: number;
  session_date: string;
};

type SessionCursor = { date: string; id: string };

function decodeCursor(value: string | undefined): SessionCursor | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidSessionCursorError();
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(atob(base64));
    if (
      !isJsonObject(parsed) ||
      typeof parsed.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ||
      typeof parsed.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(parsed.id)
    ) {
      throw new InvalidSessionCursorError();
    }
    return { date: parsed.date, id: parsed.id };
  } catch {
    throw new InvalidSessionCursorError();
  }
}

function encodeCursor(cursor: SessionCursor): string {
  return btoa(JSON.stringify(cursor))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function rowToRecord(row: SessionRow): SessionRecord {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new Error('Stored session payload is not valid JSON');
  }
  if (!isJsonObject(payload)) {
    throw new Error('Stored session payload is not an object');
  }
  if (payload.id !== row.id || payload.date !== row.session_date) {
    throw new Error('Stored session metadata does not match its payload');
  }
  const validation = validateSessionPayload(payload, {
    routeId: row.id,
    generateIdWhenMissing: false,
  });
  if (!validation.ok || !Number.isInteger(row.revision) || row.revision < 1) {
    throw new Error('Stored session record is invalid');
  }
  return { session: validation.session, revision: row.revision };
}

export class D1SessionRepository implements SessionRepository {
  constructor(private readonly db: D1Database) {}

  async analytics(userId: string): Promise<AnalyticsSummary> {
    const totals = await this.db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(AVG(effort), 0) AS average_effort
       FROM sessions WHERE user_id = ?`
    ).bind(userId).first<{ total: number; average_effort: number }>();

    const categoryRows = await this.db.prepare(
      `SELECT 'all' AS period, category AS name, COUNT(*) AS count
         FROM sessions WHERE user_id = ? GROUP BY category
       UNION ALL
       SELECT 'last30Days' AS period, category AS name, COUNT(*) AS count
         FROM sessions WHERE user_id = ? AND session_date >= date('now', '-30 days') GROUP BY category
       UNION ALL
       SELECT 'last90Days' AS period, category AS name, COUNT(*) AS count
         FROM sessions WHERE user_id = ? AND session_date >= date('now', '-90 days') GROUP BY category`
    ).bind(userId, userId, userId).all<{ period: string; name: string; count: number }>();

    const effortRows = await this.db.prepare(
      `SELECT 'all' AS period, effort AS name, COUNT(*) AS count
         FROM sessions WHERE user_id = ? GROUP BY effort
       UNION ALL
       SELECT 'last30Days' AS period, effort AS name, COUNT(*) AS count
         FROM sessions WHERE user_id = ? AND session_date >= date('now', '-30 days') GROUP BY effort
       UNION ALL
       SELECT 'last90Days' AS period, effort AS name, COUNT(*) AS count
         FROM sessions WHERE user_id = ? AND session_date >= date('now', '-90 days') GROUP BY effort`
    ).bind(userId, userId, userId).all<{ period: string; name: number; count: number }>();

    const recent = await this.db.prepare(
      `SELECT session_date AS date, effort FROM sessions
       WHERE user_id = ? ORDER BY session_date DESC, id DESC LIMIT 10`
    ).bind(userId).all<{ date: string; effort: number }>();

    const backup = await this.db.prepare(
      `SELECT EXISTS(
         SELECT 1 FROM github_installations WHERE user_id = ? AND revoked_at IS NULL
       ) AS configured,
       (SELECT MAX(completed_at) FROM backup_jobs WHERE user_id = ? AND status = 'completed') AS last_backup_at`
    ).bind(userId, userId).first<{ configured: number; last_backup_at: string | null }>();

    const periods = ['all', 'last30Days', 'last90Days'] as const;
    const distributions = Object.fromEntries(periods.map((period) => [period, {
      categories: categoryRows.results
        .filter((row) => row.period === period)
        .map(({ name, count }) => ({ name, count })),
      effort: effortRows.results
        .filter((row) => row.period === period)
        .map(({ name, count }) => ({ name, count })),
    }])) as AnalyticsSummary['distributions'];

    return {
      totalSessions: totals?.total ?? 0,
      averageEffort: Math.round((totals?.average_effort ?? 0) * 100) / 100,
      distributions,
      recentEffort: recent.results,
      backupStatus: {
        configured: backup?.configured === 1,
        lastBackupAt: backup?.last_backup_at ?? null,
      },
    };
  }

  async list(userId: string, filters: SessionFilters): Promise<SessionPage> {
    const where = ['user_id = ?'];
    const values: Array<string | number> = [userId];

    if (filters.from) {
      where.push('session_date >= ?');
      values.push(filters.from);
    }
    if (filters.to) {
      where.push('session_date <= ?');
      values.push(filters.to);
    }
    if (filters.category) {
      where.push('category = ?');
      values.push(filters.category);
    }
    if (filters.effort !== undefined) {
      where.push('effort = ?');
      values.push(filters.effort);
    }

    const cursor = decodeCursor(filters.cursor);
    if (cursor) {
      where.push('(session_date < ? OR (session_date = ? AND id < ?))');
      values.push(cursor.date, cursor.date, cursor.id);
    }

    values.push(filters.limit + 1);
    const result = await this.db
      .prepare(
        `SELECT id, payload, revision, session_date
         FROM sessions
         WHERE ${where.join(' AND ')}
         ORDER BY session_date DESC, id DESC
         LIMIT ?`
      )
      .bind(...values)
      .all<SessionRow>();

    const rows = result.results;
    const hasMore = rows.length > filters.limit;
    const records = rows.slice(0, filters.limit).map(rowToRecord);
    const last = records.at(-1)?.session;
    return {
      records,
      nextCursor:
        hasMore && last
          ? encodeCursor({ date: last.date, id: last.id })
          : null,
    };
  }

  async get(userId: string, id: string): Promise<SessionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, payload, revision, session_date
         FROM sessions WHERE user_id = ? AND id = ?`
      )
      .bind(userId, id)
      .first<SessionRow>();
    return row ? rowToRecord(row) : null;
  }

  async create(userId: string, session: JudoSession): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions
           (user_id, id, session_date, category, effort, payload, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .bind(
        userId,
        session.id,
        session.date,
        session.category,
        session.effort,
        JSON.stringify(session),
        now,
        now
      )
      .run();

    if (result.meta.changes === 0) throw new SessionAlreadyExistsError();
    return { session, revision: 1 };
  }

  async update(
    userId: string,
    session: JudoSession,
    expectedRevision: number
  ): Promise<SessionRecord> {
    const result = await this.db
      .prepare(
        `UPDATE sessions
         SET session_date = ?, category = ?, effort = ?, payload = ?,
             revision = revision + 1, updated_at = ?
         WHERE user_id = ? AND id = ? AND revision = ?`
      )
      .bind(
        session.date,
        session.category,
        session.effort,
        JSON.stringify(session),
        new Date().toISOString(),
        userId,
        session.id,
        expectedRevision
      )
      .run();

    if (result.meta.changes === 0) {
      const current = await this.get(userId, session.id);
      if (!current) throw new SessionNotFoundError();
      throw new SessionRevisionConflictError();
    }
    return { session, revision: expectedRevision + 1 };
  }

  async delete(
    userId: string,
    id: string,
    expectedRevision: number
  ): Promise<void> {
    const result = await this.db
      .prepare(
        'DELETE FROM sessions WHERE user_id = ? AND id = ? AND revision = ?'
      )
      .bind(userId, id, expectedRevision)
      .run();

    if (result.meta.changes === 0) {
      const current = await this.get(userId, id);
      if (!current) throw new SessionNotFoundError();
      throw new SessionRevisionConflictError();
    }
  }
}
