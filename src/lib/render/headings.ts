import MarkdownIt, { type Env, type Token } from 'markdown-it';
import { splitFrontMatter } from './frontMatter';
import { headingText, MARKDOWN_OPTIONS, slugify, type Heading } from './markdown';

// Its own instance: no task lists or source-line rule, which headings do not need.
const parser = new MarkdownIt(MARKDOWN_OPTIONS);

/**
 * The headings `renderMarkdown` would report, with the same ids, for the outline in every
 * mode. Parses blocks, then only the headings' inline text, and never renders (Ruling 107).
 */
export function extractHeadings(src: string): Heading[] {
  const { tokens, env, bodyStartLine } = parseBlocks(src);
  const slugs = new Map<string, number>();
  const headings: Heading[] = [];
  tokens.forEach((token, i) => {
    if (token.type !== 'heading_open' || !token.map) return;
    const [inline] = parser.parseInline(tokens[i + 1]?.content ?? '', env);
    const text = headingText(inline);
    headings.push({
      level: Number(token.tag.slice(1)) as Heading['level'],
      text,
      id: `h-${slugify(text, slugs)}`,
      line: token.map[0] + bodyStartLine,
    });
  });
  return headings;
}

/**
 * The block tokens of the document after its front matter; inline content stays unparsed.
 * `env` holds the link reference definitions, which decide how inline text parses.
 */
export function parseBlocks(src: string): { tokens: Token[]; env: Env; bodyStartLine: number } {
  const { body, bodyStartLine } = splitFrontMatter(src);
  const env: Env = {};
  const tokens: Token[] = [];
  // markdown-it's own normalize step, which block.parse skips.
  const normalized = body.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
  parser.block.parse(normalized, parser, env, tokens);
  return { tokens, env, bodyStartLine };
}
