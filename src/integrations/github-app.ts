import { importPKCS8, SignJWT } from 'jose';
import { createPrivateKey } from 'node:crypto';
import type { SnapshotSession } from '../domain/backup-snapshot';
import { isSessionCategory } from '../domain/session';
import { configuredGitHubAppId } from './github-app-config';

type GitHubAppEnvironment = Env & {
  GITHUB_APP_PRIVATE_KEY?: string;
};

type GitHubInstallation = {
  user_id: string;
  installation_id: number;
  repository_owner: string;
  repository_name: string;
  repository_id: number;
};

export class GitHubInstallationVerificationError extends Error {
  constructor(
    readonly phase: string,
    readonly status?: number,
    message = 'GitHub installation verification failed',
    readonly causeName?: string,
    readonly causeCode?: string,
    readonly reason?: 'redirect_rejected' | 'cache_option' | 'network_error' | 'invalid_url' | 'other',
    readonly redirectOrigin?: string,
    readonly redirectPath?: string,
    readonly apiErrorCategory?: string
  ) {
    super(message);
  }
}

class GitHubAppApiError extends Error {
  constructor(readonly status: number, readonly category: string) {
    super('GitHub App API request failed');
  }
}

class GitHubRedirectError extends Error {
  constructor(readonly status: number, readonly origin: string, readonly pathname: string) {
    super('GitHub App API redirect rejected');
  }
}

function safeTransportDetails(error: unknown): {
  causeName?: string;
  causeCode?: string;
  reason: 'redirect_rejected' | 'cache_option' | 'network_error' | 'invalid_url' | 'other';
} {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : null;
  const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' &&
    /^[A-Z0-9_]{1,64}$/.test(cause.code) ? cause.code : undefined;
  return {
    ...(error instanceof Error ? { causeName: error.name } : {}),
    ...(code ? { causeCode: code } : {}),
    reason: message.includes('redirect')
      ? 'redirect_rejected'
      : message.includes('cache')
        ? 'cache_option'
        : message.includes('network') || message.includes('fetch failed')
          ? 'network_error'
          : message.includes('url')
            ? 'invalid_url'
            : 'other',
  };
}

function required(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error('GitHub App is not configured');
  return normalized;
}

async function appJwt(env: GitHubAppEnvironment): Promise<string> {
  const appId = configuredGitHubAppId(env.GITHUB_APP_ID);
  if (!appId) throw new Error('GitHub App is not configured');
  const pem = required(env.GITHUB_APP_PRIVATE_KEY).replace(/\\n/g, '\n');
  const pkcs8 = createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString();
  const key = await importPKCS8(pkcs8, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(appId)
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 540)
    .sign(key);
}

async function githubFetch(
  url: string,
  token: string,
  method = 'GET',
  body?: unknown
): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (location) {
      const target = new URL(location, url);
      throw new GitHubRedirectError(response.status, target.origin, target.pathname);
    }
    throw new GitHubRedirectError(response.status, new URL(url).origin, new URL(url).pathname);
  }
  return response;
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = '';
    try {
      const body: unknown = await response.clone().json();
      if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
        message = body.message.trim().toLowerCase();
      }
    } catch {
      // The status remains useful when GitHub does not return a JSON error.
    }
    const category = message === 'bad credentials'
      ? 'bad_credentials'
      : message.includes('not accessible by integration')
        ? 'integration_access_denied'
        : message.includes('not found')
          ? 'not_found'
          : message.includes('rate limit')
            ? 'rate_limited'
            : message.includes('requires authentication')
              ? 'authentication_required'
              : message.includes('validation failed')
                ? 'validation_failed'
                : message.includes('forbidden') || response.status === 403
                  ? 'forbidden'
                  : 'other';
    throw new GitHubAppApiError(response.status, category);
  }
  return response.json() as Promise<T>;
}

