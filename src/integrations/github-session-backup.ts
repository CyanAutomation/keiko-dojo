import { isSessionCategory, isValidSessionDate } from '../domain/session';
import { validateSafeHttpUrl } from '../domain/network-safety';
import { isSafeSessionMarkdownPath, renderSessionFrontmatter } from '../domain/github-session-markdown';

type MarkdownSession = {
  id: string;
  date: string;
  effort: number;
  category: string;
  techniques: string[];
  description?: string;
  notes?: string;
  duration?: number;
  videoUrl?: string;
};

export type GitHubSessionRow = {
  id: string;
  session_date: string;
  category: string;
  effort: number;
  payload: string;
  revision: number;
  updated_at: string;
};

export type GitHubSessionBackupFile = {
  id: string;
  path: string;
  revision: number;
  markdown: string;
  sessionDate: string;
};

function decodeSessionPayload(row: GitHubSessionRow): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(row.payload); } catch { throw new Error('Stored session payload is invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored session payload is invalid');
  }
  return value as Record<string, unknown>;
}

function hasValidSessionId(session: Record<string, unknown>, row: GitHubSessionRow): boolean {
  return typeof session.id === 'string' &&
    session.id === row.id &&
    /^[A-Za-z0-9_-]{1,100}$/.test(session.id);
}

function hasValidSessionDate(session: Record<string, unknown>, row: GitHubSessionRow): boolean {
  return typeof session.date === 'string' &&
    session.date === row.session_date &&
    isValidSessionDate(session.date);
}

function hasValidSessionEffort(session: Record<string, unknown>, row: GitHubSessionRow): boolean {
  return typeof session.effort === 'number' &&
    Number.isInteger(session.effort) &&
    session.effort >= 1 &&
    session.effort <= 5 &&
    session.effort === row.effort;
}

function hasValidSessionCategory(session: Record<string, unknown>, row: GitHubSessionRow): boolean {
  return typeof session.category === 'string' &&
    session.category === row.category &&
    isSessionCategory(session.category);
}

function matchesStoredSessionIdentity(
  session: Record<string, unknown>,
  row: GitHubSessionRow
): session is Record<string, unknown> & Pick<MarkdownSession, 'id' | 'date' | 'effort' | 'category'> {
  return hasValidSessionId(session, row) &&
    hasValidSessionDate(session, row) &&
    hasValidSessionEffort(session, row) &&
    hasValidSessionCategory(session, row);
}

function hasValidTechniques(
  session: Record<string, unknown>
): session is Record<string, unknown> & Pick<MarkdownSession, 'techniques'> {
  return Array.isArray(session.techniques) &&
    session.techniques.every((technique) =>
      typeof technique === 'string' && technique.trim().length > 0
    );
}

function isValidDescription(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isValidDuration(value: unknown): boolean {
  return value === undefined || (
    typeof value === 'number' && Number.isInteger(value) && value >= 0
  );
}

function isValidVideoUrl(value: unknown): boolean {
  if (value === undefined || value === '') return true;
  return typeof value === 'string' && validateSafeHttpUrl(value).ok;
}

function hasValidOptionalFields(session: Record<string, unknown>): boolean {
  return isValidDescription(session.description) &&
    isValidDescription(session.notes) &&
    isValidDuration(session.duration) &&
    isValidVideoUrl(session.videoUrl);
}

function isValidMarkdownSession(
  session: Record<string, unknown>,
  row: GitHubSessionRow
): session is Record<string, unknown> & MarkdownSession {
  return matchesStoredSessionIdentity(session, row) &&
    hasValidTechniques(session) &&
    hasValidOptionalFields(session);
}

function markdownSession(row: GitHubSessionRow): MarkdownSession {
  const session = decodeSessionPayload(row);
  if (!isValidMarkdownSession(session, row)) {
    throw new Error('Stored session payload is invalid');
  }
  return {
    id: session.id,
    date: session.date,
    effort: session.effort,
    category: session.category,
    techniques: session.techniques,
    ...(typeof session.description === 'string' ? { description: session.description } : {}),
    ...(typeof session.notes === 'string' ? { notes: session.notes } : {}),
    ...(typeof session.duration === 'number' ? { duration: session.duration } : {}),
    ...(typeof session.videoUrl === 'string' && session.videoUrl ? { videoUrl: session.videoUrl } : {}),
  };
}

function sessionMarkdown(session: MarkdownSession): string {
  const escapeMarkdown = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|~])/g, '\\$1');
  const escapeTechnique = (value: string) => escapeMarkdown(value.replace(/[\r\n\t]+/g, ' ').trim());
  const frontmatter = renderSessionFrontmatter(session);
  const techniques = session.techniques.length
    ? session.techniques.map((technique) => '- ' + escapeTechnique(technique)).join('\n')
    : '- (none recorded)';
  const textPayload = JSON.stringify({
    techniques: session.techniques,
    ...(session.description !== undefined ? { description: session.description } : {}),
    ...(session.notes !== undefined ? { notes: session.notes } : {}),
  });
  frontmatter.push(
    'keikoBackupVersion: 1',
    'keikoTextPayload: ' + JSON.stringify(textPayload)
  );
  return '---\n' + frontmatter.join('\n') +
    '\n---\n\n# ' + session.date + ' - Judo Session: ' + session.category +
    '\n\n## Techniques Practiced\n' + techniques +
    '\n\n## Session Description\n\n' + escapeMarkdown(session.description ?? '') +
    '\n\n## Notes\n\n' + escapeMarkdown(session.notes ?? '') + '\n';
}

function githubSessionMarkdownPath(session: Pick<MarkdownSession, 'id' | 'date'>): string {
  const compactDate = session.date.replaceAll('-', '');
  const [year, month] = session.date.split('-');
  return 'data/' + year + '/' + month + '/' + compactDate + '-matmetrics-' + session.id + '.md';
}

export function githubSessionMarkdownPathForRow(row: GitHubSessionRow): string {
  return githubSessionMarkdownPath(markdownSession(row));
}

export function buildGitHubSessionBackupFile(row: GitHubSessionRow): GitHubSessionBackupFile {
  const session = markdownSession(row);
  return {
    id: session.id,
    revision: row.revision,
    path: githubSessionMarkdownPath(session),
    markdown: sessionMarkdown(session),
    sessionDate: row.session_date,
  };
}

export function isKeikoSessionMarkdownPath(path: string): boolean {
  return isSafeSessionMarkdownPath(path) &&
    /^data\/\d{4}\/(0[1-9]|1[0-2])\/\d{8}-matmetrics-[A-Za-z0-9_-]{1,100}\.md$/.test(path);
}
