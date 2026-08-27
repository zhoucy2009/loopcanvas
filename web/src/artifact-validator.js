import { access, readFile } from "node:fs/promises";
import path from "node:path";

const resourcePattern = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const inlineModulePattern = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/gi;
const bareThreeImportPattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']three(?:\/addons\/[^"']+)?["']/;

function exactThreeVersion(value) {
  const version = String(value ?? "").trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

export function resolveThreeModuleDependency(dependencies = []) {
  for (const dependency of dependencies) {
    const value = String(dependency ?? "").trim();
    const directVersion = exactThreeVersion(value.match(/^three(?:\.js)?@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|[（(]|$)/i)?.[1]);
    if (directVersion) return { version: directVersion, host: /\bunpkg\b/i.test(value) ? "unpkg.com" : "cdn.jsdelivr.net" };
    let url;
    try { url = new URL(value); } catch { continue; }
    if (!new Set(["cdn.jsdelivr.net", "unpkg.com"]).has(url.hostname)) continue;
    const pathname = decodeURIComponent(url.pathname);
    const match = url.hostname === "cdn.jsdelivr.net"
      ? pathname.match(/^\/npm\/three@([^/]+)(?:\/|$)/)
      : pathname.match(/^\/three@([^/]+)(?:\/|$)/);
    const version = exactThreeVersion(match?.[1]);
    if (version) return { version, host: url.hostname };
  }
  return null;
}

function inlineModulesUseBareThree(html) {
  return [...String(html ?? "").matchAll(inlineModulePattern)].some((match) => bareThreeImportPattern.test(match[1]));
}

function dependencyPackageName(dependency) {
  const value = String(dependency ?? "").trim();
  const match = value.match(/^(@[^/\s]+\/[^@\s]+|[^@\s]+)(?:@[^\s]+)?$/);
  return match?.[1] ?? null;
}

export function isDeclaredCDNResource(resource, dependencies = []) {
  let url;
  try { url = new URL(resource); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const supportedHosts = new Set(["cdn.jsdelivr.net", "unpkg.com"]);
  if (!supportedHosts.has(url.hostname)) return false;
  if (dependencies.some((dependency) => String(dependency ?? "").trim() === resource)) return true;
  const pathname = decodeURIComponent(url.pathname);
  const threeMatch = url.hostname === "cdn.jsdelivr.net"
    ? pathname.match(/^\/npm\/three@([^/]+)(?:\/|$)/)
    : pathname.match(/^\/three@([^/]+)(?:\/|$)/);
  const threeVersion = exactThreeVersion(threeMatch?.[1]);
  if (threeVersion) {
    const declared = resolveThreeModuleDependency(dependencies);
    return declared?.version === threeVersion && declared.host === url.hostname;
  }
  const packages = dependencies.map(dependencyPackageName).filter(Boolean);
  return packages.some((packageName) => {
    const escaped = packageName.split("/").map(encodeURIComponent).join("/");
    const candidates = new Set([packageName, escaped]);
    for (const candidate of candidates) {
      if (url.hostname === "cdn.jsdelivr.net" && (url.pathname.startsWith(`/npm/${candidate}@`) || url.pathname.startsWith(`/npm/${candidate}/`))) return true;
      if (url.hostname === "unpkg.com" && (url.pathname.startsWith(`/${candidate}@`) || url.pathname.startsWith(`/${candidate}/`))) return true;
    }
    return false;
  });
}

export async function validateStepResult(step, result, options = {}) {
  const requiresArtifact = options.requireArtifact ?? ["build", "integrate", "deliver"].includes(step.kind);
  if (requiresArtifact && !result.artifact) throw new Error(`步骤“${step.title}”必须返回完整产物，不能只返回文字总结。`);
  if (!result.evidence?.length) throw new Error("步骤结果缺少可核查证据。");
  if (result.artifact) await validateArtifact(result.artifact, step);
}

export async function validateArtifact(artifact, step) {
  if (!artifact.filename?.trim()) throw new Error("产物缺少入口文件名。");
  if (!artifact.content?.trim() && !artifact.projectRoot) throw new Error("产物既没有完整内容，也没有真实项目目录。");
  let projectRoot = null;
  let entry = null;
  if (artifact.projectRoot) {
    projectRoot = path.resolve(artifact.projectRoot);
    entry = path.resolve(projectRoot, artifact.filename);
    const relative = path.relative(projectRoot, entry);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("产物入口文件超出项目目录。");
    await access(entry).catch(() => { throw new Error(`产物入口文件不存在：${artifact.filename}`); });
    for (const file of artifact.files ?? []) {
      const candidate = path.resolve(projectRoot, file);
      const fileRelative = path.relative(projectRoot, candidate);
      if (fileRelative.startsWith("..") || path.isAbsolute(fileRelative)) throw new Error(`产物文件路径越界：${file}`);
      await access(candidate).catch(() => { throw new Error(`产物清单中的文件不存在：${file}`); });
    }
  }
  if (artifact.kind !== "html") return;
  const html = artifact.content?.trim() || (artifact.projectRoot ? await readFile(path.join(artifact.projectRoot, artifact.filename), "utf8") : "");
  if (/javascript\s*:/i.test(html) || /file\s*:/i.test(html)) throw new Error("HTML 产物包含危险 javascript: 或 file: URL。");
  if (inlineModulesUseBareThree(html) && !resolveThreeModuleDependency(artifact.dependencies)) {
    throw new Error('HTML 使用裸模块导入 "three"，但 dependencies 缺少 three@精确版本或等价的受支持 CDN URL。');
  }
  for (const match of html.matchAll(resourcePattern)) {
    const resource = match[1].trim();
    if (/^https:\/\//i.test(resource) && !isDeclaredCDNResource(resource, artifact.dependencies)) {
      throw new Error(`HTML 引用了未授权的远程资源（未声明依赖或不受支持 CDN）：${resource}`);
    }
    if (/^http:\/\//i.test(resource)) throw new Error(`HTML 使用了不安全的 HTTP 资源：${resource}`);
    if (/^(?:https?:|data:|blob:|#|mailto:|tel:)/i.test(resource) || !artifact.projectRoot) continue;
    const candidate = path.resolve(path.dirname(entry), resource.split(/[?#]/)[0]);
    const relative = path.relative(projectRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`HTML 本地资源路径越界：${resource}`);
    await access(candidate).catch(() => { throw new Error(`HTML 引用的本地资源不存在：${resource}`); });
  }
}
