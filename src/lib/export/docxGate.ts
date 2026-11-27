import { keepsLink } from './exportLinks';

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// Fields that load something, or link, when Word updates or the reader clicks them.
const LOADING_FIELDS = /\b(INCLUDEPICTURE|INCLUDETEXT|LINK|DDE|DDEAUTO|IMPORT)\b/;
const HYPERLINK_FIELD = /\bHYPERLINK\s+(?:"([^"]*)"|(\S+))/g;

export const OUTSIDE_CONTENT =
  'This document would make Word load something from outside the file, so Lintel did not export it.';

/**
 * The last check before a .docx is written; whatever the input did, the file it passes links
 * only where keepsLink allows and loads nothing from outside (Ruling 335). An External
 * hyperlink that fails keepsLink is removed and its w:hyperlink unwrapped to plain runs. Any
 * other External relationship, or a field that loads or links outside, throws OUTSIDE_CONTENT.
 * Returns `bytes` itself when nothing was removed.
 */
export async function gateDocx(bytes: Uint8Array): Promise<Uint8Array> {
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import('fflate');
  const files = unzipSync(bytes);
  const changed = new Map<string, Document>();
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith('.rels')) continue;
    const rels = parseXml(strFromU8(data), name);
    const removed = removeUnsafeHyperlinks(rels);
    if (removed.size === 0) continue;
    changed.set(name, rels);
    const source = sourcePartOf(name);
    if (source === null || !files[source]) continue;
    const part = changed.get(source) ?? parseXml(strFromU8(files[source]), source);
    unwrapHyperlinks(part, removed);
    changed.set(source, part);
  }
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('.xml')) checkFields(changed.get(name) ?? parseXml(strFromU8(data), name));
  }
  if (changed.size === 0) return bytes;
  for (const [name, doc] of changed) files[name] = strToU8(serialise(doc, strFromU8(files[name]!)));
  return zipSync(files);
}

/** The Ids of the hyperlinks removed. Throws for any other External relationship. */
function removeUnsafeHyperlinks(rels: Document): Set<string> {
  const removed = new Set<string>();
  for (const rel of [...rels.getElementsByTagNameNS(RELS_NS, 'Relationship')]) {
    if (rel.getAttribute('TargetMode')?.toLowerCase() !== 'external') continue;
    if (!rel.getAttribute('Type')?.endsWith('/hyperlink')) throw new Error(OUTSIDE_CONTENT);
    if (keepsLink(rel.getAttribute('Target') ?? '')) continue;
    removed.add(rel.getAttribute('Id') ?? '');
    rel.remove();
  }
  return removed;
}

function unwrapHyperlinks(part: Document, ids: Set<string>) {
  for (const link of [...part.getElementsByTagNameNS(W_NS, 'hyperlink')]) {
    if (ids.has(link.getAttributeNS(R_NS, 'id') ?? '')) link.replaceWith(...link.childNodes);
  }
}

// Instructions can be split over several runs, so each part's are read as one text.
function checkFields(part: Document) {
  const simple = [...part.getElementsByTagNameNS(W_NS, 'fldSimple')].map((f) => f.getAttributeNS(W_NS, 'instr') ?? '');
  const runs = [...part.getElementsByTagNameNS(W_NS, 'instrText')].map((t) => t.textContent ?? '');
  const instructions = [...simple, runs.join('')].join(' ');
  if (LOADING_FIELDS.test(instructions)) throw new Error(OUTSIDE_CONTENT);
  for (const [, quoted, bare] of instructions.matchAll(HYPERLINK_FIELD)) {
    if (!keepsLink(quoted ?? bare ?? '')) throw new Error(OUTSIDE_CONTENT);
  }
}

// word/_rels/document.xml.rels belongs to word/document.xml; _rels/.rels to the package.
function sourcePartOf(rels: string): string | null {
  const match = /^(.*?)_rels\/([^/]+)\.rels$/.exec(rels);
  return match && match[2] ? `${match[1]}${match[2]}` : null;
}

function parseXml(text: string, name: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error(`The Word file could not be checked (${name}).`);
  return doc;
}

// XMLSerializer leaves out the XML declaration, which Word expects first.
function serialise(doc: Document, original: string): string {
  const declaration = /^<\?xml[^?]*\?>/.exec(original)?.[0] ?? '';
  return declaration + new XMLSerializer().serializeToString(doc);
}
