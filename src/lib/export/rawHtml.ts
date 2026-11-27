import type { Html, Nodes, Parent, Root, RootContent } from 'mdast';
import { classifyImageSrc } from '../render/links';
import { dataUriToBytes } from './bytes';
import { keepsLink } from './exportLinks';

/** Registers an SVG's bytes and returns the address remark-docx will load them from. */
export type InlineSvg = (svg: Uint8Array) => string;

// remark-docx joins a paragraph's inline nodes, raw HTML included, into one HTML string for
// docx/html; children of these parents are not joined.
const UNJOINED = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);
const JOINED = new Set([
  'html', 'text', 'break', 'strong', 'emphasis', 'delete', 'inlineCode',
  'link', 'linkReference', 'image', 'imageReference', 'inlineMath',
]);
// Text in these is not shown, or is markup, so it is left out when HTML becomes text.
const HIDDEN = new Set(['script', 'style', 'template', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes', 'textarea', 'title']);

/**
 * The first layer of the Word export's link and image rules; the output gate is the second
 * (Rulings 324, 325, 330, 335). Unsafe links (see keepsLink) become their text, and a
 * reference uses its first definition, as remark-docx does. Raw HTML is checked as
 * docx/html will read it: joined with its paragraph's other inline nodes. Where that reading
 * finds the same links, images and SVGs as each node read alone, each node is fixed on its
 * parsed tree; otherwise the paragraph's raw HTML becomes its visible text.
 */
export function makeRawHtmlSafe(tree: Root, inline: InlineSvg) {
  unlinkUnsafe(tree);
  walk(tree, (node) => {
    if (!('children' in node)) return;
    const parent = node as Parent;
    if (UNJOINED.has(parent.type)) {
      for (const child of parent.children) if (child.type === 'html') checkGroup([child], true, inline);
    } else {
      mergeAdjacentHtml(parent);
      for (const group of joinedGroups(parent.children)) checkGroup(group, false, inline);
    }
  });
  dropEmptyBlocks(tree);
}

function unlinkUnsafe(tree: Root) {
  const definitions = new Map<string, string>();
  walk(tree, (node) => {
    if (node.type !== 'definition') return;
    const key = node.identifier.toUpperCase();
    if (!definitions.has(key)) definitions.set(key, node.url);
  });
  replaceEach(tree, (node) => {
    if (node.type === 'link' && !keepsLink(node.url)) return node.children;
    if (node.type === 'linkReference') {
      const url = definitions.get(node.identifier.toUpperCase());
      if (url !== undefined && !keepsLink(url)) return node.children;
    }
    return null;
  });
}

// Tags split over adjacent nodes, such as an inline <svg>, are whole again in one node.
function mergeAdjacentHtml(parent: Parent) {
  const merged: RootContent[] = [];
  for (const child of parent.children) {
    const last = merged.at(-1);
    if (child.type === 'html' && last?.type === 'html') last.value += child.value;
    else merged.push(child);
  }
  parent.children = merged;
}

// Runs of nodes remark-docx joins, keeping only runs with raw HTML in them.
function joinedGroups(children: RootContent[]): RootContent[][] {
  const groups: RootContent[][] = [[]];
  for (const child of children) {
    if (isJoined(child)) groups.at(-1)!.push(child);
    else groups.push([]);
  }
  return groups.filter((group) => group.some((node) => htmlIn(node).length > 0));
}

function isJoined(node: Nodes): boolean {
  return JOINED.has(node.type) && (!('children' in node) || node.children.every(isJoined));
}

function checkGroup(group: RootContent[], block: boolean, inline: InlineSvg) {
  const nodes = group.flatMap(htmlIn);
  const whole = readHtml(group.map(joinedText).join(''));
  const alone = nodes.map((node) => readHtml(node.value));
  const same = whole.consistent && alone.every((r) => r.consistent) && sameList(whole.found, alone.flatMap((r) => r.found));
  for (const node of nodes) {
    const safe = same ? safeRawHtml(node.value, inline) : null;
    if (safe !== null) node.value = safe;
    else asText(node, block);
  }
}

/**
 * One raw HTML node with unsafe hrefs removed, remote and off-device images as their alt
 * text, and inline SVGs and SVG data: images as pictures loaded through `inline` (PNG only
 * in Word). Changes are made on the parsed tree, which is written back out only if writing
 * and reading it again gives the same HTML. Null when the node must become text instead.
 */
function safeRawHtml(html: string, inline: InlineSvg): string | null {
  if (!/href|src|<svg/i.test(html)) return html;
  const root = readHtml(html).root;
  let changed = false;
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (attr.localName !== 'href' || keepsLink(attr.value)) continue;
      el.removeAttributeNode(attr);
      changed = true;
    }
  }
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (/^\s*data:/i.test(src)) {
      if (!/^\s*data:image\/svg\+xml/i.test(src)) continue;
      const svg = svgBytes(src);
      if (svg) img.setAttribute('src', inline(svg));
      else img.replaceWith(img.alt);
    } else if (classifyImageSrc(src.trim()) === 'remote' || !keepsLink(src)) {
      img.replaceWith(img.alt);
    } else {
      continue;
    }
    changed = true;
  }
  for (const svg of root.querySelectorAll('svg')) {
    if (svg.parentElement?.closest('svg')) continue;
    const img = document.createElement('img');
    img.setAttribute('src', inline(new TextEncoder().encode(new XMLSerializer().serializeToString(svg))));
    img.setAttribute('alt', svg.getAttribute('aria-label') ?? '');
    svg.replaceWith(img);
    changed = true;
  }
  if (!changed) return html;
  const out = serialise(root);
  return serialise(readHtml(out).root) === out ? out : null;
}

