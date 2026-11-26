import MarkdownIt, { type Token } from 'markdown-it';
import { splitFrontMatter } from './frontMatter';
import { headingText, MARKDOWN_OPTIONS, slugify, type Heading } from './markdown';

// Its own instance: no task lists or source-line rule, which headings do not need.
const parser = new MarkdownIt(MARKDOWN_OPTIONS);

/**
 * The headings `renderMarkdown` would report, with the same ids, for the outline in every
 * mode. Parses blocks, then only the headings' inline text, and never renders (Ruling 107).
 */
export function extractHeadings(src: string): Heading[] {
  const { body, bodyStartLine } = splitFrontMatter(src);
  // Link reference definitions land in env and decide how heading text parses.
  const env = {};
  const tokens: Token[] = [];
  // markdown-it's own normalize step, which block.parse skips.
  parser.block.parse(body.replace(/\r\n?/g, '\n').replace(/\0/g, '�'), parser, env, tokens);

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