export async function verifySelectedRepositoryInstallation(
  env: GitHubAppEnvironment,
  installationId: number
): Promise<Pick<GitHubInstallation, 'installation_id' | 'repository_owner' | 'repository_name' | 'repository_id'>> {
  let phase = 'app_jwt';
  try {
    const jwt = await appJwt(env);
    phase = 'installation_lookup_request';
    const installationResponse = await githubFetch(
      `https://api.github.com/app/installations/${installationId}`,
      jwt
    );
    phase = 'installation_lookup_response';
    const installation = await responseJson<{
      id: number;
      repository_selection: string;
    }>(installationResponse);
    if (installation.id !== installationId || installation.repository_selection !== 'selected') {
      phase = 'installation_scope';
      throw new Error('GitHub App must be installed with selected repository access');
    }

    phase = 'installation_token_request';
    const tokenResponse = await githubFetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      jwt,
      'POST',
      { permissions: { contents: 'read' } }
    );
    phase = 'installation_token_response';
    const readToken = await responseJson<{ token: string }>(tokenResponse);
    phase = 'repository_list_request';
    const repositoryResponse = await githubFetch(
      'https://api.github.com/installation/repositories?per_page=100',
      readToken.token
    );
    phase = 'repository_list_response';
    const repositoryPage = await responseJson<{
      total_count: number;
      repositories: Array<{ id: number; name: string; full_name: string; owner: { login: string } }>;
    }>(repositoryResponse);
    if (repositoryPage.total_count !== 1 || repositoryPage.repositories.length !== 1) {
      phase = 'repository_scope';
      throw new Error('GitHub App installation must be limited to one repository');
    }
    const repository = repositoryPage.repositories[0]!;
    if (
      !Number.isSafeInteger(repository.id) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(repository.owner.login)
    ) {
      phase = 'repository_validation';
      throw new Error('GitHub returned an invalid repository');
    }
    return {
      installation_id: installationId,
      repository_owner: repository.owner.login,
      repository_name: repository.name,
      repository_id: repository.id,
    };
  } catch (error) {
    if (error instanceof GitHubInstallationVerificationError) throw error;
    const details = safeTransportDetails(error);
    throw new GitHubInstallationVerificationError(
      phase,
      error instanceof GitHubAppApiError || error instanceof GitHubRedirectError ? error.status : undefined,
      error instanceof Error && error.message === 'GitHub App is not configured'
        ? error.message
        : undefined,
      details.causeName,
      details.causeCode,
      details.reason,
      error instanceof GitHubRedirectError ? error.origin : undefined,
      error instanceof GitHubRedirectError ? error.pathname : undefined,
      error instanceof GitHubAppApiError ? error.category : undefined
    );
  }
}

async function scopedContentsToken(
  env: GitHubAppEnvironment,
  installationId: number,
  repositoryName: string
): Promise<string> {
  const jwt = await appJwt(env);
  const value = await responseJson<{ token: string }>(await githubFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    jwt,
    'POST',
    { repositories: [repositoryName], permissions: { contents: 'write' } }
  ));
  return value.token;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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

function decodeSessionPayload(row: SnapshotSession): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(row.payload); } catch { throw new Error('Stored session payload is invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored session payload is invalid');
  }
  return value as Record<string, unknown>;
}

function hasValidSessionId(session: Record<string, unknown>, row: SnapshotSession): boolean {
  return typeof session.id === 'string' &&
    session.id === row.id &&
    /^[A-Za-z0-9_-]{1,100}$/.test(session.id);
}

function hasValidSessionDate(session: Record<string, unknown>, row: SnapshotSession): boolean {
  return typeof session.date === 'string' &&
    session.date === row.session_date &&
    validSessionDate(session.date);
}

function hasValidSessionEffort(session: Record<string, unknown>, row: SnapshotSession): boolean {
  return typeof session.effort === 'number' &&
    Number.isInteger(session.effort) &&
    session.effort >= 1 &&
    session.effort <= 5 &&
    session.effort === row.effort;
}

