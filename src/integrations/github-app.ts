import { importPKCS8, SignJWT } from 'jose';
import { createPrivateKey } from 'node:crypto';
import type { GitHubInstallation as GitHubInstallationRow } from '../domain/github-installation';
import { isSafeSessionMarkdownPath } from '../domain/github-session-markdown';
import {
  buildGitHubSessionBackupFile,
  isKeikoSessionMarkdownPath,
  type GitHubSessionRow,
} from './github-session-backup';
export { githubSessionMarkdownPathForRow, isKeikoSessionMarkdownPath } from './github-session-backup';
export type { GitHubSessionRow } from './github-session-backup';
import { configuredGitHubAppId } from './github-app-config';

type GitHubAppEnvironment = Env & {
  GITHUB_APP_PRIVATE_KEY?: string;
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
    reason: transportFailureReason(message),
  };
}

function transportFailureReason(
  message: string
): 'redirect_rejected' | 'cache_option' | 'network_error' | 'invalid_url' | 'other' {
  if (message.includes('redirect')) return 'redirect_rejected';
  if (message.includes('cache')) return 'cache_option';
  if (message.includes('network') || message.includes('fetch failed') || message.includes('failed to fetch')) {
    return 'network_error';
  }
  if (message.includes('url')) return 'invalid_url';
  return 'other';
}

type GitHubSyncDiagnosticOperation =
  | 'installation_token'
  | 'contents_get'
  | 'contents_put'
  | 'contents_delete';

type GitHubSyncDiagnostics = {
  operation: GitHubSyncDiagnosticOperation;
  githubRequestId: string | null;
  responseStatus: number | null;
};

function beginGitHubSyncRequest(
  diagnostics: GitHubSyncDiagnostics | undefined,
  operation: GitHubSyncDiagnosticOperation
): void {
  if (!diagnostics) return;
  diagnostics.operation = operation;
  diagnostics.githubRequestId = null;
  diagnostics.responseStatus = null;
}

function recordGitHubSyncResponse(
  diagnostics: GitHubSyncDiagnostics | undefined,
  response: Response
): void {
  if (!diagnostics) return;
  const requestId = response.headers.get('x-github-request-id');
  diagnostics.githubRequestId = requestId && /^[A-Za-z0-9:-]{1,128}$/.test(requestId)
    ? requestId
    : null;
  diagnostics.responseStatus = response.status;
}

function safeErrorSummary(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  // JSON parser messages may include response snippets, so never log them verbatim.
  if (error instanceof SyntaxError) return 'invalid_response_json';

  const raw = error.message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+\b/gi, '[token]')
    .replace(/\b(token|secret|private[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/([?&][A-Za-z0-9_.-]+)=([^&\s]+)/g, '$1=[redacted]')
    .replace(/data\/\d{4}\/\d{2}\/\d{8}-matmetrics-[A-Za-z0-9_-]{1,100}\.md/gi, '[session-path]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[identifier]')
    .replace(/\s+/g, ' ')
    .trim();
  const summary = raw.slice(0, 160);
  return summary || null;
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

function freshGitHubGetCacheEntry(cacheKey: string | undefined): GitHubGetCacheEntry | undefined {
  if (!cacheKey) return undefined;
  const cached = githubGetCache.get(cacheKey);
  if (!cached || Date.now() - cached.storedAt <= GITHUB_GET_CACHE_TTL_MS) return cached;
  removeGitHubGetCache(cacheKey);
  return undefined;
}

function responseFromCachedEntry(response: Response, cached: GitHubGetCacheEntry): Response {
  const mergedHeaders = new Headers(cached.headers);
  response.headers.forEach((value, name) => mergedHeaders.set(name, value));
  mergedHeaders.delete('content-length');
  mergedHeaders.delete('content-encoding');
  return new Response(cached.body.slice(0), {
    status: cached.status,
    statusText: cached.statusText,
    headers: mergedHeaders,
  });
}

async function revalidateGitHubGetResponse(
  response: Response,
  url: string,
  options: RequestInit,
  headers: Headers,
  cacheKey: string | undefined,
  cached: GitHubGetCacheEntry | undefined
): Promise<{ response: Response; reusedCache: boolean }> {
  if (response.status !== 304) return { response, reusedCache: false };
  if (!cacheKey || !cached) {
    headers.delete('if-none-match');
    return { response: await fetch(url, options), reusedCache: false };
  }
  const restored = responseFromCachedEntry(response, cached);
  cached.headers = [...restored.headers.entries()];
  cached.storedAt = Date.now();
  touchGitHubGetCache(cacheKey, cached);
  return { response: restored, reusedCache: true };
}

async function rememberGitHubGetResponse(
  cacheKey: string | undefined,
  response: Response
): Promise<void> {
  if (!cacheKey) return;
  const etag = response.headers.get('etag');
  if (!response.ok || !etag) {
    removeGitHubGetCache(cacheKey);
    return;
  }
  touchGitHubGetCache(cacheKey, {
    etag,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: await response.clone().arrayBuffer(),
    storedAt: Date.now(),
  });
}

function rejectGitHubRedirect(response: Response, url: string): void {
  if (![301, 302, 303, 307, 308].includes(response.status)) return;
  const target = new URL(response.headers.get('location') ?? url, url);
  throw new GitHubRedirectError(response.status, target.origin, target.pathname);
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
  const cached = freshGitHubGetCacheEntry(cacheKey);
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
  const firstResponse = await fetch(url, fetchOptions);
  const revalidated = await revalidateGitHubGetResponse(
    firstResponse, url, fetchOptions, headers, cacheKey, cached
  );
  if (!revalidated.reusedCache) await rememberGitHubGetResponse(cacheKey, revalidated.response);
  rejectGitHubRedirect(revalidated.response, url);
  return revalidated.response;
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

function githubCacheScope(installation: GitHubInstallationRow): string {
  return JSON.stringify([
    installation.user_id,
    installation.installation_id,
    installation.repository_id,
  ]);
}

async function githubErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.clone().json();
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      return body.message.trim().toLowerCase();
    }
  } catch {
    // The status remains useful when GitHub does not return a JSON error.
  }
  return '';
}

