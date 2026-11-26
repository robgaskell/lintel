import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real mermaid cannot lay out under jsdom (no getBBox), so the module is mocked.
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

type Module = typeof import('./mermaid');
let renderMermaidIn: Module['renderMermaidIn'];
let renderMermaidToSvg: Module['renderMermaidToSvg'];
let theme: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules(); // a fresh cache and a fresh mermaid setup per test
  ({ renderMermaidIn, renderMermaidToSvg } = await import('./mermaid'));
  theme = undefined;
  mermaid.initialize.mockImplementation((config: { theme?: string }) => (theme = config.theme));
  mermaid.render.mockImplementation(async (id: string, src: string) => ({
    svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><text>${theme}:${src}</text></svg>`,
  }));
});

function page(...sources: string[]): HTMLElement {
  const container = document.createElement('div');
  sources.forEach((src, i) => {
    const pre = document.createElement('pre');
    pre.className = 'mermaid-src';
    pre.dataset.sourceLine = String(10 * (i + 1));
    pre.textContent = src;
    container.append(pre);
  });
  document.body.append(container);
  return container;
}

describe('renderMermaidIn', () => {
  it('renders the same source and theme once, then reuses the SVG', async () => {
    await renderMermaidIn(page('graph TD; A-->B'), 'light');
    const second = page('graph TD; A-->B');
    await renderMermaidIn(second, 'light');

    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(second.querySelector('.mermaid-diagram svg')?.textContent).toBe('default:graph TD; A-->B');
  });

  it('loads mermaid strict, without auto start, in the theme asked for', async () => {
    await renderMermaidIn(page('graph TD; A'), 'dark');

    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'dark' }),
    );
  });

  it('keeps images out of labels while mermaid lays them out, and locks the keys a document could use to fetch', async () => {
    await renderMermaidIn(page('graph TD; Locked'), 'light');

    const config = mermaid.initialize.mock.calls[0]![0];
    expect(config.dompurifyConfig.FORBID_TAGS).toEqual(expect.arrayContaining(['style', 'img', 'image']));
    expect(config.secure).toEqual(
      expect.arrayContaining(['securityLevel', 'dompurifyConfig', 'themeCSS', 'fontFamily', 'altFontFamily']),
    );
  });

  it('never loads mermaid for a page without diagrams', async () => {
    await renderMermaidIn(page(), 'light');

    expect(mermaid.initialize).not.toHaveBeenCalled();
  });

  it('renders again when the theme changes', async () => {
    const container = page('graph TD; A-->B');
    await renderMermaidIn(container, 'light');
    await renderMermaidIn(container, 'dark');

    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('.mermaid-diagram')).toHaveLength(1);
    expect(container.querySelector('svg')?.textContent).toBe('dark:graph TD; A-->B');
  });

  it('keeps the block line on the diagram, so scroll sync still finds it', async () => {
    const container = page('graph TD; A', 'graph TD; B');
    await renderMermaidIn(container, 'light');

    const lines = [...container.children].map((el) => (el as HTMLElement).dataset.sourceLine);
    expect(lines).toEqual(['10', '20']);
    expect(container.querySelector('pre.mermaid-src')).toBeNull();
  });

  it('puts a known diagram in place before it returns, so a re-render never flashes', async () => {
    await renderMermaidIn(page('graph TD; A'), 'light');
    const next = page('graph TD; A');

    void renderMermaidIn(next, 'light');

    expect(next.querySelector('.mermaid-diagram svg')).not.toBeNull();
  });

  it('shows a failed diagram as an error box, first line bold, the rest as text', async () => {
    mermaid.render.mockImplementation(async (id: string) => {
      // Mermaid leaves its scratch node behind when a render fails.
      const stray = document.createElement('div');
      stray.id = `d${id}`;
      document.body.append(stray);
      throw new Error('Parse error on line 2:\n<b>A--</b>\n---^');
    });
    const container = page('graph TD; A--', 'graph TD; fine');

    await renderMermaidIn(container, 'light');

    const box = container.querySelector('.mermaid-error');
    expect(box?.textContent).toContain('Parse error on line 2:');
    expect(box?.querySelector('strong')?.textContent).toBe('Parse error on line 2:');
    expect(box?.querySelector('pre')?.textContent).toBe('<b>A--</b>\n---^');
    expect(box?.querySelector('b')).toBeNull();
    expect((box as HTMLElement).dataset.sourceLine).toBe('10');
    expect(document.querySelector('[id^="dlintel-mermaid-"]')).toBeNull();
  });

  it('drops a render that finishes after its block left the page', async () => {
    let finish: (value: { svg: string }) => void = () => {};
    mermaid.render.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const container = page('graph TD; A');
    const pre = container.querySelector('pre')!;
    const done = renderMermaidIn(container, 'light');
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalled());

    const replacement = document.createElement('p');
    pre.replaceWith(replacement);
    finish({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    await done;

    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toBe(replacement);
  });

  it('shows an error box when mermaid cannot load, and tries again next time', async () => {
    vi.resetModules();
    vi.doMock('mermaid', () => {
      throw new Error('chunk missing');
    });
    const fresh = await import('./mermaid');
    const container = page('graph TD; A');

    try {
      await fresh.renderMermaidIn(container, 'light');
    } finally {
      vi.doMock('mermaid', () => ({ default: mermaid }));
    }
    expect(container.querySelector('.mermaid-error')?.textContent).toContain('Diagrams could not load');

    await fresh.renderMermaidIn(page('graph TD; A'), 'light');
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('lets the newest theme win when an older render finishes late', async () => {
    const container = page('graph TD; A');

    const light = renderMermaidIn(container, 'light');
    const dark = renderMermaidIn(container, 'dark');
    await Promise.all([light, dark]);

    expect(container.querySelector('svg')?.textContent).toBe('dark:graph TD; A');
  });
});

describe('renderMermaidToSvg', () => {
  it('removes an image from a diagram label but keeps the label text (Ruling 99)', async () => {
    mermaid.render.mockResolvedValue({
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="80" height="20">' +
        '<div xmlns="http://www.w3.org/1999/xhtml"><span>Start<img src="https://evil.example/t.png"></span></div>' +
        '</foreignObject><image href="https://evil.example/i.png"/><a href="https://evil.example"><text>go</text></a>' +
        '<script>alert(1)</script></svg>',
    });

    const svg = await renderMermaidToSvg('graph TD; Start', 'light');

    expect(svg).toContain('foreignObject');
    expect(svg).toContain('Start');
    expect(svg).toContain('go');
    expect(svg).not.toMatch(/<img|<image|<a\b|<script|evil\.example/);
  });

  it('removes url( from style elements and style attributes (Ruling 99)', async () => {
    mermaid.render.mockResolvedValue({
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg"><style>#m .node{fill:#eee;background:url(https://evil.example/a.png)}' +
        '#m .x{background:u\\72l(https://evil.example/b.png)}</style>' +
        '<rect class="node" style="fill:#eee;background-image:URL( https://evil.example/c.png )"/></svg>',
    });

    const svg = await renderMermaidToSvg('graph TD; Styled', 'light');

    expect(svg).toContain('fill:#eee');
    expect(svg).toContain('class="node"');
    expect(svg).not.toMatch(/url\s*\(/i);
    expect(svg).not.toContain('\\72');
  });

  it('rejects with the mermaid message', async () => {
    mermaid.render.mockRejectedValue(new Error('No diagram type detected'));

    await expect(renderMermaidToSvg('nonsense', 'light')).rejects.toThrow('No diagram type detected');
  });
});
