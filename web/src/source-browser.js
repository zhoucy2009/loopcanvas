import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const ignoredDirectories = new Set([
  ".git", ".hg", ".svn", ".build", ".next", ".nuxt", ".turbo", "build", "coverage",
  "dist", "node_modules", "Pods", "DerivedData", "target", "vendor"
]);
const sourceExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".ex", ".exs", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".json", ".kt", ".kts", ".lua", ".md", ".mjs", ".php", ".py", ".rb",
  ".rs", ".scala", ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".vue", ".xml",
  ".yaml", ".yml", ".zsh"
]);
const specialSourceNames = new Set(["Dockerfile", "Gemfile", "Makefile", "Package.swift", "Rakefile"]);
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SELECTION_LINES = 240;
const MAX_SELECTION_BYTES = 80 * 1024;
const MAX_DOCUMENT_LINES = 4_000;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_TRACE_CANDIDATES = 8;

function sourceLanguage(filename) {
  const extension = path.extname(filename).toLowerCase().slice(1);
  const aliases = { cc: "cpp", h: "cpp", hpp: "cpp", mjs: "javascript", js: "javascript", jsx: "javascript", py: "python", rb: "ruby", rs: "rust", sh: "shell", zsh: "shell", ts: "typescript", tsx: "typescript", yml: "yaml" };
  return aliases[extension] ?? (extension || "text");
}

export function isSupportedSourceFile(name) {
  return specialSourceNames.has(name) || sourceExtensions.has(path.extname(name).toLowerCase());
}

function resolveWithin(root, relativePath) {
  const boundary = path.resolve(root);
  const requested = String(relativePath ?? "").replaceAll("\\", "/");
  if (!requested || path.isAbsolute(requested)) throw new Error("源码路径无效。");
  const candidate = path.resolve(boundary, requested);
  const relative = path.relative(boundary, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("源码路径超出项目工作目录。");
  return { boundary, candidate, relative: relative.split(path.sep).join("/") };
}

export async function listSourceFiles(root, { limit = 1_500 } = {}) {
  const boundary = path.resolve(root);
  const rootInfo = await stat(boundary).catch(() => null);
  if (!rootInfo?.isDirectory()) return [];
  const files = [];
  const visit = async (directory, prefix = "") => {
    if (files.length >= limit) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith(".")) await visit(path.join(directory, entry.name), relative);
      } else if (entry.isFile() && isSupportedSourceFile(entry.name)) {
        files.push(relative);
      }
    }
  };
  await visit(boundary);
  return files;
}

export async function readSourceFile(root, relativePath) {
  const resolved = resolveWithin(root, relativePath);
  const info = await lstat(resolved.candidate).catch(() => null);
  if (!info?.isFile() || !isSupportedSourceFile(path.basename(resolved.candidate))) throw new Error("源码文件不存在或类型不受支持。");
  if (info.size > MAX_SOURCE_BYTES) throw new Error("源码文件超过 1 MiB，请拆分后学习。");
  const content = await readFile(resolved.candidate, "utf8");
  if (content.includes("\0")) throw new Error("二进制文件不能作为源码学习材料。");
  return { path: resolved.relative, content, language: sourceLanguage(resolved.relative), lineCount: content.split("\n").length, sizeBytes: info.size };
}

export async function readSourceSelection(root, relativePath, startLine, endLine) {
  const source = await readSourceFile(root, relativePath);
  const lines = source.content.split("\n");
  const start = Math.max(1, Number.parseInt(startLine, 10) || 1);
  const end = Math.min(lines.length, Number.parseInt(endLine, 10) || start);
  if (end < start) throw new Error("源码选择范围无效。");
  if (end - start + 1 > MAX_SELECTION_LINES) throw new Error(`一次最多解释 ${MAX_SELECTION_LINES} 行代码。`);
  const code = lines.slice(start - 1, end).join("\n");
  if (Buffer.byteLength(code) > MAX_SELECTION_BYTES) throw new Error("选中代码超过 80 KiB，请缩小范围。");
  return { filePath: source.path, language: source.language, startLine: start, endLine: end, code };
}