function classifyGitHubApiError(status: number, message: string): string {
  if (message === 'bad credentials') return 'bad_credentials';
  if (message.includes('not accessible by integration')) return 'integration_access_denied';
  if (message.includes('not found')) return 'not_found';
  if (message.includes('rate limit')) return 'rate_limited';
  if (message.includes('requires authentication')) return 'authentication_required';
  if (message.includes('validation failed')) return 'validation_failed';
  if (message.includes('forbidden') || status === 403) return 'forbidden';
  return 'other';
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = await githubErrorMessage(response);
    throw new GitHubAppApiError(response.status, classifyGitHubApiError(response.status, message));
  }
  return response.json() as Promise<T>;
}

function hasSelectedRepositoryAccess(
  installation: { id: number; repository_selection: string },
  installationId: number
): boolean {
  return installation.id === installationId && installation.repository_selection === 'selected';
}

function hasOneSelectedRepository(page: {
  total_count: number;
  repositories: Array<{ id: number; name: string; full_name: string; owner: { login: string } }>;
}): boolean {
  return page.total_count === 1 && Array.isArray(page.repositories) && page.repositories.length === 1;
}

function isValidSelectedRepository(repository: {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
}): boolean {
  return Number.isSafeInteger(repository.id) &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(repository.name) &&
    /^[A-Za-z0-9_-]{1,100}$/.test(repository.owner.login);
}

type VerificationPhaseSetter = (phase: string) => void;

async function readSelectedInstallationToken(
  jwt: string,
  installationId: number,
  setPhase: VerificationPhaseSetter
): Promise<string> {
  setPhase('installation_lookup_request');
  const installationResponse = await githubFetch(
    `https://api.github.com/app/installations/${installationId}`,
    jwt
  );
  setPhase('installation_lookup_response');
  const installation = await responseJson<{
    id: number;
    repository_selection: string;
  }>(installationResponse);
  if (!hasSelectedRepositoryAccess(installation, installationId)) {
    setPhase('installation_scope');
    throw new Error('GitHub App must be installed with selected repository access');
  }

  setPhase('installation_token_request');
  const tokenResponse = await githubFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    jwt,
    'POST',
    { permissions: { contents: 'read' } }
  );
  setPhase('installation_token_response');
  const readToken = await responseJson<{ token: string }>(tokenResponse);
  return readToken.token;
}

