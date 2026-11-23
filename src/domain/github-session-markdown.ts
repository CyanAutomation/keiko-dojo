import { isSessionCategory, isValidSessionDate, type SessionCategory } from './session';
import { validateSafeHttpUrl } from './network-safety';

export type GitHubMarkdownSession = {
  id: string;
  date: string;
  effort: number;
  category: SessionCategory;
  techniques: string[];
  description?: string;
  notes?: string;
  duration?: number;
  videoUrl?: string;
};

export type MarkdownParseResult =
  | { ok: true; session: GitHubMarkdownSession }
  | { ok: false; errors: string[]; id?: string; date?: string };

type Frontmatter = Map<string, string | number>;
type MarkdownDocument = { frontmatter: Frontmatter; body: string };
type SessionMarkdownFrontmatterInput = {
  id: string;
  date: string;
  effort: number;
  category: string;
  duration?: number;
  videoUrl?: string;
};
type KeikoTextPayload = {
  techniques: string[];
  description?: string;
  notes?: string;
};

const REQUIRED_SECTIONS = [
  'Techniques Practiced',
  'Session Description',
  'Notes',
] as const;
const KNOWN_FRONTMATTER = new Set([
  'id', 'date', 'effort', 'category', 'duration', 'videoUrl',
  'keikoBackupVersion', 'keikoTextPayload',
]);

function validateMarkdownVideoUrl(value: string): void {
  const validation = validateSafeHttpUrl(value);
  if (validation.ok) return;
  if (validation.reason === 'invalid') {
    throw new Error('invalid videoUrl: expected an absolute URL');
  }
  if (validation.reason === 'protocol') {
    throw new Error('invalid videoUrl: protocol must be http or https');
  }
  if (validation.reason === 'credentials') {
    throw new Error('invalid videoUrl: credentials are not allowed');
  }
  throw new Error('videoUrl must not point to a private or internal network host');
}

function parseScalar(raw: string): string | number {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'string') throw new Error('expected a string');
    return parsed;
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  throw new Error(`unsupported frontmatter value: ${value}`);
}

function splitDocument(markdown: string): MarkdownDocument {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error('markdown is missing YAML frontmatter');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('markdown frontmatter terminator not found');
  const frontmatter = new Map<string, string | number>();
  for (const line of normalized.slice(4, end).split('\n')) {
    const value = line.trim();
    if (!value) continue;
    const separator = value.indexOf(':');
    if (separator <= 0) throw new Error(`invalid frontmatter line "${value}"`);
    const key = value.slice(0, separator).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || frontmatter.has(key)) {
      throw new Error(`invalid frontmatter key "${key}"`);
    }
    try {
      frontmatter.set(key, parseScalar(value.slice(separator + 1)));
    } catch {
      throw new Error(`invalid frontmatter value for "${key}"`);
    }
  }
  return { frontmatter, body: normalized.slice(end + 5) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKeikoTextPayload(value: unknown): value is KeikoTextPayload {
  return isRecord(value) &&
    Array.isArray(value.techniques) &&
    value.techniques.every((technique) => typeof technique === 'string') &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.notes === undefined || typeof value.notes === 'string');
}

function parseKeikoTextPayload(raw: string): KeikoTextPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Invalid Keiko backup text payload');
  }
  if (!isKeikoTextPayload(value)) throw new Error('Invalid Keiko backup text payload');
  return {
    techniques: value.techniques,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.notes === undefined ? {} : { notes: value.notes }),
  };
}

function recoverTextPayload(frontmatter: Frontmatter): KeikoTextPayload | undefined {
  const version = frontmatter.get('keikoBackupVersion');
  const raw = frontmatter.get('keikoTextPayload');
  if (version === undefined) {
    if (frontmatter.has('keikoTextPayload')) throw new Error('Invalid Keiko backup text payload');
    return undefined;
  }
  if (version !== 1 || typeof raw !== 'string') {
    throw new Error('Invalid Keiko backup text payload');
  }
  return parseKeikoTextPayload(raw);
}

type FenceState = { marker: '`' | '~'; length: number };

function fenceAtLine(line: string): FenceState | undefined {
  const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  const delimiter = match[1]!;
  const marker = delimiter[0] as FenceState['marker'];
  const info = match[2]!;
  if (marker === '`' && info.includes('`')) return undefined;
  return { marker, length: delimiter.length };
}

