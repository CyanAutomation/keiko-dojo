import { describe, expect, it } from 'vitest';
import {
  isSafeSessionMarkdownPath,
  normalizeSessionMarkdown,
  parseSessionMarkdown,
} from '../src/domain/github-session-markdown';
import { credentialBearingVideoUrl } from './helpers';

const originalText = {
  techniques: ['Ōuchi mata', 'Grip fighting'],
  description: 'Kept <exactly> as entered',
  notes: 'Use the inside grip next time.',
};

function keikoMarkdown(): string {
  return [
    '---',
    'id: "session-123"',
    'date: "2026-10-24"',
    'effort: 4',
    'category: "Technical"',
    'keikoBackupVersion: 1',
    `keikoTextPayload: ${JSON.stringify(JSON.stringify(originalText))}`,
    '---',
    '',
    '# 2026-10-24 - Judo Session: Technical',
    '',
    '## Techniques Practiced',
    '- Ōuchi mata',
    '- Grip fighting',
    '',
    '## Session Description',
    '',
    'Kept &lt;exactly&gt; as entered',
    '',
    '## Notes',
    '',
    'Use the inside grip next time.',
    '',
  ].join('\n');
}

describe('GitHub session Markdown', () => {
  it('parses a Keiko backup and uses its lossless text payload', () => {
    const result = parseSessionMarkdown(keikoMarkdown());

    expect(result).toMatchObject({
      ok: true,
      session: {
        id: 'session-123',
        date: '2026-10-24',
        effort: 4,
        category: 'Technical',
        ...originalText,
      },
    });
  });

  it('parses and preserves validated optional duration metadata', () => {
    const markdown = keikoMarkdown().replace(
      'effort: 4',
      'effort: 4\nduration: 90'
    );

    expect(parseSessionMarkdown(markdown)).toMatchObject({
      ok: true,
      session: { duration: 90 },
    });
    const normalized = normalizeSessionMarkdown(markdown);
    expect(normalized.errors).toEqual([]);
    expect(normalized.changed).toBe(true);
    expect(normalized.markdown).toContain('category: "Technical"\nduration: 90');
    expect(parseSessionMarkdown(normalized.markdown)).toMatchObject({
      ok: true,
      session: { duration: 90 },
    });
  });

  it('leaves an already canonical Keiko backup unchanged', () => {
    const markdown = keikoMarkdown();

    const result = normalizeSessionMarkdown(markdown);

    expect(result.errors).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.markdown).toBe(markdown);
  });

  it('normalizes section order without dropping the lossless Keiko payload', () => {
    const markdown = keikoMarkdown()
      .replace('## Techniques Practiced\n- Ōuchi mata\n- Grip fighting\n\n', '')
      .replace(/## Notes\n+Use the inside grip next time\.\n*/u, '')
      .replace('## Session Description\n\nKept &lt;exactly&gt; as entered\n\n', '')
      .replace(
        '# 2026-10-24 - Judo Session: Technical\n\n',
        '# Hand-edited title\n\n## Notes\n\nUse the inside grip next time.\n\n## Session Description\n\nKept &lt;exactly&gt; as entered\n\n## Techniques Practiced\n- Ōuchi mata\n- Grip fighting\n\n'
      );

    const result = normalizeSessionMarkdown(markdown);
    expect(result.errors).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.markdown).toContain(`keikoTextPayload: ${JSON.stringify(JSON.stringify(originalText))}`);
    expect(result.markdown.indexOf('## Techniques Practiced')).toBeLessThan(
      result.markdown.indexOf('## Session Description')
    );
    expect(result.markdown.indexOf('## Session Description')).toBeLessThan(
      result.markdown.indexOf('## Notes')
    );
    expect(result.markdown).toContain('# Hand-edited title');
    expect(parseSessionMarkdown(result.markdown)).toMatchObject({
      ok: true,
      session: originalText,
    });
  });

  it('preserves extra Markdown sections and their text during normalization', () => {
    const markdown = keikoMarkdown().replace(
      /\n## Notes\n\nUse the inside grip next time\.\n*/u,
      '\n## Notes\n\nUse the inside grip next time.\n\n## Coach Cues\n\nKeep the sleeve grip.\n\n'
    );

    const result = normalizeSessionMarkdown(markdown);

    expect(result.errors).toEqual([]);
    expect(result.markdown).toContain('## Coach Cues\n\nKeep the sleeve grip.');
  });

  it('does not treat a different fence marker inside a code block as its closing fence', () => {
    const markdown = keikoMarkdown()
      .replace(/^keikoBackupVersion: 1\nkeikoTextPayload: .*\n/mu, '')
      .replace(
        '## Session Description\n\nKept &lt;exactly&gt; as entered\n\n## Notes',
        [
          '## Session Description',
          '',
          'Example:',
          '````markdown',
          '~~~text',
          '## Notes',
          '~~~',
          '````',
          '',
          'This remains part of the description.',
          '',
          '## Notes',
        ].join('\n')
      );

    expect(parseSessionMarkdown(markdown)).toMatchObject({
      ok: true,
      session: {
        description: [
          'Example:',
          '````markdown',
          '~~~text',
          '## Notes',
          '~~~',
          '````',
          '',
          'This remains part of the description.',
        ].join('\n'),
        notes: 'Use the inside grip next time.',
      },
    });
  });

  it('does not re-escape text in legacy MatMetrics Markdown without a Keiko payload', () => {
    const markdown = keikoMarkdown().replace(
      /keikoBackupVersion: 1\nkeikoTextPayload: .*\n/,
      ''
    );

    const result = normalizeSessionMarkdown(markdown);

    expect(result.errors).toEqual([]);
    expect(result.markdown).toContain('Kept &lt;exactly&gt; as entered');
    expect(result.markdown).not.toContain('&amp;lt;');
  });

  it('preserves extension fields in the Keiko text payload', () => {
    const payload = { ...originalText, sourceMetadata: { importer: 'matmetrics' } };
    const markdown = keikoMarkdown().replace(
      `keikoTextPayload: ${JSON.stringify(JSON.stringify(originalText))}`,
      `keikoTextPayload: ${JSON.stringify(JSON.stringify(payload))}`
    );

    const result = normalizeSessionMarkdown(markdown);

    expect(result.errors).toEqual([]);
    expect(result.markdown).toContain(
      `keikoTextPayload: ${JSON.stringify(JSON.stringify(payload))}`
    );
  });

  it('reports malformed session data instead of producing a partial repair', () => {
    const result = normalizeSessionMarkdown('---\nid: "broken"\n---\n\n# Broken\n');

    expect(result.changed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.markdown).toContain('# Broken');
  });

  it.each([
    [
      'invalid date',
      keikoMarkdown().replace('date: "2026-10-24"', 'date: "2026-02-30"'),
      'session date must be YYYY-MM-DD',
    ],
    [
      'invalid effort',
      keikoMarkdown().replace('effort: 4', 'effort: 6'),
      'session effort must be between 1 and 5',
    ],
    [
      'invalid duration',
      keikoMarkdown().replace('effort: 4', 'effort: 4\nduration: -1'),
      'invalid "duration" in frontmatter',
    ],
    [
      'invalid video URL type',
      keikoMarkdown().replace('effort: 4', 'effort: 4\nvideoUrl: 42'),
      'invalid "videoUrl" in frontmatter',
    ],
    [
      'invalid backup payload',
      keikoMarkdown().replace(/keikoTextPayload: .*\n/u, 'keikoTextPayload: "not-json"\n'),
      'Invalid Keiko backup text payload',
    ],
    [
      'missing required section',
      keikoMarkdown().replace(/## Notes\n\nUse the inside grip next time\.\n*/u, ''),
      'markdown content is missing required section: Notes',
    ],
  ])('uses the same session validation for parsing and repair (%s)', (_name, markdown, expectedError) => {
    expect(parseSessionMarkdown(markdown)).toMatchObject({
      ok: false,
      errors: [expectedError],
    });
    expect(normalizeSessionMarkdown(markdown).errors).toEqual([expectedError]);
  });

  it('rejects video URLs with embedded credentials in parsed and repaired Markdown', () => {
    const markdown = keikoMarkdown().replace(
      'category: "Technical"',
      `category: "Technical"\nvideoUrl: ${JSON.stringify(credentialBearingVideoUrl())}`
    );

    expect(parseSessionMarkdown(markdown)).toMatchObject({ ok: false });
    expect(normalizeSessionMarkdown(markdown).errors).toContain(
      'invalid videoUrl: credentials are not allowed'
    );
  });

  it('rejects private network video URLs in parsed and repaired Markdown', () => {
    const markdown = keikoMarkdown().replace(
      'category: "Technical"',
      'category: "Technical"\nvideoUrl: "http://127.0.0.1/clip"'
    );

    expect(parseSessionMarkdown(markdown)).toMatchObject({ ok: false });
    expect(normalizeSessionMarkdown(markdown).errors).toContain(
      'videoUrl must not point to a private or internal network host'
    );
  });

  it.each([
    ['keikoBackupVersion: 2', 'keikoTextPayload: "{}"'],
    ['keikoTextPayload: "{}"'],
  ])('refuses to normalize an unsupported or incomplete Keiko payload marker', (...markers) => {
    const markdown = keikoMarkdown().replace(
      /keikoBackupVersion: 1[\s\S]*?---/,
      `${markers.join('\n')}\n---`
    );
    const result = normalizeSessionMarkdown(markdown);

    expect(result.changed).toBe(false);
    expect(result.errors).toContain('Invalid Keiko backup text payload');
    expect(result.markdown).toBe(markdown);
  });

  it.each([
    ['an array', []],
    ['a payload without techniques', { description: 'missing techniques' }],
    ['non-string techniques', { techniques: ['grip', 4] }],
    ['a non-string description', { techniques: [], description: 4 }],
    ['non-string notes', { techniques: [], notes: null }],
  ])('rejects a Keiko text payload with %s', (_description, payload) => {
    const markdown = keikoMarkdown().replace(
      'keikoTextPayload: ' + JSON.stringify(JSON.stringify(originalText)),
      'keikoTextPayload: ' + JSON.stringify(JSON.stringify(payload))
    );

    expect(parseSessionMarkdown(markdown)).toMatchObject({
      ok: false,
      errors: ['Invalid Keiko backup text payload'],
    });
  });

  it.each([
    ['data/2026/10/20261024-matmetrics-session-123.md', true],
    ['data/2026/10/../../secret.md', false],
    ['data/2026/10/log.txt', false],
    ['/data/2026/10/session.md', false],
    ['data/2026/10/%2e%2e/session.md', false],
  ])('accepts only safe session Markdown paths: %s', (path, expected) => {
    expect(isSafeSessionMarkdownPath(path)).toBe(expected);
  });
});
