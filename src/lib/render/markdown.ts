import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import type { StateCore, Token } from 'markdown-it';
import { parseFrontMatter, splitFrontMatter } from './frontMatter';
import { highlightCode } from './highlight';

/** Output of the markdown renderer. */
export interface RenderResult {
  html: string; // sanitised; block elements carry data-source-line (1-based)
  headings: Heading[]; // document order
  frontMatter: Record<string, unknown> | null; // parsed YAML, null if absent or invalid
  frontMatterError: string | null; // YAML parse message when invalid
  bodyStartLine: number; // first source line after front matter, 1-based
}

export interface Heading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string; // plain text of the heading
  id: string; // "h-" + slug, unique in the document (Ruling 64)
  line: number; // source line, 1-based
}

/** Renders a whole document: front matter, markdown, then DOMPurify. */
export function renderMarkdown(src: string): RenderResult {
  const { yaml, body, bodyStartLine } = splitFrontMatter(src);
  const { frontMatter, frontMatterError } =
    yaml === null ? { frontMatter: null, frontMatterError: null } : parseFrontMatter(yaml);
  const { html, headings } = renderBody(body, bodyStartLine);
  // Without DOM support DOMPurify returns its input unchanged.
  if (!purify.isSupported) throw new Error('DOMPurify cannot run here, so markdown is not rendered.');
  return { html: purify.sanitize(html, SANITIZE), headings, frontMatter, frontMatterError, bodyStartLine };
}

/**
 * The markdown-it step alone. Its HTML is NOT sanitised and must never reach the DOM;
 * it is exported so tests can time markdown-it on its own (Ruling 66).
 */
export function renderBody(body: string, bodyStartLine: number): { html: string; headings: Heading[] } {
  const env: RenderEnv = { lineOffset: bodyStartLine - 1, headings: [], slugs: new Map() };
  const html = md.render(body, env);
  return { html, headings: env.headings };
}

/**
 * GitHub-style slug, unique among the slugs in `seen`, which it updates.
 * A repeat gets the next free numeric suffix: "build-matrix", "build-matrix-1".
 */
export function slugify(text: string, seen: Map<string, number>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-') || 'section';
  let slug = base;
  if (seen.has(base)) {
    let n = seen.get(base) ?? 0;
    do {
      n += 1;
      slug = `${base}-${n}`;
    } while (seen.has(slug));
    seen.set(base, n);
  }
  seen.set(slug, 0);
  return slug;
}

// A type alias, not an interface, so it fits markdown-it's index-signature Env type.
type RenderEnv = {
  lineOffset: number; // body line 1 is file line 1 + lineOffset
  headings: Heading[];
  slugs: Map<string, number>;
};

const md = new MarkdownIt({ html: true, linkify: true, typographer: false }).use(taskLists);

md.core.ruler.push('lintel_blocks', (state: StateCore) => {
  const env = state.env as RenderEnv;
  state.tokens.forEach((token, i) => {
    if (!token.map) return;
    const line = token.map[0] + 1 + env.lineOffset;
    // Raw html_block tokens get the attribute too, but their renderer ignores it (Ruling 65).
    if (token.level === 0 && token.nesting !== -1) token.attrSet('data-source-line', String(line));
    if (token.type === 'heading_open') {
      const text = plainText(state.tokens[i + 1]);
      const id = `h-${slugify(text, env.slugs)}`;
      token.attrSet('id', id);
      env.headings.push({ level: Number(token.tag.slice(1)) as Heading['level'], text, id, line });
    }
  });
});

// Default fences put attributes on <code>; scroll sync needs the line on <pre> (Ruling 65).
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  if (!token) return '';
  const lang = md.utils.unescapeAll(token.info).trim().split(/\s+/)[0] ?? '';
  const line = token.attrGet('data-source-line');
  const lineAttr = line === null ? '' : ` data-source-line="${line}"`;
  if (lang.toLowerCase() === 'mermaid') {
    return `<pre class="mermaid-src"${lineAttr}>${md.utils.escapeHtml(token.content)}</pre>\n`;
  }
  const cls = lang ? `hljs language-${md.utils.escapeHtml(lang)}` : 'hljs';
  return `<pre${lineAttr}><code class="${cls}">${highlightCode(token.content, lang)}</code></pre>\n`;
};

function plainText(inline: Token | undefined): string {
  const parts = (inline?.children ?? []).map((child): string => {
    if (child.type === 'text' || child.type === 'code_inline') return child.content;
    if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
    if (child.type === 'image') return plainText(child);
    return '';
  });
  return parts.join('').trim();
}

// A private instance, so the hook below never leaks into other DOMPurify users.
const purify = DOMPurify(window);

// Task-list checkboxes are the only inputs a document may show (Ruling 67).
purify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName !== 'input') return;
  const type = (node as Element).getAttribute('type');
  if (type?.toLowerCase() !== 'checkbox') node.parentNode?.removeChild(node);
});

// A document must not restyle the app or draw fake UI over it (Rulings 67, 85).
// Anchors a document can still forge (h- ids, line numbers) are untrusted in later steps.
const RENDERER_CLASS = /^(hljs.*|language-.+|task-list-item.*|contains-task-list|mermaid-src)$/;
purify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'class') {
    data.attrValue = data.attrValue.split(/\s+/).filter((c) => RENDERER_CLASS.test(c)).join(' ');
    data.keepAttr = data.attrValue !== '';
  } else if (data.attrName === 'id') {
    data.keepAttr = data.attrValue.startsWith('h-');
  } else if (data.attrName === 'data-source-line') {
    data.keepAttr = /^\d+$/.test(data.attrValue);
  }
});

// SANITIZE_DOM stays on; the h- prefix keeps heading ids clear of it (Ruling 64).
const SANITIZE = {
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'dialog', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style', 'popover'],
  ALLOW_DATA_ATTR: true,
};
