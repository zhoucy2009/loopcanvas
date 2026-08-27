import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 内置插件目录：仓库根目录 plugins/（随 dshwf-web 发布；开发时即本仓库）。
const bundledPluginsRoot = path.resolve(here, "..", "..", "plugins");

const REQUIRED_FIELDS = [
  "schemaVersion", "id", "name", "kind", "category", "package",
  "version", "source", "description", "problem", "audience", "defaultEnabled"
];

async function exists(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

export function validateManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("清单不是 JSON 对象。");
  if (raw.schemaVersion !== 1) throw new Error(`不支持的清单版本：${raw.schemaVersion ?? "缺失"}。`);
  for (const key of REQUIRED_FIELDS) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === "") throw new Error(`清单缺少必填字段 ${key}。`);
  }
  const id = String(raw.id).trim();
  if (!id) throw new Error("清单 id 为空。");
  return { ...raw, id };
}

export const DSH_PLUGIN_RUNTIME_VERSION = "0.1.0-rc.6";

const DSH_HEADLESS_PLUGIN_ROWS = new Map([
  ["@deepseek-ai/dsh-agent-instructions", { version: "0.1.0-rc.6", rowIds: ["agent-instructions"] }],
  ["@deepseek-ai/dsh-command-compact", { version: "0.1.0-rc.6", rowIds: ["command-compact"] }],
  ["@deepseek-ai/dsh-compaction-basic", { version: "0.1.0-rc.6", rowIds: ["compaction-basic"] }],
  ["@deepseek-ai/dsh-compaction-tool-result-pruner", { version: "0.1.0-rc.6", rowIds: ["tool-result-pruner"] }],
  ["@deepseek-ai/cordis-plugin-hmr", { version: "1.0.16", rowIds: ["hmr"] }],
  ["@deepseek-ai/cordis-plugin-timer", { version: "1.1.3", rowIds: ["timer"] }],
  ["@deepseek-ai/dsh-plan-mode", { version: "0.1.0-rc.6", rowIds: ["plan-mode"] }],
  ["@deepseek-ai/dsh-skill-filesystem", { version: "0.1.0-rc.6", rowIds: ["skill-filesystem"] }],
  ["@deepseek-ai/dsh-tool-bash", { version: "0.1.0-rc.6", rowIds: ["tool-bash"] }],
  ["@deepseek-ai/dsh-tool-fs", { version: "0.1.0-rc.6", rowIds: ["tool-fs"] }],
  ["@deepseek-ai/dsh-tool-fs-search", { version: "0.1.0-rc.6", rowIds: ["tool-fs-search"] }],
  ["@deepseek-ai/dsh-tool-goal", { version: "0.1.0-rc.6", rowIds: ["tool-goal"] }],
  ["@deepseek-ai/dsh-tool-jobs", { version: "0.1.0-rc.6", rowIds: ["tool-jobs"] }],
  ["@deepseek-ai/dsh-tool-pwsh", { version: "0.1.0-rc.6", rowIds: ["tool-pwsh"] }],
  ["@deepseek-ai/dsh-tool-ralph", { version: "0.1.0-rc.6", rowIds: ["tool-ralph"] }],
  ["@deepseek-ai/dsh-tool-skill", { version: "0.1.0-rc.6", rowIds: ["tool-skill"] }],
  ["@deepseek-ai/dsh-tool-str-replace-editor", { version: "0.1.0-rc.6", rowIds: ["tool-str-replace-editor"] }],
  ["@deepseek-ai/dsh-tool-subagent", { version: "0.1.0-rc.6", rowIds: ["tool-subagent", "tool-subagent-fork"] }],
  ["@deepseek-ai/dsh-tool-subagent-control", { version: "0.1.0-rc.6", rowIds: ["tool-subagent-control"] }],
  ["@deepseek-ai/dsh-tool-todo", { version: "0.1.0-rc.6", rowIds: ["tool-todo"] }],
  ["@deepseek-ai/dsh-tool-web", { version: "0.1.0-rc.6", rowIds: ["tool-web"] }],
  ["@deepseek-ai/dsh-tool-workflow", { version: "0.1.0-rc.6", rowIds: ["tool-workflow"] }],
  ["@deepseek-ai/dsh-workflow-worker-thread", { version: "0.1.0-rc.6", rowIds: ["workflow-worker-thread"] }]
]);

