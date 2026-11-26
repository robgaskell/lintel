import { describe, expect, it } from 'vitest';
import { extractHeadings } from './headings';
import { renderMarkdown } from './markdown';

describe('extractHeadings', () => {
  it('lists headings with level, text, id and file line, after front matter', () => {
    const src = '---\ntitle: x\n---\n# Release checklist\n\ntext\n\n## Before you start\n';
    expect(extractHeadings(src)).toEqual([
      { level: 1, text: 'Release checklist', id: 'h-release-checklist', line: 4 },
      { level: 2, text: 'Before you start', id: 'h-before-you-start', line: 8 },
    ]);
  });

  it('gives the same headings and ids as the preview render (Ruling 107)', () => {
    const src = [
      '---',
      'a: 1',
      '---',
      '# Build matrix',
      'Setext heading',
      '==============',
      '## Build matrix',
      '### `code` and *emphasis* and [link](x) and ![alt](i.png)',
      '> ## Quoted heading',
      '- ### In a list',
      '#### see www.example.com',
      '##### [ref link][r]',
      '###### <b>html</b> heading',
      '```',
      '# not a heading',
      '```',
      '<div>',
      '# inside html',
      '</div>',
      '',
      '# !!!',
      '#',
      '',
      '[r]: https://example.com',
    ].join('\n');

    const extracted = extractHeadings(src);
    expect(extracted).toEqual(renderMarkdown(src).headings);
    expect(extracted.map((h) => h.text)).not.toContain('not a heading');
    expect(extracted.length).toBeGreaterThan(8);
  });

  it('finds no headings in an empty document', () => {
    expect(extractHeadings('')).toEqual([]);
  });
});
