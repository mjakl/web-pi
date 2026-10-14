// What a path is: the language a viewer highlights it as, whether it is media
// the browser can play, the MIME type a download carries, and the icon the
// explorer draws. Extension-only, as pi-web does; content sniffing would need
// a read before the containment check has run.

export type FileKind = "image" | "audio" | "pdf" | "text";

/** A Map, so a name like `notes.constructor` cannot find `Object.prototype`. */
function byExtension<T>(entries: Record<string, T>): Map<string, T> {
  return new Map(Object.entries(entries));
}

const IMAGE_MIME = byExtension({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
});

const AUDIO_MIME = byExtension({
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
});

const DOCUMENT_MIME = byExtension({
  pdf: "application/pdf",
});

const LANGUAGE = byExtension({
  bash: "bash",
  c: "c",
  cc: "cpp",
  cfg: "ini",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  csv: "text",
  cxx: "cpp",
  dart: "dart",
  diff: "diff",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  graphql: "graphql",
  gql: "graphql",
  h: "c",
  hcl: "hcl",
  hpp: "cpp",
  hs: "haskell",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  nginx: "nginx",
  m: "objectivec",
  patch: "diff",
  pdf: "pdf",
  php: "php",
  pl: "perl",
  proto: "protobuf",
  ps1: "powershell",
  py: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  tf: "hcl",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  txt: "text",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
});

export function baseName(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.at(-1) ?? path;
}

/** Lowercased text after the last dot, empty when the name has none. */
export function extensionOf(path: string): string {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/** The grammar a viewer highlights with; "text" when nothing matches. */
export function languageOf(path: string): string {
  const name = baseName(path).toLowerCase();
  if (name.startsWith("dockerfile")) return "dockerfile";
  if (name.startsWith(".env")) return "bash";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  if (name === "cmakelists.txt") return "makefile";
  return LANGUAGE.get(extensionOf(path)) ?? "text";
}

export function fileKind(path: string): FileKind {
  const extension = extensionOf(path);
  if (IMAGE_MIME.has(extension)) return "image";
  if (AUDIO_MIME.has(extension)) return "audio";
  if (extension === "pdf") return "pdf";
  return "text";
}

/** The MIME a raw response carries; octet-stream for anything unknown. */
export function mimeOf(path: string): string {
  const extension = extensionOf(path);
  return (
    IMAGE_MIME.get(extension) ??
    AUDIO_MIME.get(extension) ??
    DOCUMENT_MIME.get(extension) ??
    "application/octet-stream"
  );
}

/** Markdown and HTML are worth showing rendered rather than as source. */
export function hasPreview(path: string): boolean {
  const language = languageOf(path);
  return language === "markdown" || language === "html";
}

// --- Catppuccin file icons -------------------------------------------------
//
// Which of the vendored Catppuccin SVGs a file name draws, as pi-web's
// `getFileIcon` decides it. The mapping lives in the core because two of its
// readers run in the browser and cannot import a view: the `@` completion
// menu builds its rows off the local file index, and the file panel draws its
// tab strip. All three have to reach the same answer.

export type CatppuccinIconName =
  | "_file"
  | "_folder"
  | "_folder_open"
  | "bash"
  | "bun-lock"
  | "config"
  | "css"
  | "database"
  | "docker"
  | "env"
  | "eslint"
  | "git"
  | "go"
  | "graphql"
  | "html"
  | "javascript"
  | "javascript-react"
  | "json"
  | "lock"
  | "markdown"
  | "next"
  | "npm-lock"
  | "pdf"
  | "python"
  | "rust"
  | "sass"
  | "terraform"
  | "toml"
  | "typescript"
  | "typescript-react"
  | "yaml";

const CATPPUCCIN_BY_EXTENSION = byExtension<CatppuccinIconName>({
  ts: "typescript",
  tsx: "typescript-react",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript-react",
  py: "python",
  json: "json",
  jsonl: "json",
  css: "css",
  less: "css",
  scss: "sass",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  rs: "rust",
  go: "go",
  sql: "database",
  graphql: "graphql",
  gql: "graphql",
  tf: "terraform",
  hcl: "terraform",
  pdf: "pdf",
  lock: "lock",
});

const ESLINT_CONFIGS = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  "eslint.config.mjs",
  "eslint.config.js",
];

const NEXT_CONFIGS = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
];

function specialCatppuccinIcon(name: string): CatppuccinIconName | undefined {
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "docker";
  if (name === ".env" || name.startsWith(".env.")) return "env";
  if ([".gitignore", ".gitattributes", ".gitmodules"].includes(name)) {
    return "git";
  }
  if (name === "package-lock.json") return "npm-lock";
  if (name === "bun.lock") return "bun-lock";
  if (NEXT_CONFIGS.includes(name)) return "next";
  if (ESLINT_CONFIGS.includes(name)) return "eslint";
  if (["yarn.lock", "pnpm-lock.yaml", "cargo.lock"].includes(name)) {
    return "lock";
  }
  if (/\.config\.(ts|js|mjs|cjs)$/.test(name)) return "config";
  return undefined;
}

/** The icon for a file name: a special name first, then the extension. */
export function catppuccinIcon(path: string): CatppuccinIconName {
  const lower = baseName(path).toLowerCase();
  return (
    specialCatppuccinIcon(lower) ??
    CATPPUCCIN_BY_EXTENSION.get(extensionOf(lower)) ??
    "_file"
  );
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${String(bytes)} B`;
}
