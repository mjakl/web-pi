import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import haskell from "highlight.js/lib/languages/haskell";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// The one grammar registry. The transcript colours code blocks in the
// browser, the file viewer colours whole files on the server; both talk to
// this module, so a language is registered in exactly one place.

// The grammars pi-web registered, minus the ones highlight.js does not ship.
// Everything else falls back to plain text rather than pulling in a bundle
// nobody reads.
const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dart,
  diff,
  dockerfile,
  elixir,
  go,
  graphql,
  haskell,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  nginx,
  objectivec,
  perl,
  php,
  powershell,
  protobuf,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

const ALIASES: Record<string, string> = {
  docker: "dockerfile",
  git: "diff",
  hcl: "ini",
  html: "xml",
  jsx: "javascript",
  patch: "diff",
  sh: "bash",
  shell: "bash",
  terraform: "ini",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vue: "xml",
  yml: "yaml",
  zsh: "bash",
};

let registered = false;

export function registerLanguages(): void {
  if (registered) return;
  registered = true;
  for (const [name, language] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, language);
  }
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (hljs.getLanguage(target)) {
      hljs.registerAliases(alias, { languageName: target });
    }
  }
}

export function knownLanguage(name: string): boolean {
  registerLanguages();
  return hljs.getLanguage(name) !== undefined;
}

const SPAN = /<\/?span[^>]*>/g;

/**
 * highlight.js colours a whole block, but the file viewer prints one row per
 * line so the gutter and the wrap toggle keep working. Splitting the markup
 * on newlines means closing every open span at the end of a row and
 * reopening it on the next.
 */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  let cursor = 0;
  const addText = (text: string) => {
    const parts = text.split("\n");
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        lines.push(current + "</span>".repeat(open.length));
        current = open.join("");
      }
      current += part;
    }
  };
  SPAN.lastIndex = 0;
  let match = SPAN.exec(html);
  while (match !== null) {
    addText(html.slice(cursor, match.index));
    cursor = SPAN.lastIndex;
    if (match[0].startsWith("</")) open.pop();
    else open.push(match[0]);
    current += match[0];
    match = SPAN.exec(html);
  }
  addText(html.slice(cursor));
  lines.push(current);
  return lines;
}

/** One HTML string per source line, coloured; null when the grammar is not
 *  registered and the caller should escape the text itself. */
export function highlightLines(
  text: string,
  language: string,
): string[] | null {
  if (!knownLanguage(language)) return null;
  const { value } = hljs.highlight(text, { language, ignoreIllegals: true });
  return splitHighlighted(value);
}