interface Reading {
  root: DocumentFragment;
  /** Each link, image and SVG the parser found, as text, in document order. */
  found: string[];
  /** Whether the parser found as many hrefs, images and SVGs as the text spells. */
  consistent: boolean;
}

// The browser's parser follows the same HTML standard as docx/html's.
function readHtml(html: string): Reading {
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  const elements = [...root.querySelectorAll('*')];
  const hrefs = elements.flatMap((el) => [...el.attributes].filter((a) => a.localName === 'href'));
  const images = root.querySelectorAll('img');
  const svgs = root.querySelectorAll('svg');
  const found = elements
    .filter((el) => el.localName === 'svg' || el.localName === 'img' || el.hasAttribute('href'))
    .map((el) => (el.localName === 'svg' ? el.outerHTML : `<${el.localName} ${[...el.attributes].map((a) => `${a.name}=${a.value}`).join(' ')}>`));
  const consistent =
    hrefs.length === count(html, /href/gi) && images.length === count(html, /<img/gi) && svgs.length === count(html, /<svg/gi);
  return { root, found, consistent };
}

// What remark-docx joins, as far as raw HTML is concerned: other nodes are plain text.
function joinedText(node: Nodes): string {
  if (node.type === 'html') return node.value;
  if ('children' in node) return node.children.map(joinedText).join('');
  return 'x';
}

function htmlIn(node: Nodes): Html[] {
  if (node.type === 'html') return [node];
  return 'children' in node ? node.children.flatMap(htmlIn) : [];
}

const dropped = new WeakSet<Nodes>();

// In a paragraph the HTML becomes a text node; on its own, a paragraph, or nothing if empty.
function asText(node: Html, block: boolean) {
  const text = visibleText(readHtml(node.value).root);
  const changed = node as unknown as Record<string, unknown>;
  delete changed.value;
  if (block) Object.assign(changed, { type: 'paragraph', children: [{ type: 'text', value: text }] });
  else Object.assign(changed, { type: 'text', value: text });
  if (block && text.trim() === '') dropped.add(node);
}

function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element && HIDDEN.has(node.localName)) return '';
  if (node instanceof Element && node.localName === 'img') return node.getAttribute('alt') ?? '';
  return [...node.childNodes].map(visibleText).join('');
}

function dropEmptyBlocks(tree: Root) {
  walk(tree, (node) => {
    if ('children' in node) (node as Parent).children = (node as Parent).children.filter((child) => !dropped.has(child));
  });
}

function serialise(root: DocumentFragment): string {
  const holder = document.createElement('template');
  holder.content.append(root.cloneNode(true));
  return holder.innerHTML;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function svgBytes(dataUri: string): Uint8Array | null {
  try {
    return dataUriToBytes(dataUri.trim());
  } catch {
    return null;
  }
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Visits every node below `node`; when `replace` returns nodes, they take the visited node's place. */
function replaceEach(node: Nodes, replace: (node: Nodes) => RootContent[] | null) {
  if (!('children' in node)) return;
  const parent = node as Parent;
  parent.children = parent.children.flatMap((child) => {
    const replaced = replace(child);
    if (replaced === null) {
      replaceEach(child, replace);
      return [child];
    }
    for (const kept of replaced) replaceEach(kept, replace);
    return replaced;
  });
}

function walk(node: Nodes, visit: (node: Nodes) => void) {
  visit(node);
  if ('children' in node) for (const child of node.children) walk(child, visit);
}
