import type {
  JudoSession,
  SessionRecord,
} from '../domain/session';
import { validateSessionPayload } from '../domain/session';

export type SessionFilters = {
  from?: string;
  to?: string;
  category?: string;
  effort?: number;
  limit: number;
  cursor?: string;
};

export type SessionPage = {
  records: SessionRecord[];
  nextCursor: string | null;
};

export interface SessionRepository {
  list(userId: string, filters: SessionFilters): Promise<SessionPage>;
  get(userId: string, id: string): Promise<SessionRecord | null>;
  create(userId: string, session: JudoSession): Promise<SessionRecord>;
  update(
    userId: string,
    session: JudoSession,
    expectedRevision: number
  ): Promise<SessionRecord>;
  delete(userId: string, id: string, expectedRevision: number): Promise<void>;
}

export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found');
    this.name = 'SessionNotFoundError';
  }
}

export class SessionAlreadyExistsError extends Error {
  constructor() {
    super('Session already exists');
    this.name = 'SessionAlreadyExistsError';
  }
}

export class SessionRevisionConflictError extends Error {
  constructor() {
    super('Session revision does not match the current record');
    this.name = 'SessionRevisionConflictError';
  }
}

export class InvalidSessionError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_session' | 'bad_request' = 'invalid_session'
  ) {
    super(message);
    this.name = 'InvalidSessionError';
  }
}

export class InvalidSessionCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidSessionCursorError';
  }
}

export class SessionService {
  constructor(private readonly repository: SessionRepository) {}

  list(userId: string, filters: SessionFilters): Promise<SessionPage> {
    return this.repository.list(userId, filters);
  }

  get(userId: string, id: string): Promise<SessionRecord | null> {
    return this.repository.get(userId, id);
  }

  create(
    userId: string,
    payload: Record<string, unknown>
  ): Promise<SessionRecord> {
    const validation = validateSessionPayload(payload, {
      generateIdWhenMissing: true,
    });
    if (!validation.ok) throw new InvalidSessionError(validation.error);
    return this.repository.create(userId, validation.session);
  }

  update(
    userId: string,
    id: string,
    payload: Record<string, unknown>,
    expectedRevision: number
  ): Promise<SessionRecord> {
    if (payload.id !== undefined && payload.id !== id) {
      throw new InvalidSessionError('Session ID mismatch', 'bad_request');
    }
    const validation = validateSessionPayload(payload, {
      routeId: id,
      generateIdWhenMissing: false,
    });
    if (!validation.ok) throw new InvalidSessionError(validation.error);
    return this.repository.update(userId, validation.session, expectedRevision);
  }

  delete(
    userId: string,
    id: string,
    expectedRevision: number
  ): Promise<void> {
    return this.repository.delete(userId, id, expectedRevision);
  }
}
