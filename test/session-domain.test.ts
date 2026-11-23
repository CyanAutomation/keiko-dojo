import { describe, expect, it } from 'vitest';
import { validateSessionPayload } from '../src/domain/session';

const validPayload = {
  id: 'session-1',
  date: '2026-10-24',
  effort: 4,
  category: 'Technical',
  techniques: ['Grip fighting'],
};

describe('validateSessionPayload', () => {
  it.each([
    ['description', 42, 'Invalid description: expected a string'],
    ['notes', false, 'Invalid notes: expected a string'],
    ['duration', 1.5, 'Invalid duration: expected a non-negative integer'],
    ['duration', -1, 'Invalid duration: expected a non-negative integer'],
  ])('rejects invalid %s values with the established error', (field, value, error) => {
    expect(validateSessionPayload(
      { ...validPayload, [field]: value },
      { generateIdWhenMissing: false }
    )).toEqual({ ok: false, error });
  });

  it('preserves valid optional fields while normalizing techniques', () => {
    expect(validateSessionPayload({
      ...validPayload,
      techniques: [' Grip fighting ', 'Grip fighting'],
      description: 'Entries',
      notes: 'Keep posture',
      duration: 90,
      videoUrl: 'https://example.test/clip',
    }, { generateIdWhenMissing: false })).toEqual({
      ok: true,
      session: {
        id: 'session-1',
        date: '2026-10-24',
        effort: 4,
        category: 'Technical',
        techniques: ['Grip fighting'],
        description: 'Entries',
        notes: 'Keep posture',
        duration: 90,
        videoUrl: 'https://example.test/clip',
      },
    });
  });
});
