import { importPKCS8, SignJWT } from 'jose';
import { createPrivateKey } from 'node:crypto';
import { isSessionCategory } from '../domain/session';
import { isSafeSessionMarkdownPath } from '../domain/github-session-markdown';
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
    this.name = 'GitHubAppApiError';
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
  body?: unknown,
  cacheNamespace?: string
): Promise<Response> {
  const canRevalidate = method.toUpperCase() === 'GET' && cacheNamespace !== undefined;
  const cacheKey = canRevalidate ? JSON.stringify([cacheNamespace, url]) : undefined;
  let cached = cacheKey ? githubGetCache.get(cacheKey) : undefined;
  if (cached && Date.now() - cached.storedAt > GITHUB_GET_CACHE_TTL_MS) {
    removeGitHubGetCache(cacheKey!);
    cached = undefined;
  }
  const headers = new Headers({
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'Keiko-Dojo/0.1',
    'x-github-api-version': '2022-11-28',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  });
  if (cached) headers.set('if-none-match', cached.etag);
  const fetchOptions: RequestInit = {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  };
  let response = await fetch(url, fetchOptions);
  if (response.status === 304) {
    if (!cached) {
      headers.delete('if-none-match');
      response = await fetch(url, fetchOptions);
    } else {
      const mergedHeaders = new Headers(cached.headers);
      response.headers.forEach((value, name) => mergedHeaders.set(name, value));
      mergedHeaders.delete('content-length');
      mergedHeaders.delete('content-encoding');
      response = new Response(cached.body.slice(0), {
        status: cached.status,
        statusText: cached.statusText,
        headers: mergedHeaders,
      });
      cached.headers = [...mergedHeaders.entries()];
      cached.storedAt = Date.now();
      touchGitHubGetCache(cacheKey!, cached);
      return response;
    }
  }
  if (cacheKey) {
    const etag = response.headers.get('etag');
    if (response.ok && etag) {
      const entry: GitHubGetCacheEntry = {
        etag,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body: await response.clone().arrayBuffer(),
        storedAt: Date.now(),
      };
      touchGitHubGetCache(cacheKey, entry);
    } else {
      removeGitHubGetCache(cacheKey);
    }
  }
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

type GitHubGetCacheEntry = {
  etag: string;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer;
  storedAt: number;
};

const MAX_GITHUB_GET_CACHE_ENTRIES = 256;
const MAX_GITHUB_GET_CACHE_BYTES = 8 * 1024 * 1024;
const GITHUB_GET_CACHE_TTL_MS = 10 * 60_000;
const githubGetCache = new Map<string, GitHubGetCacheEntry>();
let githubGetCacheBytes = 0;

function removeGitHubGetCache(key: string): void {
  const entry = githubGetCache.get(key);
  if (!entry) return;
  githubGetCache.delete(key);
  githubGetCacheBytes -= entry.body.byteLength;
}

function touchGitHubGetCache(key: string, entry: GitHubGetCacheEntry): void {
  removeGitHubGetCache(key);
  if (entry.body.byteLength > MAX_GITHUB_GET_CACHE_BYTES) return;
  githubGetCacheBytes += entry.body.byteLength;
  githubGetCache.set(key, entry);
  while (githubGetCache.size > MAX_GITHUB_GET_CACHE_ENTRIES || githubGetCacheBytes > MAX_GITHUB_GET_CACHE_BYTES) {
    const oldest = githubGetCache.keys().next().value;
    if (oldest === undefined) break;
    removeGitHubGetCache(oldest);
  }
}

function githubCacheScope(installation: GitHubInstallation): string {
  return JSON.stringify([
    installation.user_id,
    installation.installation_id,
    installation.repository_id,
  ]);
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
  repositoryName: string,
  permission: 'read' | 'write' = 'write',
  userId = ''
): Promise<string> {
  const cacheKey = JSON.stringify([userId, installationId, repositoryName, permission]);
  const now = Date.now();
  const cached = installationTokenCache.get(cacheKey);
  if (cached?.token && cached.expiresAt && cached.expiresAt > now + TOKEN_REFRESH_MARGIN_MS) {
    touchInstallationTokenCache(cacheKey, cached);
    return cached.token;
  }
  if (cached?.pending) return cached.pending;

  const entry: InstallationTokenCacheEntry = {};
  const pending = (async () => {
    const jwt = await appJwt(env);
    const value = await responseJson<{ token: string; expires_at?: string }>(await githubFetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      jwt,
      'POST',
      { repositories: [repositoryName], permissions: { contents: permission } }
    ));
    const expiresAt = value.expires_at ? Date.parse(value.expires_at) : NaN;
    if (Number.isFinite(expiresAt) && expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
      entry.token = value.token;
      entry.expiresAt = expiresAt;
      entry.pending = undefined;
      touchInstallationTokenCache(cacheKey, entry);
    } else {
      installationTokenCache.delete(cacheKey);
    }
    return value.token;
  })();
  entry.pending = pending;
  touchInstallationTokenCache(cacheKey, entry);
  try {
    return await pending;
  } catch (error) {
    if (installationTokenCache.get(cacheKey) === entry) installationTokenCache.delete(cacheKey);
    throw error;
  }
}

