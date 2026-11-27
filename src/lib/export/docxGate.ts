import { keepsLink } from './exportLinks';

// Fields that only number or point within the file. Any other field stops the export.
const SAFE_FIELDS = new Set(['HYPERLINK', 'PAGE', 'NUMPAGES', 'SECTIONPAGES', 'SECTION', 'TOC', 'PAGEREF', 'REF', 'NOTEREF', 'SEQ']);
// A field's words: quoted (straight or curly quotes) or bare.
const FIELD_TOKEN = /[“”„‟"＂]([^“”„‟"＂]*)[“”„‟"＂]?|[^\s“”„‟"＂]+/g;
const FIELD_SWITCH = /^\\[a-z*#@!]$/i;
// A path inside the package, such as media/image1.png. Anything else may name a place outside.
const PART_PATH = /^[\w.~-]+(\/[\w.~-]+)*$/;
// Elements that make Word take in content, read a data source or resolve links from elsewhere.
const OUTSIDE_ELEMENTS = new Set(['altChunk', 'mailMerge', 'odso', 'udl', 'HyperlinkBase']);

export const OUTSIDE_CONTENT =
  'This document would make Word load something from outside the file, so Lintel did not export it.';

/**
 * The last check before a .docx is written (Rulings 335, 339, 340). For packages remark-docx and
 * docx produce, whatever the input did, the file it passes links only where keepsLink allows and
 * loads nothing from outside; hand-made packages may hold parts it does not read, so recheck
 * after a remark-docx or docx upgrade. An unsafe outside hyperlink is removed, with everything
 * that points at it; any other outside reference throws. Returns `bytes` itself when unchanged.
 */
export async function gateDocx(bytes: Uint8Array): Promise<Uint8Array> {
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import('fflate');
  const files = unzipSync(bytes);
  const parsed = new Map<string, Document>();
  const read = (name: string) => parsed.get(name) ?? parsed.set(name, parseXml(strFromU8(files[name]!), name)).get(name)!;
  checkPartNames(Object.keys(files), read);
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
    const inside = PART_PATH.test(target) && !target.split('/').includes('..');
    const external = rel.getAttribute('TargetMode')?.trim().toLowerCase() === 'external' || !inside;
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

/** Throws if the part has an element, link or field that may load or link outside. */
function checkPart(part: Document) {
  // Fields whose instruction is still being read; a field inside one could build its address.
  const open: { instruction: string; done: boolean }[] = [];
  for (const el of part.getElementsByTagNameNS('*', '*')) {
    if (OUTSIDE_ELEMENTS.has(el.localName)) throw new Error(OUTSIDE_CONTENT);
    if ([...el.attributes].some((attr) => attr.localName === 'href' || attr.localName === 'src')) throw new Error(OUTSIDE_CONTENT);
    const top = open.at(-1);
    switch (el.localName) {
      case 'fldSimple':
        if (top && !top.done) throw new Error(OUTSIDE_CONTENT);
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

/** Throws for a part Word reads as XML whose name the scans here skip. */
function checkPartNames(names: string[], read: (name: string) => Document) {
  const typesName = names.find((name) => name.toLowerCase() === '[content_types].xml');
  if (!typesName) return;
  const byExtension = contentTypes(read(typesName), 'Default', 'Extension');
  const byName = contentTypes(read(typesName), 'Override', 'PartName');
  for (const name of names) {
    if (/\.(xml|rels)$/i.test(name)) continue;
    const extension = /\.([^./]*)$/.exec(name)?.[1] ?? '';
    const type = byName.get(`/${name}`.toLowerCase()) ?? byExtension.get(extension.toLowerCase()) ?? '';
    if (/[/+]xml$/i.test(type.trim())) throw cannotCheck(name);
  }
}

// Extensions and part names are not case sensitive.
function contentTypes(types: Document, tag: string, key: string): Map<string, string> {
  const entries = [...types.getElementsByTagNameNS('*', tag)].map((el) => [el.getAttribute(key)?.toLowerCase() ?? '', el.getAttribute('ContentType') ?? ''] as const);
  return new Map(entries);
}

function parseXml(text: string, name: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw cannotCheck(name);
  return doc;
}

function cannotCheck(name: string): Error {
  return new Error(`The Word file could not be checked (${name}).`);
}

// WebKit's and Chromium's XMLSerializer write a declaration and jsdom's does not; Word expects one.
function serialise(doc: Document, original: string): string {
  const declaration = /^\uFEFF?(<\?xml[^?]*\?>)/.exec(original)?.[1] ?? '';
  return declaration + new XMLSerializer().serializeToString(doc).replace(/^\s*<\?xml[^?]*\?>/, '');
}
