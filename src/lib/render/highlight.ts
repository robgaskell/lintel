import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// Each module brings its aliases: ts, js, sh, html (xml), toml (ini).
const LANGUAGES = { bash, css, diff, go, ini, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml };
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

/** Highlighted, HTML-escaped code; plain escaped code for a language it does not know. */
export function highlightCode(code: string, lang: string): string {
  const language = lang.toLowerCase();
  if (!language || !hljs.getLanguage(language)) return escapeHtml(code);
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
