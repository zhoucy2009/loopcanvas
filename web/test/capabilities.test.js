import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureProjectDocuments } from "../src/capabilities.js";

test("ensureProjectDocuments migrates only exact generated legacy gate rules", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-capabilities-"));
  await writeFile(path.join(workspace, "AGENTS.md"), [
    "# AGENTS.md — 旧项目",
    "",
    "- 只处理当前步骤；不得代替用户验收，也不得自行推进后续步骤。",
    "- 用户自定义规则必须保留。",
    ""
  ].join("\n"));
  await writeFile(path.join(workspace, "宪法.md"), [
    "# 项目宪法（不可违反的底线规则）",
    "",
    "1. 人类门控：计划、方案与执行结果一律由用户选择和验收；模型不得自我确认完成。",
    "2. 用户自定义底线必须保留。",
    ""
  ].join("\n"));

  await ensureProjectDocuments({ workspace, project: { title: "旧项目", goal: "完成任务" } });
  const agents = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
  const constitution = await readFile(path.join(workspace, "宪法.md"), "utf8");

  assert.match(agents, /一步直达可在同次调用完成/);
  assert.match(agents, /用户自定义规则必须保留/);
  assert.doesNotMatch(agents, /只处理当前步骤；不得代替用户验收/);
  assert.match(constitution, /目标方向不明确时必须暂停询问/);
  assert.match(constitution, /用户自定义底线必须保留/);
  assert.doesNotMatch(constitution, /计划、方案与执行结果一律由用户选择和验收/);
});

test("ensureProjectDocuments leaves unrelated user documents untouched", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-capabilities-user-"));
  const custom = "# 我的规则\n\n- 只处理当前步骤；不得代替用户验收，也不得自行推进后续步骤。\n";
  await writeFile(path.join(workspace, "AGENTS.md"), custom);

  await ensureProjectDocuments({ workspace, project: { title: "项目", goal: "完成任务" } });

  assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), custom);
});