function advanceFence(line: string, current: FenceState | undefined): FenceState | undefined {
  const candidate = fenceAtLine(line);
  if (!current) return candidate;
  if (!candidate || candidate.marker !== current.marker || candidate.length < current.length) {
    return current;
  }
  const suffix = line.trimStart().slice(candidate.length);
  return suffix.trim() === '' ? undefined : current;
}

function sectionBody(body: string, heading: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let fence: FenceState | undefined;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const wasInFence = fence !== undefined;
    fence = advanceFence(lines[i]!, fence);
    if (wasInFence || fence) continue;
    if (lines[i] === `## ${heading}`) { start = i + 1; break; }
  }
  if (start < 0) return '';
  if (lines[start] === '') start += 1;
  fence = undefined;
  const result: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    const wasInFence = fence !== undefined;
    fence = advanceFence(line, fence);
    if (wasInFence || fence) { result.push(line); continue; }
    if (REQUIRED_SECTIONS.some((name) => name !== heading && line === `## ${name}`)) break;
    result.push(line);
  }
  return result.join('\n').replace(/\n+$/, '');
}

function extractTechniques(body: string): string[] {
  return sectionBody(body, 'Techniques Practiced')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((value) => value.length > 0 && value !== '(none recorded)');
}

function firstTitle(body: string): string | undefined {
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const trimmed = line.trim();
    return trimmed.startsWith('# ') ? trimmed : undefined;
  }
  return undefined;
}

function validateRequiredSections(body: string): string[] {
  const found = new Set<string>();
  let fence: FenceState | undefined;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const wasInFence = fence !== undefined;
    fence = advanceFence(line, fence);
    if (wasInFence || fence) continue;
    if (REQUIRED_SECTIONS.some((heading) => line === `## ${heading}`)) {
      found.add(line.slice(3));
    }
  }
  return REQUIRED_SECTIONS.filter((heading) => !found.has(heading))
    .map((heading) => `markdown content is missing required section: ${heading}`);
}

function orderedBody(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const sectionIndexes = new Map<string, number>();
  let fence: FenceState | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const wasInFence = fence !== undefined;
    fence = advanceFence(line, fence);
    if (wasInFence || fence || !REQUIRED_SECTIONS.some((heading) => line === `## ${heading}`)) continue;
    const heading = line.slice(3);
    if (sectionIndexes.has(heading)) throw new Error(`markdown contains a duplicate required section: ${heading}`);
    sectionIndexes.set(heading, index);
  }
  const missing = REQUIRED_SECTIONS.filter((heading) => !sectionIndexes.has(heading));
  if (missing.length) throw new Error(`markdown content is missing required section: ${missing[0]}`);

  const firstSectionIndex = Math.min(...sectionIndexes.values());
  const intro = lines.slice(0, firstSectionIndex).join('\n').replace(/^\n+|\n+$/g, '');
  const sections = REQUIRED_SECTIONS.map((heading) => {
    const start = sectionIndexes.get(heading)!;
    const next = [...sectionIndexes.values()].filter((index) => index > start).sort((a, b) => a - b)[0] ?? lines.length;
    const content = lines.slice(start + 1, next).join('\n').replace(/\n+$/g, '');
    return `## ${heading}${content ? `\n${content}` : ''}`;
  });
  return `${intro}\n\n${sections.join('\n\n')}\n`;
}

type RequiredSessionFields = Pick<GitHubMarkdownSession, 'id' | 'date' | 'effort' | 'category'>;
type OptionalSessionFields = Pick<GitHubMarkdownSession, 'duration' | 'videoUrl'>;

function readSessionId(value: string | number | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new Error('missing or invalid "id" in frontmatter');
  }
  return value;
}

function readSessionDate(value: string | number | undefined): string {
  if (typeof value !== 'string' || !isValidSessionDate(value)) {
    throw new Error('session date must be YYYY-MM-DD');
  }
  return value;
}

function readSessionEffort(value: string | number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error('session effort must be between 1 and 5');
  }
  return value;
}

function readSessionCategory(value: string | number | undefined): SessionCategory {
  if (typeof value !== 'string' || !isSessionCategory(value)) {
    throw new Error(`invalid session category "${String(value ?? '')}"`);
  }
  return value;
}

function readRequiredSessionFields(values: Frontmatter): RequiredSessionFields {
  const id = readSessionId(values.get('id'));
  const date = readSessionDate(values.get('date'));
  const effort = readSessionEffort(values.get('effort'));
  const category = readSessionCategory(values.get('category'));
  return { id, date, effort, category };
}

function readSessionDuration(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('invalid "duration" in frontmatter');
  }
  return value;
}