function hasValidSessionCategory(session: Record<string, unknown>, row: SnapshotSession): boolean {
  return typeof session.category === 'string' &&
    session.category === row.category &&
    isSessionCategory(session.category);
}

function matchesSnapshotIdentity(
  session: Record<string, unknown>,
  row: SnapshotSession
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

function hasValidOptionalFields(session: Record<string, unknown>): boolean {
  return isValidDescription(session.description) &&
    isValidDescription(session.notes) &&
    isValidDuration(session.duration) &&
    isValidDescription(session.videoUrl);
}

function isValidMarkdownSession(
  session: Record<string, unknown>,
  row: SnapshotSession
): session is Record<string, unknown> & MarkdownSession {
  return matchesSnapshotIdentity(session, row) &&
    hasValidTechniques(session) &&
    hasValidOptionalFields(session);
}

function markdownSession(row: SnapshotSession): MarkdownSession {
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

function validSessionDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toISOString().slice(0, 10) === value;
}

function sessionMarkdown(row: SnapshotSession): string {
  const session = markdownSession(row);
  const escapeMarkdown = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|~])/g, '\\$1');
  const escapeTechnique = (value: string) => escapeMarkdown(value.replace(/[\r\n\t]+/g, ' ').trim());
  const frontmatter = [
    `id: ${JSON.stringify(session.id)}`,
    `date: ${JSON.stringify(session.date)}`,
    `effort: ${session.effort}`,
    `category: ${JSON.stringify(session.category)}`,
    ...(session.duration !== undefined ? [`duration: ${session.duration}`] : []),
    ...(session.videoUrl ? [`videoUrl: ${JSON.stringify(session.videoUrl)}`] : []),
  ];
  const techniques = session.techniques.length
    ? session.techniques.map((technique) => `- ${escapeTechnique(technique)}`).join('\n')
    : '- (none recorded)';
  return `---\n${frontmatter.join('\n')}\n---\n\n# ${session.date} - Judo Session: ${session.category}\n\n## Techniques Practiced\n${techniques}\n\n## Session Description\n\n${escapeMarkdown(session.description ?? '')}\n\n## Notes\n\n${escapeMarkdown(session.notes ?? '')}\n`;
}

function sessionFilePath(session: SnapshotSession): string {
  const value = markdownSession(session);
  const compactDate = value.date.replaceAll('-', '');
  const [year, month] = value.date.split('-');
  return `data/${year}/${month}/${compactDate}-matmetrics-${value.id}.md`;
}

async function writeSessionMarkdown(
  token: string,
  owner: string,
  repository: string,
  path: string,
  markdown: string,
  commitMessage: string
): Promise<void> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  let sha: string | undefined;
  const existing = await githubFetch(url, token);
  if (existing.ok) {
    const value = await responseJson<{ sha: string }>(existing);
    sha = value.sha;
  } else if (existing.status !== 404) {
    throw new Error('GitHub backup lookup failed');
  }
  await responseJson(await githubFetch(url, token, 'PUT', {
    message: commitMessage,
    content: base64Utf8(markdown),
    ...(sha ? { sha } : {}),
  }));
}

export async function writeGitHubBackup(
  env: GitHubAppEnvironment,
  installation: GitHubInstallation,
  snapshotId: string,
  createdAt: string,
  sessions: SnapshotSession[]
): Promise<void> {
  const token = await scopedContentsToken(env, installation.installation_id, installation.repository_name);
  for (const session of sessions) {
    const path = sessionFilePath(session);
    await writeSessionMarkdown(
      token,
      installation.repository_owner,
      installation.repository_name,
      path,
      sessionMarkdown(session),
      `Keiko Dojo backup ${snapshotId} (${createdAt}): ${session.session_date}`
    );
  }
}

export type { GitHubInstallation, GitHubAppEnvironment };
