#!/usr/bin/env node
// 从 plugins/<id>/plugin.json 生成 plugins/<id>/README.md（简介文档）。
// 用法：node Scripts/generate-plugin-readmes.mjs
// plugin.json 是唯一事实来源；README.md 由本脚本生成，保持两者同步。

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginsRoot = path.resolve(here, "..", "plugins");

const categoryLabels = {
  "agent-preset": "官方 Agent 模式",
  shell: "Shell 与命令",
  filesystem: "文件与编辑",
  retrieval: "检索与信息",
  execution: "执行与控制",
  delegation: "委派与协作",
  planning: "计划与目标",
  context: "上下文与压缩",
  identity: "身份与指令",
  presentation: "工具呈现",
  framework: "框架与运行时"
};

const kindLabels = {
  "agent-preset": "Agent 模式（preset）",
  tool: "工具",
  skill: "技能",
  system: "系统组件",
  service: "服务",
  "cordis-plugin": "Cordis 框架插件",
  presentation: "呈现组件"
};

async function main() {
  const entries = (await readdir(pluginsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  let generated = 0;
  for (const id of entries) {
    const manifestPath = path.join(pluginsRoot, id, "plugin.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue; // 没有清单的目录（如隐藏目录）跳过
    }
    const category = categoryLabels[manifest.category] ?? manifest.category;
    const kind = kindLabels[manifest.kind] ?? manifest.kind;
    const enabled = manifest.defaultEnabled ? "默认启用" : "默认关闭（需手动启用）";
    const lines = [
      `# ${manifest.name}（${manifest.id}）`,
      "",
      `> ${kind} · ${category} · ${enabled}`,
      "",
      "## 这个插件在干什么",
      "",
      manifest.description,
      "",
      "## 解决什么问题",
      "",
      manifest.problem,
      "",
      "## 推荐使用人群",
      "",
      manifest.audience,
      "",
      "## 元信息",
      "",
      `- **包 / preset**：\`${manifest.package}\``,
      `- **版本**：${manifest.version}`,
      `- **来源**：${manifest.source}`,
      `- **许可证**：${manifest.license ?? "未标注"}${manifest.author ? ` · 作者：${manifest.author}` : ""}`,
      ...(manifest.usage ? [`- **在哪里生效**：${manifest.usage}`] : []),
      ...(manifest.tags?.length ? [`- **标签**：${manifest.tags.join("、")}`] : []),
      "",
      "---",
      "",
      "本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。"
    ];
    await writeFile(path.join(pluginsRoot, id, "README.md"), `${lines.join("\n")}\n`, "utf8");
    generated += 1;
  }
  console.log(`已生成 ${generated} 个插件 README。`);
}

main().catch((error) => {
  console.error(`生成失败：${error.message}`);
  process.exit(1);
});