function readSessionVideoUrl(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('invalid "videoUrl" in frontmatter');
  if (value) validateMarkdownVideoUrl(value);
  return value;
}

function readOptionalSessionFields(values: Frontmatter): OptionalSessionFields {
  const duration = readSessionDuration(values.get('duration'));
  const videoUrl = readSessionVideoUrl(values.get('videoUrl'));
  return {
    ...(duration === undefined ? {} : { duration }),
    ...(videoUrl === undefined ? {} : { videoUrl }),
  };
}

function validateSessionBody(body: string): void {
  if (!firstTitle(body)) throw new Error('markdown content must begin with a level-1 title');
  const missingSections = validateRequiredSections(body);
  if (missingSections.length) throw new Error(missingSections[0]);
}

function readSessionText(body: string, values: Frontmatter): Pick<GitHubMarkdownSession, 'techniques' | 'description' | 'notes'> {
  const payload = recoverTextPayload(values);
  return {
    techniques: payload?.techniques ?? extractTechniques(body),
    ...(payload ? (payload.description === undefined ? {} : { description: payload.description }) : { description: sectionBody(body, 'Session Description') }),
    ...(payload ? (payload.notes === undefined ? {} : { notes: payload.notes }) : { notes: sectionBody(body, 'Notes') }),
  };
}

function readSession(document: MarkdownDocument): GitHubMarkdownSession {
  const required = readRequiredSessionFields(document.frontmatter);
  validateSessionBody(document.body);
  const optional = readOptionalSessionFields(document.frontmatter);
  return {
    ...required,
    ...readSessionText(document.body, document.frontmatter),
    ...optional,
  };
}

export function parseSessionMarkdown(markdown: string): MarkdownParseResult {
  try {
    return { ok: true, session: readSession(splitDocument(markdown)) };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : 'invalid session Markdown'],
      ...recoverMetadata(markdown),
    };
  }
}

function recoverMetadata(markdown: string): { id?: string; date?: string } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const result: { id?: string; date?: string } = {};
  for (const line of lines) {
    if (line.startsWith('id:')) result.id = line.slice(3).trim().replace(/^['"]|['"]$/g, '');
    if (line.startsWith('date:')) result.date = line.slice(5).trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function renderMarkdown(session: GitHubMarkdownSession, original: MarkdownDocument): string {
  const frontmatter = renderSessionFrontmatter(session);
  if (original.frontmatter.get('keikoBackupVersion') !== undefined) {
    const version = original.frontmatter.get('keikoBackupVersion');
    const payload = original.frontmatter.get('keikoTextPayload');
    if (typeof version !== 'number' || typeof payload !== 'string') {
      throw new Error('Invalid Keiko backup text payload');
    }
    frontmatter.push(`keikoBackupVersion: ${version}`, `keikoTextPayload: ${JSON.stringify(payload)}`);
  }
  for (const [key, value] of original.frontmatter) {
    if (!KNOWN_FRONTMATTER.has(key)) frontmatter.push(`${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`);
  }
  return `---\n${frontmatter.join('\n')}\n---\n\n${orderedBody(original.body)}`;
}

export function renderSessionFrontmatter(session: SessionMarkdownFrontmatterInput): string[] {
  return [
    `id: ${JSON.stringify(session.id)}`,
    `date: ${JSON.stringify(session.date)}`,
    `effort: ${session.effort}`,
    `category: ${JSON.stringify(session.category)}`,
    ...(session.duration !== undefined ? [`duration: ${session.duration}`] : []),
    ...(session.videoUrl ? [`videoUrl: ${JSON.stringify(session.videoUrl)}`] : []),
  ];
}

export function normalizeSessionMarkdown(markdown: string): {
  markdown: string;
  changed: boolean;
  errors: string[];
} {
  const normalizedInput = markdown.replace(/\r\n?/g, '\n');
  try {
    const document = splitDocument(normalizedInput);
    const session = readSession(document);
    const normalized = renderMarkdown(session, document);
    const changed = normalized !== `${normalizedInput.replace(/\n+$/, '')}\n`;
    return { markdown: normalized, changed, errors: [] };
  } catch (error) {
    return {
      markdown: normalizedInput,
      changed: false,
      errors: [error instanceof Error ? error.message : 'invalid session Markdown'],
    };
  }
}

export function isSafeSessionMarkdownPath(filePath: string): boolean {
  const value = filePath.trim();
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false;
  const segments = value.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) return false;
  return /^data\/\d{4}\/\d{2}\/\d{8}-matmetrics-[A-Za-z0-9_-]{1,100}\.md$/.test(value);
}
