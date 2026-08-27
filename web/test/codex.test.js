import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeCodex, listCodexModels } from "../src/codex.js";

async function writeFakeCodex(directory) {
  const executable = path.join(directory, "codex");
  await writeFile(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", description: "Fake model", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "medium", description: "Balanced" }] }], nextCursor: null } });
  if (message.method === "account/usage/read") return send({ id: message.id, result: { summary: { lifetimeTokens: 9000 } } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: { primary: { usedPercent: 25, resetsAt: 2000000000 } } } });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-test" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-test" } } });
    if (message.params.model === "gpt-fail") {
      send({ method: "item/completed", params: { item: { id: "failed-command", type: "commandExecution", status: "failed", error: { message: "命令执行失败", additionalDetails: { reason: "网络解析失败", code: "DNS_LOOKUP" } } } } });
      return send({ method: "turn/completed", params: { turn: { id: "turn-test", status: "failed", error: { message: "Agent execution failed" } } } });
    }
    const text = JSON.stringify({ model: message.params.model, effort: message.params.effort, sandbox: message.params.sandboxPolicy.type, networkAccess: message.params.sandboxPolicy.networkAccess });
    send({ method: "item/started", params: { item: { id: "command-test", type: "commandExecution", command: "npm test" } } });
    send({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 200, cachedInputTokens: 80, outputTokens: 20, totalTokens: 220 }, total: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, totalTokens: 1200 }, modelContextWindow: 2000 } } });
    send({ method: "item/completed", params: { item: { id: "item-test", type: "agentMessage", text } } });
    return send({ method: "turn/completed", params: { turn: { id: "turn-test", status: "completed" } } });
  }
});
`);
  await chmod(executable, 0o755);
  return executable;
}

test("Codex App Server 动态返回模型与推理强度", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-codex-models-"));
  try {
    const codexPath = await writeFakeCodex(directory);
    const models = await listCodexModels({ codexPath });
    assert.equal(models.length, 1);
    assert.equal(models[0].model, "gpt-test");
    assert.equal(models[0].defaultReasoningEffort, "medium");
    assert.deepEqual(models[0].supportedReasoningEfforts.map((item) => item.reasoningEffort), ["low", "medium"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex transport 传递模型、推理强度并区分只读与写入沙盒", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-codex-invoke-"));
  try {
    const codexPath = await writeFakeCodex(directory);
    const settings = { codexPath, workspace: directory, codexModel: "gpt-test", codexReasoningEffort: "low" };
    const readonly = JSON.parse(await invokeCodex({ id: "read", kind: "plan_first_step" }, settings, { workspace: directory }));
    assert.deepEqual(readonly, { model: "gpt-test", effort: "low", sandbox: "readOnly", networkAccess: true });
    const events = [];
    const writable = JSON.parse(await invokeCodex({ id: "write", kind: "execute_step" }, settings, { workspace: directory }, undefined, (event) => events.push(event)));
    assert.deepEqual(writable, { model: "gpt-test", effort: "low", sandbox: "workspaceWrite", networkAccess: true });
    const continuous = JSON.parse(await invokeCodex({ id: "continuous", kind: "execute_project" }, settings, { workspace: directory }));
    assert.deepEqual(continuous, { model: "gpt-test", effort: "low", sandbox: "workspaceWrite", networkAccess: true });
    assert.ok(events.some((event) => event.activity === "运行命令：npm test"));
    const metrics = events.filter((event) => event.type === "metrics").at(-1).metrics;
    assert.equal(metrics.cumulativeTokens, 9000);
    assert.equal(metrics.cacheHitRate, 0.4);
    assert.equal(metrics.contextPercent, 0.1);
    assert.equal(metrics.remainingPercent, 75);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex 失败会保留 item 的具体原因而不是只返回泛化错误", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-codex-error-"));
  try {
    const codexPath = await writeFakeCodex(directory);
    await assert.rejects(
      () => invokeCodex({ id: "fail", kind: "execute_step" }, { codexPath, workspace: directory, codexModel: "gpt-fail" }, { workspace: directory }),
      /网络解析失败.*DNS_LOOKUP/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
