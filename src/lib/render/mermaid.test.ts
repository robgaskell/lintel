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
    expect(config.dompurifyConfig.FORBID_TAGS).toEqual(expect.arrayContaining(['style', 'img', 'image', 'feimage']));
    expect([...config.secure].sort()).toEqual(
      [
        'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
        'dompurifyConfig', 'themeCSS', 'fontFamily', 'altFontFamily',
      ].sort(),
    );
  });

  it('caps diagram size so one document cannot stall the preview (Ruling 114)', async () => {
    await renderMermaidIn(page('graph TD; Capped'), 'light');

    const config = mermaid.initialize.mock.calls[0]![0];
    expect(config.maxEdges).toBe(200);
    expect(config.maxTextSize).toBe(20000);
    expect(config.secure).toEqual(expect.arrayContaining(['maxEdges', 'maxTextSize']));
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
    expect(box?.querySelector('strong')?.textContent).toBe('Parse error on line 1 of the diagram (file line 11):');
    expect(box?.querySelector('pre')?.textContent).toBe('<b>A--</b>\n---^');
    expect(box?.querySelector('b')).toBeNull();
    expect((box as HTMLElement).dataset.sourceLine).toBe('10');
    expect(document.querySelector('[id^="dlintel-mermaid-"]')).toBeNull();
  });

  it('names the diagram line and the file line of an error (Ruling 117)', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 2:\n  A --\n-----^'));
    const container = page('flowchart LR\n  A --\n  B');

    await renderMermaidIn(container, 'light');

    expect(container.querySelector('.mermaid-error strong')?.textContent).toBe(
      'Parse error on line 2 of the diagram (file line 12):',
    );
  });

  it('points an error found at the end of the diagram at its last line', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 4:\n...'));
    const container = page('flowchart LR\n  A --\n');

    await renderMermaidIn(container, 'light');

    expect(container.querySelector('.mermaid-error strong')?.textContent).toBe(
      'Parse error on line 2 of the diagram (file line 12):',
    );
  });

  it('keeps the shown diagram while drafts of another come and go (Ruling 115)', async () => {
    for (let n = 0; n < 70; n++) await renderMermaidIn(page('graph TD; Shown', `graph TD; Draft${n}`), 'light');

    const shownRenders = mermaid.render.mock.calls.filter(([, src]) => src === 'graph TD; Shown');
    expect(shownRenders).toHaveLength(1);
  });

  it('keeps every diagram of a large document across patches (Ruling 115)', async () => {
    const sources = Array.from({ length: 100 }, (_, n) => `graph TD; Big${n}`);
    await renderMermaidIn(page(...sources), 'light');
    const again = page(...sources);

    void renderMermaidIn(again, 'light');

    expect(again.querySelectorAll('pre.mermaid-src')).toHaveLength(0);
    expect(mermaid.render).toHaveBeenCalledTimes(100);
  });

  it('skips a queued render that a newer patch made stale (Ruling 115)', async () => {
    const finishers: (() => void)[] = [];
    mermaid.render.mockImplementation(
      (id: string) =>
        new Promise((resolve) => finishers.push(() => resolve({ svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"></svg>` }))),
    );
    const container = page();
    const patch = (src: string) => {
      container.replaceChildren(...page(src).children);
      return renderMermaidIn(container, 'light');
    };

    const first = patch('graph TD; Draft1');
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    const second = patch('graph TD; Draft2');
    const third = patch('graph TD; Draft3');
    finishers.shift()!();
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    finishers.shift()!();
    await Promise.all([first, second, third]);

    expect(mermaid.render.mock.calls.map(([, src]) => src)).toEqual(['graph TD; Draft1', 'graph TD; Draft3']);
    expect(container.querySelectorAll('.mermaid-diagram')).toHaveLength(1);
  });

  it('ends in the theme asked for last when the theme flips back mid-render (Ruling 115)', async () => {
    const container = page('graph TD; Flip');
    await renderMermaidIn(container, 'light');

    const dark = renderMermaidIn(container, 'dark');
    const light = renderMermaidIn(container, 'light');
    await Promise.all([dark, light]);

    expect(container.querySelector('svg')?.textContent).toBe('default:graph TD; Flip');
  });

  it('drops a render that finished after the theme flipped back (Ruling 115)', async () => {
    const container = page('graph TD; Late');
    await renderMermaidIn(container, 'light');
    let finish: () => void = () => {};
    mermaid.render.mockImplementation(
      (_id: string, src: string) =>
        new Promise((resolve) => (finish = () => resolve({ svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${theme}:${src}</text></svg>` }))),
    );

    const dark = renderMermaidIn(container, 'dark');
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    const light = renderMermaidIn(container, 'light');
    finish();
    await Promise.all([dark, light]);

    expect(container.querySelector('svg')?.textContent).toBe('default:graph TD; Late');
  });

  it('gives each copy of a diagram its own ids, so references stay inside it (Ruling 114)', async () => {
    mermaid.render.mockImplementation(async (id: string) => ({
      svg:
        `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" aria-labelledby="${id}-title"><title id="${id}-title">t</title>` +
        `<style>#${id} .edge{stroke:#333}#${id}_arrow{fill:#000}</style>` +
        `<marker id="${id}_arrow"><path d="M0 0"/></marker>` +
        `<path class="edge" marker-end="url(#${id}_arrow)"/><text><textPath href="#${id}_arrow">x</textPath></text></svg>`,
    }));
    const first = page('graph TD; Twice');
    const second = page('graph TD; Twice');
    await renderMermaidIn(first, 'light');
    await renderMermaidIn(second, 'light');

    const ids = [first, second].flatMap((c) => [...c.querySelectorAll('[id]')].map((el) => el.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of [first, second].map((c) => c.querySelector('svg')!)) {
      const marker = svg.querySelector('marker')!.id;
      expect(svg.querySelector('path.edge')?.getAttribute('marker-end')).toBe(`url(#${marker})`);
      expect(svg.querySelector('textPath')?.getAttribute('href')).toBe(`#${marker}`);
      expect(svg.querySelector('style')?.textContent).toBe(`#${svg.id} .edge{stroke:#333}#${marker}{fill:#000}`);
      expect(svg.getAttribute('aria-labelledby')).toBe(svg.querySelector('title')!.id);
    }
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

  it('removes feImage and any url() that is not a local #id, from every attribute (Ruling 114)', async () => {
    mermaid.render.mockResolvedValue({
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg"><defs><filter id="f"><feImage href="https://evil.example/fe.png"/></filter>' +
        '<linearGradient id="g"/></defs>' +
        '<rect filter="url(#f)" fill="url( \'#g\' )" mask="url(https://evil.example/m.svg#m)"/>' +
        '<rect clip-path="URL(https://evil.example/c.svg#c)" stroke="u\\72l(https://evil.example/s.svg)"/>' +
        '<use href="https://evil.example/u.svg#a"/></svg>',
    });

    const svg = await renderMermaidToSvg('graph TD; Attrs', 'light');

    expect(svg).not.toMatch(/feimage|evil\.example/i);
    expect(svg).toContain('filter="url(#f)"');
    expect(svg).toContain("fill=\"url( '#g' )\"");
  });

  it('filters CSS until nothing changes and keeps local url(#id) (Ruling 114)', async () => {
    mermaid.render.mockResolvedValue({
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg"><style>@imp@importort "https://evil.example/a.css";' +
        '.t{stroke:url(#id-gradient)}.u{background:uurl(rl(https://evil.example/b.png)}</style>' +
        '<rect style="stroke:url(#id-gradient);fill:url(https://evil.example/c.png)"/></svg>',
    });

    const svg = await renderMermaidToSvg('graph TD; Css', 'light');

    expect(svg).not.toMatch(/@import|url\(\s*['"]?h/i);
    expect(svg).toContain('.t{stroke:url(#id-gradient)}');
    expect(svg).toContain('style="stroke:url(#id-gradient);');
  });

  it('rejects with the mermaid message', async () => {
    mermaid.render.mockRejectedValue(new Error('No diagram type detected'));

    await expect(renderMermaidToSvg('nonsense', 'light')).rejects.toThrow('No diagram type detected');
  });

  it('draws labels as SVG text for Word, and a document cannot turn HTML labels back on (Ruling 316)', async () => {
    await renderMermaidToSvg('graph TD; Word', 'light', { htmlLabels: false });

    const config = mermaid.initialize.mock.calls.at(-1)![0];
    expect(config.htmlLabels).toBe(false);
    expect(config.secure).toEqual(expect.arrayContaining(['htmlLabels', 'flowchart']));
  });

  it('keeps the preview\'s diagrams and setup apart from Word\'s (Ruling 316)', async () => {
    await renderMermaidIn(page('graph TD; Both'), 'light');
    await renderMermaidToSvg('graph TD; Both', 'light', { htmlLabels: false });
    expect(mermaid.render).toHaveBeenCalledTimes(2);

    // Cached for the preview, so its drawing never changes.
    await renderMermaidIn(page('graph TD; Both'), 'light');
    expect(mermaid.render).toHaveBeenCalledTimes(2);

    await renderMermaidIn(page('graph TD; Later'), 'light');
    const config = mermaid.initialize.mock.calls.at(-1)![0];
    expect(config).not.toHaveProperty('htmlLabels');
    expect(config.secure).not.toContain('flowchart');
  });

  it('never lets Word renders push the preview\'s diagrams out of its cache (Ruling 327)', async () => {
    await renderMermaidIn(page('graph TD; Kept'), 'light');
    for (let i = 0; i < 80; i++) await renderMermaidToSvg(`graph TD; W${i}`, 'light', { htmlLabels: false });
    const renders = mermaid.render.mock.calls.length;

    await renderMermaidIn(page('graph TD; Kept'), 'light');

    expect(mermaid.render).toHaveBeenCalledTimes(renders);
  });

  it('keeps only a few Word renders (Ruling 327)', async () => {
    for (let i = 0; i < 20; i++) await renderMermaidToSvg(`graph TD; W${i}`, 'light', { htmlLabels: false });
    await renderMermaidToSvg('graph TD; W19', 'light', { htmlLabels: false });
    expect(mermaid.render).toHaveBeenCalledTimes(20);

    await renderMermaidToSvg('graph TD; W0', 'light', { htmlLabels: false });
    expect(mermaid.render).toHaveBeenCalledTimes(21);
  });
});