type InstallationTokenCacheEntry = {
  token?: string;
  expiresAt?: number;
  pending?: Promise<string>;
};

const MAX_INSTALLATION_TOKEN_CACHE_ENTRIES = 100;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const installationTokenCache = new Map<string, InstallationTokenCacheEntry>();

function touchInstallationTokenCache(key: string, entry: InstallationTokenCacheEntry): void {
  installationTokenCache.delete(key);
  installationTokenCache.set(key, entry);
  while (installationTokenCache.size > MAX_INSTALLATION_TOKEN_CACHE_ENTRIES) {
    const oldest = installationTokenCache.keys().next().value;
    if (oldest === undefined) break;
    installationTokenCache.delete(oldest);
  }
}

function repositoryUrl(installation: GitHubInstallation, suffix: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(installation.repository_owner)}/${encodeURIComponent(installation.repository_name)}${suffix}`;
}

async function limitedResponseJson<T>(response: Response, maxBytes: number): Promise<T> {
  if (!response.ok) return responseJson<T>(response);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('GitHub response exceeds the supported size');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error('GitHub response exceeds the supported size');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('GitHub returned an invalid response');
  }
}

async function selectedRepositoryInfo(
  token: string,
  installation: GitHubInstallation
): Promise<{ defaultBranch: string; response: Response }> {
  const response = await githubFetch(
    repositoryUrl(installation, ''), token, 'GET', undefined, githubCacheScope(installation)
  );
  const repository = await limitedResponseJson<{ default_branch?: unknown }>(response, 256 * 1024);
  if (typeof repository.default_branch !== 'string' || !repository.default_branch.trim()) {
    throw new Error('GitHub repository does not expose a default branch');
  }
  return { defaultBranch: repository.default_branch, response };
}

async function resolveSelectedBranch(
  token: string,
  installation: GitHubInstallation,
  requestedBranch?: string
): Promise<{ branch: string; headSha: string; rateLimit: { limit?: number; remaining?: number; resetAt?: string } }> {
  const repository = await selectedRepositoryInfo(token, installation);
  const branch = requestedBranch?.trim() || repository.defaultBranch;
  if (!branch || branch.length > 255 || /[\u0000-\u001f\u007f]/.test(branch)) {
    throw new Error('GitHub branch is invalid');
  }
  const ref = await limitedResponseJson<{ object?: { sha?: unknown } }>(
    await githubFetch(
      repositoryUrl(installation, `/git/ref/heads/${encodeURIComponent(branch)}`),
      token,
      'GET',
      undefined,
      githubCacheScope(installation)
    ),
    128 * 1024
  );
  if (typeof ref.object?.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(ref.object.sha)) {
    throw new Error('GitHub branch could not be resolved');
  }
  const limit = Number(repository.response.headers.get('x-ratelimit-limit'));
  const remaining = Number(repository.response.headers.get('x-ratelimit-remaining'));
  const resetSeconds = Number(repository.response.headers.get('x-ratelimit-reset'));
  return {
    branch,
    headSha: ref.object.sha,
    rateLimit: {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(remaining) ? { remaining } : {}),
      ...(Number.isFinite(resetSeconds) ? { resetAt: new Date(resetSeconds * 1000).toISOString() } : {}),
    },
  };
}

export async function checkSelectedGitHubRepository(
  env: GitHubAppEnvironment,
  installation: GitHubInstallation,
  requestedBranch?: string
): Promise<{
  success: true;
  message: string;
  branch: string;
  checkedAt: string;
  rateLimit?: { limit: number; remaining: number; resetAt?: string };
}> {
  const token = await scopedContentsToken(
    env, installation.installation_id, installation.repository_name, 'read', installation.user_id
  );
  const resolved = await resolveSelectedBranch(token, installation, requestedBranch);
  const rateLimit = resolved.rateLimit.limit !== undefined && resolved.rateLimit.remaining !== undefined
    ? {
        limit: resolved.rateLimit.limit,
        remaining: resolved.rateLimit.remaining,
        ...(resolved.rateLimit.resetAt ? { resetAt: resolved.rateLimit.resetAt } : {}),
      }
    : undefined;
  return {
    success: true,
    message: `Successfully connected to ${installation.repository_owner}/${installation.repository_name} on branch ${resolved.branch}`,
    branch: resolved.branch,
    checkedAt: new Date().toISOString(),
    ...(rateLimit ? { rateLimit } : {}),
  };
}

export type GitHubSessionMarkdownFile = { path: string; sha: string; content: string };

const MAX_GITHUB_SESSION_FILES = 500;
const MAX_GITHUB_MARKDOWN_BYTES = 1024 * 1024;
const MAX_GITHUB_SESSION_SCAN_BYTES = 16 * 1024 * 1024;

export async function listSelectedGitHubSessionMarkdown(
  env: GitHubAppEnvironment,
  installation: GitHubInstallation,
  requestedBranch?: string
): Promise<{ branch: string; files: GitHubSessionMarkdownFile[] }> {
  const token = await scopedContentsToken(
    env, installation.installation_id, installation.repository_name, 'read', installation.user_id
  );
  const resolved = await resolveSelectedBranch(token, installation, requestedBranch);
  const tree = await limitedResponseJson<{
    truncated?: unknown;
    tree?: Array<{ path?: unknown; type?: unknown; sha?: unknown }>;
  }>(
    await githubFetch(
      repositoryUrl(installation, `/git/trees/${encodeURIComponent(resolved.headSha)}?recursive=1`),
      token, 'GET', undefined, githubCacheScope(installation)
    ),
    4 * 1024 * 1024
  );
  if (tree.truncated === true || !Array.isArray(tree.tree)) {
    throw new Error('GitHub session file listing exceeds the supported size');
  }
  const paths = tree.tree
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string' &&
      /^data\/\d{4}\/\d{2}\/\d{8}-matmetrics-[A-Za-z0-9_-]{1,100}\.md$/.test(entry.path))
    .map((entry) => ({ path: entry.path as string, sha: typeof entry.sha === 'string' ? entry.sha : '' }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (paths.length > MAX_GITHUB_SESSION_FILES) {
    throw new Error('GitHub repository has too many session files to scan');
  }

  const files: GitHubSessionMarkdownFile[] = [];
  let totalBytes = 0;
  for (const entry of paths) {
    const query = new URLSearchParams({ ref: resolved.branch });
    const path = entry.path.split('/').map(encodeURIComponent).join('/');
    const content = await limitedResponseJson<{
      sha?: unknown;
      encoding?: unknown;
      content?: unknown;
      size?: unknown;
    }>(
      await githubFetch(
        repositoryUrl(installation, `/contents/${path}?${query}`),
        token, 'GET', undefined, githubCacheScope(installation)
      ),
      MAX_GITHUB_MARKDOWN_BYTES * 2
    );
    if (content.encoding !== 'base64' || typeof content.content !== 'string') {
      throw new Error('GitHub session file has an unsupported encoding');
    }
    const decoded = decodeBase64Utf8(content.content);
    const byteLength = new TextEncoder().encode(decoded).byteLength;
    if (byteLength > MAX_GITHUB_MARKDOWN_BYTES) {
      throw new Error('GitHub session file exceeds the supported size');
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_GITHUB_SESSION_SCAN_BYTES) {
      throw new Error('GitHub session data exceeds the supported scan size');
    }
    files.push({ path: entry.path, sha: typeof content.sha === 'string' ? content.sha : entry.sha, content: decoded });
  }
  return { branch: resolved.branch, files };
}

export async function updateSelectedGitHubMarkdown(
  env: GitHubAppEnvironment,
  installation: GitHubInstallation,
  branch: string,
  file: GitHubSessionMarkdownFile,
  updatedContent: string,
  originalContent: string
): Promise<string> {
  if (!isSafeSessionMarkdownPath(file.path) || branch.length > 255 || /[\u0000-\u001f\u007f]/.test(branch)) {
    throw new Error('GitHub session file update is invalid');
  }
  if (new TextEncoder().encode(updatedContent).byteLength > MAX_GITHUB_MARKDOWN_BYTES) {
    throw new Error('GitHub session file exceeds the supported size');
  }
  const token = await scopedContentsToken(
    env, installation.installation_id, installation.repository_name, 'write', installation.user_id
  );
  const path = file.path.split('/').map(encodeURIComponent).join('/');
  const url = repositoryUrl(installation, `/contents/${path}`);
  const body = {
    message: 'log-doctor: normalize session markdown',
    content: base64Utf8(updatedContent),
    branch,
    sha: file.sha,
  };
  try {
    const response = await githubFetch(url, token, 'PUT', body);
    const result = await limitedResponseJson<{ commit?: { sha?: unknown } }>(response, 256 * 1024);
    return typeof result.commit?.sha === 'string' ? result.commit.sha : '';
  } catch (error) {
    if (!(error instanceof GitHubAppApiError) || (error.status !== 409 && error.status !== 422)) throw error;
    const query = new URLSearchParams({ ref: branch });
    const current = await limitedResponseJson<{ sha?: unknown; encoding?: unknown; content?: unknown }>(
      await githubFetch(
        `${url}?${query}`, token, 'GET', undefined, githubCacheScope(installation)
      ), MAX_GITHUB_MARKDOWN_BYTES * 2
    );
    const latest = current.encoding === 'base64' && typeof current.content === 'string'
      ? decodeBase64Utf8(current.content)
      : '';
    if (latest !== originalContent || typeof current.sha !== 'string') {
      throw new Error('revision conflict: file changed after Log Doctor generated the fix; preview again before applying');
    }
    const retry = await limitedResponseJson<{ commit?: { sha?: unknown } }>(
      await githubFetch(url, token, 'PUT', { ...body, sha: current.sha }),
      256 * 1024
    );
    return typeof retry.commit?.sha === 'string' ? retry.commit.sha : '';
  }
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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

export type GitHubSessionRow = {
  id: string;
  session_date: string;
  category: string;
  effort: number;
  payload: string;
  revision: number;
  updated_at: string;
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
    validSessionDate(session.date);
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

function hasValidOptionalFields(session: Record<string, unknown>): boolean {
  return isValidDescription(session.description) &&
    isValidDescription(session.notes) &&
    isValidDuration(session.duration) &&
    isValidDescription(session.videoUrl);
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

function validSessionDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toISOString().slice(0, 10) === value;
}

function sessionMarkdown(session: MarkdownSession): string {
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
  const textPayload = JSON.stringify({
    techniques: session.techniques,
    ...(session.description !== undefined ? { description: session.description } : {}),
    ...(session.notes !== undefined ? { notes: session.notes } : {}),
  });
  frontmatter.push(
    'keikoBackupVersion: 1',
    `keikoTextPayload: ${JSON.stringify(textPayload)}`
  );
  return `---\n${frontmatter.join('\n')}\n---\n\n# ${session.date} - Judo Session: ${session.category}\n\n## Techniques Practiced\n${techniques}\n\n## Session Description\n\n${escapeMarkdown(session.description ?? '')}\n\n## Notes\n\n${escapeMarkdown(session.notes ?? '')}\n`;
}

