import { describe, expect, it, vi } from 'vitest';
import { renderBody, renderMarkdown, slugify } from './markdown';
import { highlightCode } from './highlight';

function dom(html: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

describe('renderMarkdown: GitHub-flavoured blocks', () => {
  it('renders a table', () => {
    expect(renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n').html).toContain('<table');
  });

  it('renders a checked task as a checked, disabled checkbox', () => {
    const box = dom(renderMarkdown('- [x] a\n').html).querySelector('input');
    expect(box?.type).toBe('checkbox');
    expect(box?.checked).toBe(true);
    expect(box?.disabled).toBe(true);
  });

  it('renders ~~s~~ as <s>', () => {
    expect(renderMarkdown('~~s~~').html).toContain('<s>s</s>');
  });

  it('turns a bare URL into a link', () => {
    expect(renderMarkdown('see https://example.com now').html).toContain(
      '<a href="https://example.com">https://example.com</a>',
    );
  });

  it('highlights a ts fence with hljs spans', () => {
    const html = renderMarkdown('```ts\nconst a = 1;\n```\n').html;
    expect(html).toContain('<code class="hljs language-ts">');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it('escapes a fence in an unknown language without highlighting it', () => {
    const html = renderMarkdown('```nope\n<b>x</b>\n```\n').html;
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('hljs-');
  });
});

describe('renderMarkdown: sanitising', () => {
  it('removes script tags and event handlers', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n').html;
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)</script>');
    expect(html).not.toContain('onerror');
    expect(html).toContain('<img src="x">');
  });

  it('removes style and form tags (Ruling 67)', () => {
    const html = renderMarkdown('<style>body{display:none}</style>\n\n<form action="x"><p>in</p></form>\n').html;
    expect(html).not.toContain('<style');
    expect(html).not.toContain('display:none');
    expect(html).not.toContain('<form');
  });

  it('removes inputs that are not checkboxes (Ruling 67)', () => {
    const html = renderMarkdown('<p><input type="text" value="t"><input value="u"><input type="CHECKBOX"></p>\n').html;
    const inputs = dom(html).querySelectorAll('input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.type).toBe('checkbox');
  });

  it('removes javascript: links', () => {
    expect(renderMarkdown('<a href="javascript:alert(1)">x</a>').html).not.toContain('javascript:');
  });

  // Ruling 85: a document must not be able to draw fake app UI.
  it('removes style and popover attributes', () => {
    const html = renderMarkdown('<div style="position:fixed;inset:0" popover id="h-p">Fake dialog</div>\n').html;
    expect(html).not.toContain('style=');
    expect(html).not.toContain('popover');
    expect(html).toContain('Fake dialog');
  });

  it.each(['button', 'textarea', 'select', 'option', 'dialog', 'iframe', 'object', 'embed'])('removes <%s>', (tag) => {
    const html = renderMarkdown(`<p><${tag} open>x</${tag}></p>\n`).html;
    expect(html).not.toContain(`<${tag}`);
  });

  it('keeps details and summary', () => {
    const html = renderMarkdown('<details><summary>More</summary>Body</details>\n').html;
    expect(html).toContain('<details><summary>More</summary>Body</details>');
  });

  it('keeps only the renderer\'s own class names', () => {
    const html = renderMarkdown('<div class="dv-tab hljs-string evil language-x">a</div>\n\n<p class="dv-dockview">b</p>\n').html;
    const [div, p] = [...dom(html).children];
    expect(div?.getAttribute('class')).toBe('hljs-string language-x');
    expect(p?.hasAttribute('class')).toBe(false);
  });

  it('keeps the classes the renderer writes', () => {
    const html = renderMarkdown('- [ ] a\n\n```mermaid\nx\n```\n').html;
    expect(html).toContain('class="contains-task-list"');
    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('class="task-list-item-checkbox"');
    expect(html).toContain('class="mermaid-src"');
  });

  it('keeps only h- ids', () => {
    const html = renderMarkdown('<div id="toolbar">a</div>\n\n<div id="h-fake">b</div>\n').html;
    const [first, second] = [...dom(html).children];
    expect(first?.hasAttribute('id')).toBe(false);
    expect(second?.id).toBe('h-fake');
  });

  it('keeps data-source-line only when it is a number', () => {
    const html = renderMarkdown('<div data-source-line="2 x">a</div>\n\n<div data-source-line="">b</div>\n').html;
    expect([...dom(html).children].map((el) => el.hasAttribute('data-source-line'))).toEqual([false, false]);
  });

  it('drops every data- attribute except data-source-line (Ruling 87)', () => {
    const html = renderMarkdown('<div data-tauri-drag-region data-x="1" data-source-line="3">a</div>\n').html;
    const div = dom(html).firstElementChild;
    expect(div?.getAttributeNames()).toEqual(['data-source-line']);
  });

  it('drops download on links (Ruling 88)', () => {
    const html = renderMarkdown('<a href="a.md" download="x.md">a</a>\n').html;
    expect(dom(html).querySelector('a')?.hasAttribute('download')).toBe(false);
  });

  it('keeps only exact renderer class shapes (Ruling 88)', () => {
    const html = renderMarkdown(
      '<div class="hljs hljs-x hljsevil hljs-A task-list-item-fake task-list-itemx task-list-item-checkbox">a</div>\n',
    ).html;
    expect(dom(html).firstElementChild?.getAttribute('class')).toBe('hljs hljs-x task-list-item-checkbox');
  });

  it('refuses to render when DOMPurify cannot run', async () => {
    vi.resetModules();
    vi.doMock('dompurify', () => ({
      default: () => ({ isSupported: false, addHook: () => {}, sanitize: (s: string) => s }),
    }));
    try {
      const { renderMarkdown: render } = await import('./markdown');
      expect(() => render('<script>alert(1)</script>')).toThrow(/DOMPurify/);
    } finally {
      vi.doUnmock('dompurify');
      vi.resetModules();
    }
  });
});

describe('slugify', () => {
  it('makes GitHub-style slugs, unique within one map', () => {
    const seen = new Map<string, number>();
    expect(slugify('Build matrix', seen)).toBe('build-matrix');
    expect(slugify('Build matrix', seen)).toBe('build-matrix-1');
    expect(slugify('Build matrix', seen)).toBe('build-matrix-2');
  });

  it('skips a suffix another heading already took', () => {
    const seen = new Map<string, number>();
    expect(slugify('A-1', seen)).toBe('a-1');
    expect(slugify('A', seen)).toBe('a');
    expect(slugify('A', seen)).toBe('a-2');
  });

  it('drops punctuation, keeps letters from any script', () => {
    expect(slugify('  Héllo, Wörld! — 日本 _x_ ', new Map())).toBe('héllo-wörld--日本-_x_');
  });

  it('gives a fallback for a heading with no letters or digits', () => {
    expect(slugify('!!!', new Map())).toBe('section');
  });
});

describe('renderMarkdown: headings', () => {
  it('gives repeated headings unique h- ids (Ruling 64)', () => {
    const r = renderMarkdown('# Build matrix\n\n## Build matrix\n');
    expect(r.headings).toEqual([
      { level: 1, text: 'Build matrix', id: 'h-build-matrix', line: 1 },
      { level: 2, text: 'Build matrix', id: 'h-build-matrix-1', line: 3 },
    ]);
    const ids = [...dom(r.html).querySelectorAll('h1, h2')].map((h) => h.id);
    expect(ids).toEqual(['h-build-matrix', 'h-build-matrix-1']);
  });

  it('keeps the id of a heading named like a DOM property', () => {
    const r = renderMarkdown('# Title\n\n# Location\n');
    expect(dom(r.html).querySelector('h1')?.id).toBe('h-title');
    expect(r.html).toContain('id="h-location"');
  });

  it('uses the plain text of formatted headings', () => {
    const r = renderMarkdown('### Use `pnpm` **now** [here](https://x.y)\n');
    expect(r.headings[0]).toEqual({ level: 3, text: 'Use pnpm now here', id: 'h-use-pnpm-now-here', line: 1 });
  });

  it('joins the lines of a two-line heading with a space', () => {
    expect(renderMarkdown('A\nB\n===\n').headings[0]).toMatchObject({ text: 'A B', id: 'h-a-b' });
  });

  it('uses the alt text of an image in a heading', () => {
    expect(renderMarkdown('# ![Logo](x.png) Name\n').headings[0]).toMatchObject({ text: 'Logo Name', id: 'h-logo-name' });
  });

  it('counts heading lines from the start of the file when there is front matter', () => {
    const r = renderMarkdown('---\na: 1\n---\n\n# One\n');
    expect(r.headings[0]?.line).toBe(5);
  });
});

describe('renderMarkdown: source lines', () => {
  const fixture = [
    '# Heading', // 1
    'Paragraph text.', // 2
    '', // 3
    '- one', // 4
    '', // 5
    '> quote', // 6
    '', // 7
    '| a | b |', // 8
    '| - | - |', // 9
    '---', // 10
  ].join('\n');

  function topLevelLines(html: string): [string, string | null][] {
    return [...dom(html).children].map((el) => [el.tagName.toLowerCase(), el.getAttribute('data-source-line')]);
  }

  it('stamps every top-level block of a 10-line document', () => {
    expect(topLevelLines(renderMarkdown(fixture).html)).toEqual([
      ['h1', '1'],
      ['p', '2'],
      ['ul', '4'],
      ['blockquote', '6'],
      ['table', '8'],
      ['hr', '10'],
    ]);
  });

  it('offsets the lines by the front matter', () => {
    const lines = topLevelLines(renderMarkdown(`---\nname: x\n---\n${fixture}`).html);
    expect(lines.map(([, line]) => line)).toEqual(['4', '5', '7', '9', '11', '13']);
  });

  it('puts the line on the <pre> of fenced and indented code', () => {
    const html = renderMarkdown('```js\nx\n```\n\n    indented\n').html;
    expect(topLevelLines(html)).toEqual([
      ['pre', '1'],
      ['pre', '5'],
    ]);
  });

  it('stamps only top-level blocks', () => {
    const html = renderMarkdown('> # Inner\n>\n> - item\n').html;
    expect(html.match(/data-source-line/g)).toHaveLength(1);
  });
});

describe('renderMarkdown: mermaid fences', () => {
  it('renders a placeholder pre with the escaped source and no highlighting', () => {
    const html = renderMarkdown('Intro\n\n```mermaid\ngraph TD; A-->B<br>\n```\n').html;
    expect(html).toContain('<pre class="mermaid-src" data-source-line="3">graph TD; A--&gt;B&lt;br&gt;\n</pre>');
    expect(html).not.toContain('hljs');
  });
});

describe('renderMarkdown: front matter', () => {
  it('parses a front matter block and starts the body after it', () => {
    const r = renderMarkdown('---\nname: x\n---\n# Doc\n');
    expect(r.frontMatter?.name).toBe('x');
    expect(r.frontMatterError).toBeNull();
    expect(r.bodyStartLine).toBe(4);
    expect(r.html).not.toContain('name: x');
  });

  it('gives a null front matter and an error message for invalid YAML', () => {
    const r = renderMarkdown('---\nname: [x\n---\n# Doc\n');
    expect(r.frontMatter).toBeNull();
    expect(r.frontMatterError).toBeTruthy();
    expect(r.bodyStartLine).toBe(4);
  });

  it('gives null and no error when there is no front matter', () => {
    const r = renderMarkdown('# Doc\n');
    expect(r.frontMatter).toBeNull();
    expect(r.frontMatterError).toBeNull();
    expect(r.bodyStartLine).toBe(1);
  });
});

describe('highlightCode', () => {
  it.each([
    ['bash', 'echo "hi"'],
    ['shell', '$ ls -la'],
    ['json', '{"a": 1}'],
    ['yaml', 'a: 1'],
    ['ts', 'const a = 1'],
    ['js', 'const a = 1'],
    ['python', 'def f(): pass'],
    ['rust', 'fn main() {}'],
    ['go', 'func main() {}'],
    ['html', '<b>x</b>'],
    ['css', 'a { color: red }'],
    ['sql', 'SELECT 1'],
    ['diff', '+ added'],
    ['markdown', '# Title'],
    ['toml', '[a]\nb = 1'],
  ])('highlights %s', (lang, code) => {
    expect(highlightCode(code, lang)).toContain('<span class="hljs-');
  });

  it('ignores case in the language name', () => {
    expect(highlightCode('const a = 1', 'TS')).toContain('<span class="hljs-keyword">');
  });

  it('escapes code in a language it does not know', () => {
    expect(highlightCode('<i>&', 'cobol')).toBe('&lt;i&gt;&amp;');
  });
});

describe('renderBody: speed (Ruling 66)', () => {
  it('renders a 1 MB document with markdown-it in under 1 s (3 s on CI)', () => {
    // Mostly prose, like a real document; about 160 ms locally, leaving headroom for CI runners.
    const prose = 'Some *prose* with a [link](https://example.com) and `code`, then https://example.org. More words.\n\n';
    const block = [
      '## Section',
      '',
      prose.repeat(3),
      '- [ ] task',
      '- item with **bold**',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x: number = 1;',
      '```',
      '',
    ].join('\n');
    const src = block.repeat(Math.ceil(1_000_000 / block.length));
    expect(src.length).toBeGreaterThanOrEqual(1_000_000);
    const start = performance.now();
    renderBody(src, 1);
    // Shared CI runners are often 2-3x slower than a laptop (Ruling 86).
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    expect(performance.now() - start).toBeLessThan(env?.CI ? 3000 : 1000);
  });
});
