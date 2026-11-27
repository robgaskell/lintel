import { keepsLink } from './exportLinks';

// Fields that only number or point within the file. Any other field stops the export.
const SAFE_FIELDS = new Set(['HYPERLINK', 'PAGE', 'NUMPAGES', 'SECTIONPAGES', 'SECTION', 'TOC', 'PAGEREF', 'REF', 'NOTEREF', 'SEQ']);
// A field's words: quoted (straight or curly quotes) or bare.
const FIELD_TOKEN = /[“”„‟"＂]([^“”„‟"＂]*)[“”„‟"＂]?|[^\s“”„‟"＂]+/g;
const FIELD_SWITCH = /^\\[a-z*#@!]$/i;
// A path inside the package, such as media/image1.png. Anything else may name a place outside.
const PART_PATH = /^[\w.~-]+(\/[\w.~-]+)*$/;

export const OUTSIDE_CONTENT =
  'This document would make Word load something from outside the file, so Lintel did not export it.';

/**
 * The last check before a .docx is written; whatever the input did, the file it passes links
 * only where keepsLink allows and loads nothing from outside (Rulings 335, 339). An outside
 * hyperlink that fails keepsLink is removed, with everything that points at it. Any other
 * outside relationship, unknown field, VML link or altChunk throws OUTSIDE_CONTENT.
 * Returns `bytes` itself when nothing was removed.
 */
export async function gateDocx(bytes: Uint8Array): Promise<Uint8Array> {
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import('fflate');
  const files = unzipSync(bytes);
  const parsed = new Map<string, Document>();
  const read = (name: string) => parsed.get(name) ?? parsed.set(name, parseXml(strFromU8(files[name]!), name)).get(name)!;
  const changed = new Set<string>();
  for (const name of Object.keys(files)) {
    if (!/\.rels$/i.test(name)) continue;
    const removed = removeUnsafeHyperlinks(read(name));
    if (removed.size === 0) continue;
    changed.add(name);
    const source = sourcePartOf(name, Object.keys(files));
    if (source === null) continue;
    dropReferences(read(source), removed);
    changed.add(source);
  }
  for (const name of Object.keys(files)) {
    if (/\.(xml|rels)$/i.test(name)) checkPart(read(name));
  }
  if (changed.size === 0) return bytes;
  for (const name of changed) files[name] = strToU8(serialise(read(name), strFromU8(files[name]!)));
  return zipSync(files);
}

/** The Ids of the hyperlinks removed. Throws for any other outside relationship. */
function removeUnsafeHyperlinks(rels: Document): Set<string> {
  const removed = new Set<string>();
  for (const rel of [...rels.getElementsByTagNameNS('*', 'Relationship')]) {
    const target = rel.getAttribute('Target') ?? '';
    const external = rel.getAttribute('TargetMode')?.trim().toLowerCase() === 'external' || !PART_PATH.test(target);
    if (!external) continue;
    if (!rel.getAttribute('Type')?.endsWith('/hyperlink')) throw new Error(OUTSIDE_CONTENT);
    if (keepsLink(target)) continue;
    const id = rel.getAttribute('Id');
    if (id) removed.add(id);
    rel.remove();
  }
  return removed;
}

// A w:hyperlink keeps its text; a picture's link (a:hlinkClick and the like) goes.
function dropReferences(part: Document, ids: Set<string>) {
  for (const el of [...part.getElementsByTagNameNS('*', '*')]) {
    const refs = [...el.attributes].filter((attr) => ids.has(attr.value.trim()));
    if (refs.length === 0) continue;
    if (el.localName === 'hyperlink') el.replaceWith(...el.childNodes);
    else if (el.localName.startsWith('hlink')) el.remove();
    else for (const attr of refs) el.removeAttributeNode(attr);
  }
}

/** Throws if the part has an altChunk, a VML link, or a field that may load or link outside. */
function checkPart(part: Document) {
  // Fields whose instruction is still being read; a field inside one could build its address.
  const open: { instruction: string; done: boolean }[] = [];
  for (const el of part.getElementsByTagNameNS('*', '*')) {
    if (el.localName === 'altChunk') throw new Error(OUTSIDE_CONTENT);
    if ([...el.attributes].some((attr) => attr.localName === 'href' || attr.localName === 'src')) throw new Error(OUTSIDE_CONTENT);
    const top = open.at(-1);
    switch (el.localName) {
      case 'fldSimple':
        checkField(attribute(el, 'instr'));
        break;
      case 'instrText':
      case 'delInstrText':
        if (top && !top.done) top.instruction += el.textContent ?? '';
        else checkField(el.textContent ?? '');
        break;
      case 'fldChar': {
        const type = attribute(el, 'fldCharType').trim().toLowerCase();
        if (type === 'begin') {
          if (top && !top.done) throw new Error(OUTSIDE_CONTENT);
          open.push({ instruction: '', done: false });
        } else if (type === 'separate') {
          if (top) top.done = true;
        } else if (type === 'end') {
          if (top) checkField(open.pop()!.instruction);
        } else {
          throw new Error(OUTSIDE_CONTENT);
        }
      }
    }
  }
  for (const field of open) checkField(field.instruction);
}

// Field names are not case sensitive. Every word of a HYPERLINK but its switches must be a safe link.
function checkField(instruction: string) {
  const words = [...instruction.matchAll(FIELD_TOKEN)].map(([word, quoted]) => quoted ?? word);
  if (words.length === 0) return;
  const name = words[0]!.toUpperCase();
  if (!SAFE_FIELDS.has(name)) throw new Error(OUTSIDE_CONTENT);
  if (name === 'HYPERLINK' && words.slice(1).some((word) => !FIELD_SWITCH.test(word) && !keepsLink(word))) {
    throw new Error(OUTSIDE_CONTENT);
  }
}

function attribute(el: Element, localName: string): string {
  return [...el.attributes].find((attr) => attr.localName === localName)?.value ?? '';
}

// word/_rels/document.xml.rels belongs to word/document.xml; _rels/.rels to the package.
// Part names are not case sensitive.
function sourcePartOf(rels: string, names: string[]): string | null {
  const match = /^(.*?)_rels\/([^/]+)\.rels$/i.exec(rels);
  if (!match) return null;
  const source = `${match[1]}${match[2]}`.toLowerCase();
  return names.find((name) => name.toLowerCase() === source) ?? null;
}

function parseXml(text: string, name: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error(`The Word file could not be checked (${name}).`);
  return doc;
}

// WebKit's and Chromium's XMLSerializer write a declaration and jsdom's does not; Word expects one.
function serialise(doc: Document, original: string): string {
  const declaration = /^\uFEFF?(<\?xml[^?]*\?>)/.exec(original)?.[1] ?? '';
  return declaration + new XMLSerializer().serializeToString(doc).replace(/^\s*<\?xml[^?]*\?>/, '');
}
