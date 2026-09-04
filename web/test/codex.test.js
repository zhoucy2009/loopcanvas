import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeCodex, listCodexModels } from "../src/codex.js";

const DEFAULT_MODELS = [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", description: "Fake model", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "medium", description: "Balanced" }] }];

async function writeFakeCodex(directory, models = DEFAULT_MODELS, { silentTelemetry = false } = {}) {
  const executable = path.join(directory, "codex");
  await writeFile(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const models = ${JSON.stringify(models)};
let threadCwd = "";
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: models, nextCursor: null } });
  if (${silentTelemetry} && ["account/usage/read", "account/rateLimits/read"].includes(message.method)) return;
  if (message.method === "account/usage/read") return send({ id: message.id, result: { summary: { lifetimeTokens: 9000 } } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: { primary: { usedPercent: 25, resetsAt: 2000000000 } } } });
  if (message.method === "thread/start") {
    threadCwd = message.params.cwd;
    return send({ id: message.id, result: { thread: { id: "thread-test" } } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-test" } } });
    if (message.params.model === "gpt-fail") {
      send({ method: "item/completed", params: { item: { id: "failed-command", type: "commandExecution", status: "failed", error: { message: "命令执行失败", additionalDetails: { reason: "网络解析失败", code: "DNS_LOOKUP" } } } } });
      return send({ method: "turn/completed", params: { turn: { id: "turn-test", status: "failed", error: { message: "Agent execution failed" } } } });
    }
    const text = JSON.stringify({ model: message.params.model, effort: message.params.effort, sandbox: message.params.sandboxPolicy.type, networkAccess: message.params.sandboxPolicy.networkAccess, cwd: threadCwd });
    send({ method: "item/started", params: { item: { id: "command-test", type: "commandExecution", command: "npm test" } } });
    send({ method: "item/completed", params: { item: { id: "progress", type: "agentMessage", phase: "commentary", text: "模型已写入，正在验证" } } });
    send({ method: "item/completed", params: { item: { id: "unknown", type: "futureItem" } } });
    send({ method: "item/reasoning/textDelta", params: { delta: "private reasoning" } });
    send({ method: "turn/plan/updated", params: { plan: [{ step: "检查模型网格", status: "inProgress" }] } });
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
    assert.deepEqual(readonly, { model: "gpt-test", effort: "low", sandbox: "readOnly", networkAccess: true, cwd: directory });
    const events = [];
    const writable = JSON.parse(await invokeCodex({ id: "write", kind: "execute_step" }, settings, { workspace: directory }, undefined, (event) => events.push(event)));
    assert.deepEqual(writable, { model: "gpt-test", effort: "low", sandbox: "workspaceWrite", networkAccess: true, cwd: directory });
    const continuous = JSON.parse(await invokeCodex({ id: "continuous", kind: "execute_project" }, settings, { workspace: directory }));
    assert.deepEqual(continuous, { model: "gpt-test", effort: "low", sandbox: "workspaceWrite", networkAccess: true, cwd: directory });
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

test("智能规划面对不存在的项目目录时使用已存在的只读临时 cwd 且不创建目标", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-codex-readonly-cwd-"));
  const workspace = path.join(directory, "missing-project");
  try {
    const codexPath = await writeFakeCodex(directory, [{
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }]
    }]);
    const result = JSON.parse(await invokeCodex(
      { id: "planner", kind: "route_project", agentRole: "planner", smartRouting: true },
      { codexPath, workspace, agentRuntime: "codex", smartRouting: true },
      { workspace }
    ));
    assert.equal(await stat(workspace).then(() => true, () => false), false);
    assert.equal(await stat(result.cwd).then((info) => info.isDirectory(), () => false), true);
    assert.notEqual(path.resolve(result.cwd), path.resolve(workspace));
    assert.equal(result.sandbox, "readOnly");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("智能路由在模型目录未声明任何推理强度时拒绝调用", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-codex-empty-efforts-"));
  try {
    const codexPath = await writeFakeCodex(directory, [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", supportedReasoningEfforts: [] }]);
    await assert.rejects(
      () => invokeCodex(
        { id: "planner", kind: "route_project", agentRole: "planner", smartRouting: true },
        { codexPath, workspace: directory, agentRuntime: "codex", smartRouting: true },
        { workspace: directory }
      ),
      /模型目录未明确包含.*high/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("智能路由在模型目录明确不支持所需推理强度时拒绝调用", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-codex-unsupported-effort-"));
  try {
    const codexPath = await writeFakeCodex(directory, [{
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }]
    }]);
    await assert.rejects(
      () => invokeCodex(
        { id: "planner", kind: "route_project", agentRole: "planner", smartRouting: true },
        { codexPath, workspace: directory, agentRuntime: "codex", smartRouting: true },
        { workspace: directory }
      ),
      /模型目录未明确包含.*high/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("完成结果不等待无响应的可选用量接口，活动不泄漏推理文本", { timeout: 8000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-codex-telemetry-"));
  try {
    const codexPath = await writeFakeCodex(directory, DEFAULT_MODELS, { silentTelemetry: true });
    const events = [];
    const result = JSON.parse(await invokeCodex({ id: "write", kind: "execute_step" },
      { codexPath, workspace: directory, codexModel: "gpt-test" }, { workspace: directory }, undefined, event => events.push(event)));
    assert.equal(result.model, "gpt-test");
    assert.ok(events.some(event => event.activity === "模型已写入，正在验证"));
    assert.ok(events.some(event => event.activity === "正在执行：检查模型网格"));
    assert.ok(events.some(event => event.type === "heartbeat"));
    assert.ok(!JSON.stringify(events).includes("private reasoning"));
    assert.ok(!events.some(event => event.activity === "Codex 正在分析当前子进程"));
    assert.equal(events.filter(event => event.type === "metrics").at(-1).metrics.remainingPercent, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
