import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PROJECT_DOCUMENTS = new Set(["AGENTS.md", "宪法.md"]);
const LEGACY_AGENTS_RULE = "- 只处理当前步骤；不得代替用户验收，也不得自行推进后续步骤。";
const ADAPTIVE_AGENTS_RULE = "- 严格遵守本次请求声明的任务边界：一步直达可在同次调用完成；执行图节点调用只处理当前节点；不得把固定拆步当成完成本身。";
const LEGACY_CONSTITUTION_RULE = "1. 人类门控：计划、方案与执行结果一律由用户选择和验收；模型不得自我确认完成。";
const ADAPTIVE_CONSTITUTION_RULE = "1. 人类门控：目标方向不明确时必须暂停询问；并行节点需按用户选择执行；方向明确且验证通过的节点可自动推进，不得把模型自评冒充客观证据。";

async function exists(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

export async function findAgentsDocument(workspace) {
  let cursor = path.resolve(workspace);
  const root = path.parse(cursor).root;
  while (true) {
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
      const candidate = path.join(cursor, name);
      if (await exists(candidate)) return candidate;
    }
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }
  return null;
}

export async function readAgentsDocument(workspace) {
  const filePath = await findAgentsDocument(workspace);
  return filePath ? { path: filePath, content: await readFile(filePath, "utf8") } : { path: null, content: "" };
}

export async function saveAgentsDocument(workspace, expectedPath, content) {
  const actual = await findAgentsDocument(workspace);
  if (!actual || path.resolve(expectedPath) !== path.resolve(actual)) throw new Error("AGENTS.md 路径已变化，请重新载入。");
  await writeFile(actual, String(content), "utf8");
  return readAgentsDocument(workspace);
}

export function projectDocumentPaths(workspace) {
  return {
    agents: path.join(workspace, "AGENTS.md"),
    constitution: path.join(workspace, "宪法.md")
  };
}

export function agentsTemplate(project = {}) {
  const directives = (project.directives ?? [])
    .filter((directive) => ["required", "forbidden"].includes(directive.strength))
    .map((directive) => `- [${directive.strength === "required" ? "必须" : "禁止"}] ${directive.text}`).join("\n") || "- 无额外硬约束";
  return [
    `# AGENTS.md — ${project.title ?? "未命名项目"}`,
    "",
    "## 项目目标",
    project.goal ?? "",
    "",
    "## 硬约束（必须落实）",
    directives,
    "",
    "## 工作守则",
    "- 所有文件创建、编辑与命令执行必须位于本项目工作目录内。",
    "- 每个完成声明必须附文件、命令输出、渲染结果或其他客观证据。",
    ADAPTIVE_AGENTS_RULE,
    "- 制作、集成与交付步骤必须返回可预览的完整产物。",
    ""
  ].join("\n");
}

export function constitutionTemplate() {
  return [
    "# 项目宪法（不可违反的底线规则）",
    "",
    ADAPTIVE_CONSTITUTION_RULE,
    "2. 证据优先：任何“完成”必须有可核查的客观证据；文字总结、自评或计划本身不能冒充执行证据。",
    "3. 目录边界：不得在本项目工作目录之外创建、修改文件或执行命令。",
    "4. 浏览器与外部操作：只使用当前环境实际提供且已获授权的工具；可用隔离的无头浏览器验证本地产物，不得擅自启动用户的常用浏览器、读取私人登录资料或绕过审批。",
    "5. 凭证保护：不得读取、输出或保存 API Key 等敏感凭证。",
    "6. 透明失败：失败必须报告具体阻断问题与原因，不得掩盖、编造成功或跳过验证。",
    ""
  ].join("\n");
}

async function writeFileIfMissing(filePath, content) {
  try { await access(filePath); } catch { await writeFile(filePath, content, { mode: 0o600 }); }
}

async function migrateGeneratedProjectRule(filePath, { headingPrefix, legacyRule, adaptiveRule }) {
  const content = await readFile(filePath, "utf8").catch(() => "");
  if (!content.startsWith(headingPrefix) || !content.includes(legacyRule)) return false;
  await writeFile(filePath, content.replaceAll(legacyRule, adaptiveRule), { mode: 0o600 });
  return true;
}

export async function ensureProjectDocuments({ workspace, project = {} }) {
  await mkdir(workspace, { recursive: true });
  const paths = projectDocumentPaths(workspace);
  await writeFileIfMissing(paths.agents, agentsTemplate(project));
  await writeFileIfMissing(paths.constitution, constitutionTemplate());
  await migrateGeneratedProjectRule(paths.agents, {
    headingPrefix: "# AGENTS.md — ",
    legacyRule: LEGACY_AGENTS_RULE,
    adaptiveRule: ADAPTIVE_AGENTS_RULE
  });
  await migrateGeneratedProjectRule(paths.constitution, {
    headingPrefix: "# 项目宪法（不可违反的底线规则）",
    legacyRule: LEGACY_CONSTITUTION_RULE,
    adaptiveRule: ADAPTIVE_CONSTITUTION_RULE
  });
  return paths;
}

export async function readProjectDocuments(workspace) {
  const paths = projectDocumentPaths(workspace);
  const read = async (filePath) => {
    try { return await readFile(filePath, "utf8"); } catch { return ""; }
  };
  return { agents: await read(paths.agents), constitution: await read(paths.constitution) };
}

export async function saveProjectDocument(workspace, name, content) {
  if (!PROJECT_DOCUMENTS.has(name)) throw new Error("不支持的项目规则文件。");
  const filePath = path.join(workspace, name);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, String(content), { mode: 0o600 });
  const documents = await readProjectDocuments(workspace);
  return { name, content: documents[name === "AGENTS.md" ? "agents" : "constitution"] };
}

function capabilityName(candidate, marker, detail) {
  const directoryName = path.basename(path.dirname(candidate));
  if (marker !== "plugin.json") return directoryName;
  try {
    const manifest = JSON.parse(detail);
    const manifestName = manifest.name ?? manifest.displayName ?? manifest.display_name ?? manifest.id;
    if (manifestName !== undefined && String(manifestName).trim()) return String(manifestName).trim();
  } catch {
    // Keep malformed manifests visible under a stable directory-based fallback.
  }
  return directoryName === ".codex-plugin"
    ? path.basename(path.dirname(path.dirname(candidate)))
    : directoryName;
}

async function walkForMarker(root, marker, maximum, output) {
  if (output.length >= maximum || !(await exists(root))) return;
  const queue = [root];
  while (queue.length && output.length < maximum) {
    const directory = queue.shift();
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(candidate);
      if (entry.isFile() && entry.name === marker) {
        const info = await stat(candidate);
        const detail = info.size <= 512 * 1024 ? await readFile(candidate, "utf8").catch(() => "（无法读取内容）") : "（文件过大，未读取）";
        output.push({ id: candidate, name: capabilityName(candidate, marker, detail), path: candidate, detail });
      }
      if (output.length >= maximum) break;
    }
  }
}

export async function scanCapabilities(kind, workspace, { homeDirectory = os.homedir() } = {}) {
  const home = homeDirectory;
  const output = [];
  if (kind === "skills") {
    for (const root of [path.join(workspace, ".agents", "skills"), path.join(home, ".agents", "skills"), path.join(home, ".codex", "skills")]) {
      await walkForMarker(root, "SKILL.md", 200, output);
    }
  } else if (kind === "plugins") {
    await walkForMarker(path.join(home, ".codex", "plugins"), "plugin.json", 200, output);
  } else {
    throw new Error("能力类型无效。");
  }
  return output;
}