export function githubSessionMarkdownPath(session: Pick<MarkdownSession, 'id' | 'date'>): string {
  const compactDate = session.date.replaceAll('-', '');
  const [year, month] = session.date.split('-');
  return `data/${year}/${month}/${compactDate}-matmetrics-${session.id}.md`;
}

export function githubSessionMarkdownPathForRow(row: GitHubSessionRow): string {
  return githubSessionMarkdownPath(markdownSession(row));
}

async function writeSessionMarkdown(
  token: string,
  owner: string,
  repository: string,
  path: string,
  markdown: string,
  commitMessage: string,
  cacheNamespace: string
): Promise<void> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  let sha: string | undefined;
  const existing = await githubFetch(url, token, 'GET', undefined, cacheNamespace);
  if (existing.ok) {
    const value = await responseJson<{ sha: string; content?: string; encoding?: string }>(existing);
    sha = value.sha;
    if (value.encoding === 'base64' && typeof value.content === 'string') {
      try {
        if (decodeBase64Utf8(value.content) === markdown) return;
      } catch {
        // A malformed Contents response should not block repairing the file.
      }
    }
  } else if (existing.status !== 404) {
    await responseJson(existing);
  }
  await responseJson(await githubFetch(url, token, 'PUT', {
    message: commitMessage,
    content: base64Utf8(markdown),
    ...(sha ? { sha } : {}),
  }));
}