function escapedPattern(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedElement(input = {}) {
  return {
    tag: String(input.tag ?? "").trim().toLowerCase().slice(0, 40),
    id: String(input.id ?? "").trim().slice(0, 160),
    classes: Array.isArray(input.classes) ? input.classes.map((item) => String(item).trim()).filter(Boolean).slice(0, 12) : [],
    text: String(input.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
    attributes: input.attributes && typeof input.attributes === "object"
      ? Object.fromEntries(Object.entries(input.attributes).slice(0, 12).map(([key, value]) => [String(key).slice(0, 80), String(value).slice(0, 160)]))
      : {}
  };
}

function normalizedTraceTarget(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const hasNestedElement = raw.element && typeof raw.element === "object";
  return {
    kind: String(raw.kind ?? (hasNestedElement ? "dom" : "")).trim().toLowerCase().slice(0, 40),
    groupId: String(raw.groupId ?? raw.group_id ?? "").trim().slice(0, 320),
    traceId: String(raw.traceId ?? raw.trace_id ?? "").trim().slice(0, 240),
    label: String(raw.label ?? raw.objectName ?? raw.object_name ?? "").trim().slice(0, 160),
    objectName: String(raw.objectName ?? raw.object_name ?? "").trim().slice(0, 160),
    objectPath: Array.isArray(raw.objectPath ?? raw.object_path) ? (raw.objectPath ?? raw.object_path).map((item) => String(item).trim()).filter(Boolean).slice(-12) : [],
    element: normalizedElement(hasNestedElement ? raw.element : raw)
  };
}

function targetMatchScore(line, target) {
  let score = 0;
  const signals = [];
  const names = [...new Set([target.objectName, ...target.objectPath].filter((item) => item && item.length >= 2))];
  for (const name of names) {
    if (line.toLowerCase().includes(name.toLowerCase())) { score += name === target.objectName ? 24 : 6; signals.push(`object=${name}`); }
  }
  if (target.label.length >= 2 && line.toLowerCase().includes(target.label.toLowerCase())) { score += 12; signals.push(`label=${target.label}`); }
  return { score, signals };
}

function lineMatchScore(line, element) {
  let score = 0;
  const signals = [];
  if (element.id) {
    const id = escapedPattern(element.id);
    if (new RegExp(`(?:id\\s*=\\s*["']${id}["']|#${id}\\b)`, "i").test(line)) { score += 14; signals.push(`id=${element.id}`); }
  }
  for (const className of element.classes) {
    const token = escapedPattern(className);
    if (new RegExp(`(?:class(?:Name)?\\s*=.*\\b${token}\\b|\\.${token}\\b)`, "i").test(line)) { score += 5; signals.push(`class=${className}`); }
  }
  if (element.tag && new RegExp(`<${escapedPattern(element.tag)}\\b`, "i").test(line)) { score += 2; signals.push(`tag=${element.tag}`); }
  const textNeedle = element.text.slice(0, 48);
  if (textNeedle.length >= 4 && line.toLowerCase().includes(textNeedle.toLowerCase())) { score += 8; signals.push("text"); }
  for (const [name, value] of Object.entries(element.attributes)) {
    if (!name.startsWith("data-") && !["name", "role", "aria-label", "title", "type"].includes(name)) continue;
    if (value && line.toLowerCase().includes(value.toLowerCase())) { score += 3; signals.push(`${name}=${value}`); }
  }
  return { score, signals };
}

function sourceCandidate(source, lineIndex, score, signals) {
  const lines = source.content.split("\n");
  const startIndex = Math.max(0, lineIndex - 3);
  const endIndex = Math.min(lines.length, lineIndex + 4);
  return {
    path: source.path,
    language: source.language,
    startLine: startIndex + 1,
    endLine: endIndex,
    code: lines.slice(startIndex, endIndex).join("\n"),
    score,
    signals: [...new Set(signals)]
  };
}

export async function findPreviewSourceCandidates(artifact, rawElement, { limit = MAX_TRACE_CANDIDATES } = {}) {
  if (!artifact) throw new Error("当前项目没有可回溯的产物源码。");
  const target = normalizedTraceTarget(rawElement);
  const element = target.element;
  if (!target.traceId && !target.objectName && !target.label && !element.tag && !element.id && !element.classes.length && !element.text) throw new Error("预览目标缺少可用于回溯的线索。");
  const sources = [];
  if (artifact.projectRoot) {
    const manifest = [...new Set([artifact.filename, ...(artifact.files ?? [])].filter(Boolean))];
    for (const relativePath of manifest) {
      if (!isSupportedSourceFile(path.basename(relativePath))) continue;
      const source = await readSourceFile(artifact.projectRoot, relativePath).catch(() => null);
      if (source) sources.push(source);
    }
  } else if (artifact.content) {
    sources.push({ path: artifact.filename || "index.html", content: String(artifact.content), language: sourceLanguage(artifact.filename || "index.html") });
  }
  if (!sources.length) throw new Error("当前产物清单中没有可读取的源码文件。");
  const candidates = [];
  for (const source of sources) {
    const lines = source.content.split("\n");
    for (const [lineIndex, line] of lines.entries()) {
      const matched = lineMatchScore(line, element);
      const targetMatched = targetMatchScore(line, target);
      matched.score += targetMatched.score;
      matched.signals.push(...targetMatched.signals);
      if (target.traceId && line.includes(target.traceId)) {
        matched.score += 100;
        matched.signals.unshift(`traceId=${target.traceId}`);
      }
      if (matched.score > 0) candidates.push(sourceCandidate(source, lineIndex, matched.score, matched.signals));
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.startLine - right.startLine);
  if (!candidates.length) {
    const entry = sources.find((source) => source.path === artifact.filename) ?? sources[0];
    return [sourceCandidate(entry, 0, 0, ["artifact-entry-fallback"])];
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.path}:${candidate.startLine}:${candidate.endLine}`;
    if (!seen.has(key)) { seen.add(key); unique.push(candidate); }
    if (unique.length >= Math.max(1, Math.min(Number(limit) || MAX_TRACE_CANDIDATES, MAX_TRACE_CANDIDATES))) break;
  }
  return unique;
}

export async function readSourceDocument(root, relativePath) {
  const source = await readSourceFile(root, relativePath);
  if (source.lineCount > MAX_DOCUMENT_LINES) throw new Error(`完整学习一次最多分析 ${MAX_DOCUMENT_LINES} 行，请先拆分文件。`);
  if (Buffer.byteLength(source.content) > MAX_DOCUMENT_BYTES) throw new Error("完整学习文件不能超过 256 KiB，请先拆分文件。");
  return {
    filePath: source.path, language: source.language, startLine: 1,
    endLine: source.lineCount, code: source.content
  };
}

function utf8Excerpt(content, maximumBytes) {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maximumBytes) return { content, truncated: false, includedBytes: bytes.length };
  const excerpt = bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/u, "");
  return { content: excerpt, truncated: true, includedBytes: Buffer.byteLength(excerpt) };
}

export async function buildRepositoryOverviewDocuments(root, { maxFiles = 500, maxExcerptBytes = 8 * 1024 } = {}) {
  const files = await listSourceFiles(root, { limit: maxFiles + 1 });
  if (files.length > maxFiles) throw new Error(`仓库包含超过 ${maxFiles} 个支持的代码文档，请缩小仓库后再生成概要。`);
  const documents = [];
  let originalBytes = 0;
  let includedBytes = 0;
  let truncatedFiles = 0;
  for (const filePath of files) {
    const source = await readSourceFile(root, filePath);
    const excerpt = utf8Excerpt(source.content, maxExcerptBytes);
    originalBytes += source.sizeBytes;
    includedBytes += excerpt.includedBytes;
    if (excerpt.truncated) truncatedFiles += 1;
    documents.push({
      path: source.path, language: source.language, lineCount: source.lineCount, sizeBytes: source.sizeBytes,
      contentExcerpt: excerpt.content, truncated: excerpt.truncated
    });
  }
  const batches = Math.ceil(documents.length / 20);
  const estimatedInputTokens = Math.ceil(includedBytes / 3);
  const estimatedOutputTokens = documents.length * 160;
  return {
    documents,
    estimate: { fileCount: documents.length, originalBytes, includedBytes, truncatedFiles, batches, estimatedTokens: estimatedInputTokens + estimatedOutputTokens }
  };
}

export function parseGitHubRepositoryURL(value) {
  let url;
  try { url = new URL(String(value ?? "").trim()); } catch { throw new Error("请输入有效的 GitHub 仓库地址。"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") throw new Error("只支持公开的 github.com HTTPS 仓库地址。");
  if (url.username || url.password || url.port) throw new Error("GitHub 仓库地址不能包含账号凭据或自定义端口。");
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("GitHub 地址必须是 https://github.com/<owner>/<repo>。");
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub 仓库名称包含不支持的字符。");
  return { owner, repository, url: `https://github.com/${owner}/${repository}.git`, webURL: `https://github.com/${owner}/${repository}` };
}