function pluginRuntime(manifest, runtimeStates) {
  const mapping = DSH_HEADLESS_PLUGIN_ROWS.get(manifest.package);
  if (!mapping) {
    const preset = String(manifest.package).startsWith("preset:");
    return {
      supported: false, profile: "headless", dshVersion: DSH_PLUGIN_RUNTIME_VERSION, state: "unsupported", rowIds: [],
      reason: preset ? "Agent 模式是完整 preset，不能作为单个 headless 插件同步。" : `当前 dsh ${DSH_PLUGIN_RUNTIME_VERSION} headless 配置中没有已验证的对应插件行。`
    };
  }
  if (mapping.version !== manifest.version) {
    return {
      supported: false, profile: "headless", dshVersion: DSH_PLUGIN_RUNTIME_VERSION, state: "unsupported", rowIds: [],
      reason: `清单版本 ${manifest.version} 与已验证版本 ${mapping.version} 不一致。`
    };
  }
  const explicit = Object.prototype.hasOwnProperty.call(runtimeStates, manifest.id);
  return {
    supported: true, profile: "headless", dshVersion: DSH_PLUGIN_RUNTIME_VERSION,
    state: explicit ? (runtimeStates[manifest.id] ? "enabled" : "disabled") : "inherited",
    rowIds: [...mapping.rowIds], reason: null
  };
}

async function scanDirectory(root, runtimeStates) {
  const items = [];
  if (!(await exists(root))) return items;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const folder = entry.name;
    const manifestPath = path.join(root, folder, "plugin.json");
    try {
      const raw = JSON.parse(await readFile(manifestPath, "utf8"));
      const manifest = validateManifest(raw);
      items.push({
        id: manifest.id,
        path: manifestPath,
        manifest,
        runtime: pluginRuntime(manifest, runtimeStates)
      });
    } catch (error) {
      items.push({ id: folder, path: manifestPath, manifest: null, error: error.message });
    }
  }
  return items;
}

/**
 * 列出插件目录：内置 plugins/ 与用户数据目录 plugins/ 合并，用户同名 id 覆盖内置。
 * @param {{ dataDirectory: string, runtimeStates?: Record<string, boolean> }} options
 */
export async function listPlugins({ dataDirectory, runtimeStates = {} }) {
  const [bundled, user] = await Promise.all([
    scanDirectory(bundledPluginsRoot, runtimeStates),
    scanDirectory(path.join(dataDirectory, "plugins"), runtimeStates)
  ]);
  const byId = new Map();
  for (const item of bundled) if (item.manifest) byId.set(item.manifest.id, item);
  for (const item of user) if (item.manifest) byId.set(item.manifest.id, item);
  const items = [...byId.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, "zh-CN"));
  return { items, runtimeStates };
}

export async function buildDshPluginPatch({ dataDirectory, runtimeStates = {} }) {
  const entries = Object.entries(runtimeStates);
  if (!entries.length) return "";
  const { items } = await listPlugins({ dataDirectory, runtimeStates });
  const byId = new Map(items.map((item) => [item.id, item]));
  const lines = [];
  for (const [id, enabled] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof enabled !== "boolean") throw new Error(`插件 ${id} 的同步状态不是布尔值。`);
    const item = byId.get(id);
    if (!item?.manifest) throw new Error(`插件 ${id} 不存在。`);
    if (!item.runtime.supported) throw new Error(`插件 ${item.manifest.name} 无法同步：${item.runtime.reason}`);
    for (const rowId of item.runtime.rowIds) lines.push(`- id: ${rowId}`, `  disabled: ${enabled ? "false" : "true"}`);
  }
  return `${lines.join("\n")}\n`;
}

export { bundledPluginsRoot };