async function readSingleSelectedRepository(
  readToken: string,
  setPhase: VerificationPhaseSetter
): Promise<{ id: number; name: string; full_name: string; owner: { login: string } }> {
  setPhase('repository_list_request');
  const repositoryResponse = await githubFetch(
    'https://api.github.com/installation/repositories?per_page=100',
    readToken
  );
  setPhase('repository_list_response');
  const repositoryPage = await responseJson<{
    total_count: number;
    repositories: Array<{ id: number; name: string; full_name: string; owner: { login: string } }>;
  }>(repositoryResponse);
  if (!hasOneSelectedRepository(repositoryPage)) {
    setPhase('repository_scope');
    throw new Error('GitHub App installation must be limited to one repository');
  }
  const repository = repositoryPage.repositories[0]!;
  if (!isValidSelectedRepository(repository)) {
    setPhase('repository_validation');
    throw new Error('GitHub returned an invalid repository');
  }
  return repository;
}

function installationVerificationError(error: unknown, phase: string): GitHubInstallationVerificationError {
  const details = safeTransportDetails(error);
  return new GitHubInstallationVerificationError(
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

export async function verifySelectedRepositoryInstallation(
  env: GitHubAppEnvironment,
  installationId: number
): Promise<Pick<GitHubInstallationRow, 'installation_id' | 'repository_owner' | 'repository_name' | 'repository_id'>> {
  let phase = 'app_jwt';
  const setPhase: VerificationPhaseSetter = (nextPhase) => { phase = nextPhase; };
  try {
    const jwt = await appJwt(env);
    const readToken = await readSelectedInstallationToken(jwt, installationId, setPhase);
    const repository = await readSingleSelectedRepository(readToken, setPhase);
    return {
      installation_id: installationId,
      repository_owner: repository.owner.login,
      repository_name: repository.name,
      repository_id: repository.id,
    };
  } catch (error) {
    if (error instanceof GitHubInstallationVerificationError) throw error;
    throw installationVerificationError(error, phase);
  }
}

async function scopedContentsToken(
  env: GitHubAppEnvironment,
  installationId: number,
  repositoryName: string,
  permission: 'read' | 'write' = 'write',
  userId = '',
  diagnostics?: GitHubSyncDiagnostics
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
    beginGitHubSyncRequest(diagnostics, 'installation_token');
    const response = await githubFetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      jwt,
      'POST',
      { repositories: [repositoryName], permissions: { contents: permission } }
    );
    recordGitHubSyncResponse(diagnostics, response);
    const value = await responseJson<{ token: string; expires_at?: string }>(response);
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

function repositoryUrl(installation: GitHubInstallationRow, suffix: string): string {
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
  installation: GitHubInstallationRow
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
  installation: GitHubInstallationRow,
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
  installation: GitHubInstallationRow,
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
export type GitHubSessionMarkdownPath = { path: string; sha: string };

const MAX_GITHUB_SESSION_FILES = 500;
const MAX_GITHUB_MARKDOWN_BYTES = 1024 * 1024;
const MAX_GITHUB_SESSION_SCAN_BYTES = 16 * 1024 * 1024;

async function selectedGitHubSessionMarkdownPaths(
  env: GitHubAppEnvironment,
  installation: GitHubInstallationRow,
  requestedBranch?: string
): Promise<{ token: string; branch: string; treeSha: string; files: GitHubSessionMarkdownPath[] }> {
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

  return { token, branch: resolved.branch, treeSha: resolved.headSha, files: paths };
}

export async function listSelectedGitHubSessionMarkdownPaths(
  env: GitHubAppEnvironment,
  installation: GitHubInstallationRow,
  requestedBranch?: string
): Promise<{ branch: string; treeSha: string; files: GitHubSessionMarkdownPath[] }> {
  const { branch, treeSha, files } = await selectedGitHubSessionMarkdownPaths(env, installation, requestedBranch);
  return { branch, treeSha, files };
}

export async function listSelectedGitHubSessionMarkdown(
  env: GitHubAppEnvironment,
  installation: GitHubInstallationRow,
  requestedBranch?: string
): Promise<{ branch: string; files: GitHubSessionMarkdownFile[] }> {
  const { token, branch, files: paths } = await selectedGitHubSessionMarkdownPaths(
    env, installation, requestedBranch
  );

  const files: GitHubSessionMarkdownFile[] = [];
  let totalBytes = 0;
  for (const entry of paths) {
    const query = new URLSearchParams({ ref: branch });
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
  return { branch, files };
}

type GitHubMarkdownUpdateBody = {
  message: string;
  content: string;
  branch: string;
  sha: string;
};

function isRetryableGitHubContentConflict(error: unknown): error is GitHubAppApiError {
  return error instanceof GitHubAppApiError && (error.status === 409 || error.status === 422);
}

async function retryGitHubMarkdownUpdate(
  url: string,
  token: string,
  installation: GitHubInstallationRow,
  branch: string,
  originalContent: string,
  body: GitHubMarkdownUpdateBody
): Promise<string> {
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

export async function updateSelectedGitHubMarkdown(
  env: GitHubAppEnvironment,
  installation: GitHubInstallationRow,
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
    if (!isRetryableGitHubContentConflict(error)) throw error;
    return retryGitHubMarkdownUpdate(url, token, installation, branch, originalContent, body);
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

async function writeSessionMarkdown(
  token: string,
  owner: string,
  repository: string,
  path: string,
  markdown: string,
  commitMessage: string,
  cacheNamespace: string,
  diagnostics: GitHubSyncDiagnostics
): Promise<void> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  let sha: string | undefined;
  beginGitHubSyncRequest(diagnostics, 'contents_get');
  const existing = await githubFetch(url, token, 'GET', undefined, cacheNamespace);
  recordGitHubSyncResponse(diagnostics, existing);
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
  beginGitHubSyncRequest(diagnostics, 'contents_put');
  const response = await githubFetch(url, token, 'PUT', {
    message: commitMessage,
    content: base64Utf8(markdown),
    ...(sha ? { sha } : {}),
  });
  recordGitHubSyncResponse(diagnostics, response);
  await responseJson(response);
}

async function deleteSessionMarkdown(
  token: string,
  owner: string,
  repository: string,
  path: string,
  commitMessage: string,
  cacheNamespace: string,
  diagnostics: GitHubSyncDiagnostics,
  knownSha?: string
): Promise<void> {
  if (!isSafeSessionMarkdownPath(path)) throw new Error('GitHub session path is invalid');
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  let sha = knownSha;
  if (!sha) {
    beginGitHubSyncRequest(diagnostics, 'contents_get');
    const existing = await githubFetch(url, token, 'GET', undefined, cacheNamespace);
    recordGitHubSyncResponse(diagnostics, existing);
    if (existing.status === 404) return;
    const file = await responseJson<{ sha?: unknown }>(existing);
    if (typeof file.sha !== 'string') throw new Error('GitHub session file revision is missing');
    sha = file.sha;
  }
  beginGitHubSyncRequest(diagnostics, 'contents_delete');
  const response = await githubFetch(url, token, 'DELETE', {
    message: commitMessage,
    sha,
  });
  recordGitHubSyncResponse(diagnostics, response);
  await responseJson(response);
}

export async function syncGitHubSessionMarkdown(
  env: GitHubAppEnvironment,
  installation: GitHubInstallationRow,
  sessions: GitHubSessionRow[],
  deletePaths: string[] = [],
  deleteFileShas: ReadonlyMap<string, string> = new Map()
): Promise<Array<{ id: string; path: string; revision: number }>> {
  const files = sessions.map(buildGitHubSessionBackupFile);
  const currentPaths = new Set(files.map((file) => file.path));
  const stalePaths = [...new Set(deletePaths)].filter((path) =>
    isKeikoSessionMarkdownPath(path) && !currentPaths.has(path)
  );
  if (files.length === 0 && stalePaths.length === 0) return [];

  let phase = 'installation_token_request';
  const diagnostics: GitHubSyncDiagnostics = {
    operation: 'installation_token',
    githubRequestId: null,
    responseStatus: null,
  };
  try {
    const token = await scopedContentsToken(
      env, installation.installation_id, installation.repository_name, 'write', installation.user_id,
      diagnostics
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
        githubCacheScope(installation),
        diagnostics
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
        githubCacheScope(installation),
        diagnostics,
        deleteFileShas.get(path)
      );
    }
    return files.map(({ id, path, revision }) => ({ id, path, revision }));
  } catch (error) {
    const details = safeTransportDetails(error);
    console.error('github_session_sync_failed', {
      phase,
      operation: diagnostics.operation,
      githubRequestId: diagnostics.githubRequestId,
      responseStatus: diagnostics.responseStatus,
      causeName: error instanceof Error ? error.name : null,
      causeCode: details.causeCode ?? null,
      status: error instanceof GitHubAppApiError ? error.status : null,
      reason: details.reason,
      apiErrorCategory: error instanceof GitHubAppApiError ? error.category : null,
      errorSummary: safeErrorSummary(error),
    });
    throw error;
  }
}

export type { GitHubAppEnvironment };
