import { isSessionCategory, type SessionCategory } from './session';

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

function recoverTextPayload(frontmatter: Frontmatter): KeikoTextPayload | undefined {
  const version = frontmatter.get('keikoBackupVersion');
  if (version === undefined) {
    if (frontmatter.has('keikoTextPayload')) throw new Error('Invalid Keiko backup text payload');
    return undefined;
  }
  const raw = frontmatter.get('keikoTextPayload');
  if (version !== 1 || typeof raw !== 'string') throw new Error('Invalid Keiko backup text payload');
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Invalid Keiko backup text payload');
  }
  if (
    !payload || typeof payload !== 'object' || Array.isArray(payload) ||
    !('techniques' in payload) || !Array.isArray(payload.techniques) ||
    !payload.techniques.every((value) => typeof value === 'string') ||
    ('description' in payload && typeof payload.description !== 'string') ||
    ('notes' in payload && typeof payload.notes !== 'string')
  ) throw new Error('Invalid Keiko backup text payload');
  const value = payload as Record<string, unknown>;
  return {
    techniques: value.techniques as string[],
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
  };
}

function isFence(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

function sectionBody(body: string, heading: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isFence(lines[i]!)) { inFence = !inFence; continue; }
    if (!inFence && lines[i] === `## ${heading}`) { start = i + 1; break; }
  }
  if (start < 0) return '';
  if (lines[start] === '') start += 1;
  inFence = false;
  const result: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isFence(line)) { inFence = !inFence; result.push(line); continue; }
    if (!inFence && REQUIRED_SECTIONS.some((name) => name !== heading && line === `## ${name}`)) break;
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
  let inFence = false;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (isFence(line)) { inFence = !inFence; continue; }
    if (!inFence && REQUIRED_SECTIONS.some((heading) => line === `## ${heading}`)) {
      found.add(line.slice(3));
    }
  }
  return REQUIRED_SECTIONS.filter((heading) => !found.has(heading))
    .map((heading) => `markdown content is missing required section: ${heading}`);
}

function orderedBody(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const sectionIndexes = new Map<string, number>();
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isFence(line)) { inFence = !inFence; continue; }
    if (inFence || !REQUIRED_SECTIONS.some((heading) => line === `## ${heading}`)) continue;
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

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toISOString().slice(0, 10) === value;
}

function readSession(document: MarkdownDocument): GitHubMarkdownSession {
  const values = document.frontmatter;
  const id = values.get('id');
  const date = values.get('date');
  const effort = values.get('effort');
  const category = values.get('category');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    throw new Error('missing or invalid "id" in frontmatter');
  }
  if (typeof date !== 'string' || !validDate(date)) throw new Error('session date must be YYYY-MM-DD');
  if (typeof effort !== 'number' || !Number.isInteger(effort) || effort < 1 || effort > 5) {
    throw new Error('session effort must be between 1 and 5');
  }
  if (typeof category !== 'string' || !isSessionCategory(category)) {
    throw new Error(`invalid session category "${String(category ?? '')}"`);
  }
  const title = firstTitle(document.body);
  if (!title) throw new Error('markdown content must begin with a level-1 title');
  const missingSections = validateRequiredSections(document.body);
  if (missingSections.length) throw new Error(missingSections[0]);

  const duration = values.get('duration');
  if (duration !== undefined && (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 0)) {
    throw new Error('invalid "duration" in frontmatter');
  }
  const videoUrl = values.get('videoUrl');
  if (videoUrl !== undefined && typeof videoUrl !== 'string') throw new Error('invalid "videoUrl" in frontmatter');
  if (typeof videoUrl === 'string' && videoUrl) {
    let parsed: URL;
    try { parsed = new URL(videoUrl); } catch { throw new Error('invalid videoUrl: expected an absolute URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid videoUrl: protocol must be http or https');
  }

  const payload = recoverTextPayload(values);
  return {
    id, date, effort, category,
    techniques: payload?.techniques ?? extractTechniques(document.body),
    ...(payload ? (payload.description === undefined ? {} : { description: payload.description }) : { description: sectionBody(document.body, 'Session Description') }),
    ...(payload ? (payload.notes === undefined ? {} : { notes: payload.notes }) : { notes: sectionBody(document.body, 'Notes') }),
    ...(typeof duration === 'number' ? { duration } : {}),
    ...(typeof videoUrl === 'string' ? { videoUrl } : {}),
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
  const frontmatter = [
    `id: ${JSON.stringify(session.id)}`,
    `date: ${JSON.stringify(session.date)}`,
    `effort: ${session.effort}`,
    `category: ${JSON.stringify(session.category)}`,
    ...(session.duration !== undefined ? [`duration: ${session.duration}`] : []),
    ...(session.videoUrl ? [`videoUrl: ${JSON.stringify(session.videoUrl)}`] : []),
  ];
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

export function normalizeSessionMarkdown(markdown: string): {
  markdown: string;
  changed: boolean;
  errors: string[];
} {
  const normalizedInput = markdown.replace(/\r\n?/g, '\n');
  try {
    const document = splitDocument(normalizedInput);
    const session = readSessionForRepair(document);
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

function readSessionForRepair(document: MarkdownDocument): GitHubMarkdownSession {
  const frontmatter = document.frontmatter;
  const id = frontmatter.get('id');
  const date = frontmatter.get('date');
  const effort = frontmatter.get('effort');
  const category = frontmatter.get('category');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('missing or invalid "id" in frontmatter');
  if (typeof date !== 'string' || !validDate(date)) throw new Error('session date must be YYYY-MM-DD');
  if (typeof effort !== 'number' || !Number.isInteger(effort) || effort < 1 || effort > 5) throw new Error('session effort must be between 1 and 5');
  if (typeof category !== 'string' || !isSessionCategory(category)) throw new Error(`invalid session category "${String(category ?? '')}"`);
  if (!firstTitle(document.body)) throw new Error('markdown content must begin with a level-1 title');
  const missingSections = validateRequiredSections(document.body);
  if (missingSections.length) throw new Error(missingSections[0]);
  const payload = recoverTextPayload(frontmatter);
  const duration = frontmatter.get('duration');
  const videoUrl = frontmatter.get('videoUrl');
  if (duration !== undefined && (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 0)) throw new Error('invalid "duration" in frontmatter');
  if (videoUrl !== undefined && typeof videoUrl !== 'string') throw new Error('invalid "videoUrl" in frontmatter');
  if (typeof videoUrl === 'string' && videoUrl) {
    let parsed: URL;
    try { parsed = new URL(videoUrl); } catch { throw new Error('invalid videoUrl: expected an absolute URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid videoUrl: protocol must be http or https');
  }
  return {
    id, date, effort, category,
    techniques: payload?.techniques ?? extractTechniques(document.body),
    ...(payload ? (payload.description === undefined ? {} : { description: payload.description }) : { description: sectionBody(document.body, 'Session Description') }),
    ...(payload ? (payload.notes === undefined ? {} : { notes: payload.notes }) : { notes: sectionBody(document.body, 'Notes') }),
    ...(typeof duration === 'number' ? { duration } : {}),
    ...(typeof videoUrl === 'string' ? { videoUrl } : {}),
  };
}

export function isSafeSessionMarkdownPath(filePath: string): boolean {
  const value = filePath.trim();
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false;
  const segments = value.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) return false;
  return /^data\/\d{4}\/\d{2}\/\d{8}-matmetrics-[A-Za-z0-9_-]{1,100}\.md$/.test(value);
}