async function deleteSessionMarkdown(
  token: string,
  owner: string,
  repository: string,
  path: string,
  commitMessage: string,
  cacheNamespace: string
): Promise<void> {
  if (!isSafeSessionMarkdownPath(path)) throw new Error('GitHub session path is invalid');
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const existing = await githubFetch(url, token, 'GET', undefined, cacheNamespace);
  if (existing.status === 404) return;
  const file = await responseJson<{ sha?: unknown }>(existing);
  if (typeof file.sha !== 'string') throw new Error('GitHub session file revision is missing');
  await responseJson(await githubFetch(url, token, 'DELETE', {
    message: commitMessage,
    sha: file.sha,
  }));
}

export function isKeikoSessionMarkdownPath(path: string): boolean {
  return isSafeSessionMarkdownPath(path) &&
    /^data\/\d{4}\/(0[1-9]|1[0-2])\/\d{8}-matmetrics-[A-Za-z0-9_-]{1,100}\.md$/.test(path);
}

export async function syncGitHubSessionMarkdown(
  env: GitHubAppEnvironment,
  installation: GitHubInstallation,
  sessions: GitHubSessionRow[],
  deletePaths: string[] = []
): Promise<Array<{ id: string; path: string; revision: number }>> {
  const files = sessions.map((row) => {
    const session = markdownSession(row);
    return {
      id: session.id,
      revision: row.revision,
      path: githubSessionMarkdownPath(session),
      markdown: sessionMarkdown(session),
      sessionDate: row.session_date,
    };
  });
  const currentPaths = new Set(files.map((file) => file.path));
  const stalePaths = [...new Set(deletePaths)].filter((path) =>
    isKeikoSessionMarkdownPath(path) && !currentPaths.has(path)
  );

  let phase = 'installation_token_request';
  try {
    const token = await scopedContentsToken(
      env, installation.installation_id, installation.repository_name, 'write', installation.user_id
    );
    phase = 'session_contents';
    for (const file of files) {
      await writeSessionMarkdown(
        token,
        installation.repository_owner,
        installation.repository_name,
        file.path,
        file.markdown,
        `Keiko Dojo backup session (${file.sessionDate}): ${file.id}`,
        githubCacheScope(installation)
      );
    }
    phase = 'session_deletions';
    for (const path of stalePaths) {
      await deleteSessionMarkdown(
        token,
        installation.repository_owner,
        installation.repository_name,
        path,
        'Keiko Dojo backup remove deleted session',
        githubCacheScope(installation)
      );
    }
    return files.map(({ id, path, revision }) => ({ id, path, revision }));
  } catch (error) {
    const details = safeTransportDetails(error);
    console.error('github_session_sync_failed', {
      phase,
      causeName: error instanceof Error ? error.name : null,
      causeCode: details.causeCode ?? null,
      status: error instanceof GitHubAppApiError ? error.status : null,
      reason: details.reason,
      apiErrorCategory: error instanceof GitHubAppApiError ? error.category : null,
    });
    throw error;
  }
}

export type { GitHubInstallation, GitHubAppEnvironment };
