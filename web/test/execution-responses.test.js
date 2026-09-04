import assert from "node:assert/strict";
import test from "node:test";
import { setLanguage } from "../public/i18n.js";
setLanguage("zh-CN");
import { ExecutionResponses, settledRuntimeActivity, nodeRuntimeState, runtimeActivityText } from "../public/execution-responses.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const project = (patch = {}) => ({ id: "p", updatedAt: "before", busy: false, steps: [], ...patch });

test("延迟的执行响应可由失败状态结束，不等待原请求或重新提交", async () => {
  const responses = new ExecutionResponses();
  const network = deferred();
  const pending = responses.track("p", project(), network.promise);
  const entry = responses.observe("p", true);
  const state = { projects: [project({ updatedAt: "after", lastError: "校验失败", executionRun: { status: "failed" } })] };
  const rejected = assert.rejects(pending, (error) => error.message === "校验失败" && error.state === state);
  assert.equal(responses.reconcile("p", entry, state), true);
  await rejected;
  assert.equal(responses.pending.size, 0);
  network.resolve({ state: "stale" });
});

test("初始空闲轮询不误判；快速完成或等待方向可恢复原请求", async () => {
  const responses = new ExecutionResponses();
  const pending = responses.track("p", project(), new Promise(() => {}));
  const entry = responses.observe("p", false);
  assert.equal(responses.reconcile("p", entry, { projects: [project()] }), false);
  assert.equal(responses.reconcile("p", entry, { projects: [project({ updatedAt: "after", busy: true })] }), false);
  assert.equal(responses.reconcile("p", entry, { projects: [project({ updatedAt: "after", executionRun: { status: "running" } })] }), false);
  const state = { projects: [project({ updatedAt: "after", executionRun: { status: "awaiting_direction" } })] };
  assert.equal(responses.reconcile("p", entry, state), true);
  assert.deepEqual(await pending, { state });
});

test("旧轮询和旧响应不能结束或移除新请求", async () => {
  const responses = new ExecutionResponses();
  const oldNetwork = deferred();
  const old = responses.track("p", project(), oldNetwork.promise);
  const oldEntry = responses.observe("p", true);
  const nextNetwork = deferred();
  const next = responses.track("p", project({ updatedAt: "new" }), nextNetwork.promise);
  assert.equal(responses.reconcile("p", oldEntry, { projects: [project({ updatedAt: "after" })] }), false);
  oldNetwork.resolve("old");
  assert.equal(await old, "old");
  assert.equal(responses.pending.size, 1);
  nextNetwork.resolve("new");
  assert.equal(await next, "new");
  assert.equal(responses.pending.size, 0);
});

test("停止状态显示错误、取消或完成，不继续显示分析中", () => {
  assert.equal(settledRuntimeActivity(project({ lastError: "文件缺失" })), "执行失败：文件缺失");
  assert.equal(settledRuntimeActivity(project({ isPaused: true, lastError: "旧错误" })), "执行已暂停");
  assert.equal(settledRuntimeActivity(project({ phase: "complete" })), "全部节点已验证并交付");
});


test("首次加载和并行节点不能被误判为中断，实时事件必须匹配项目", () => {
  const project = { id: "p", busy: true };
  const step = { id: "build", status: "running" };
  assert.deepEqual(nodeRuntimeState(project, step, null), { running: true, interrupted: false, live: null });
  assert.equal(nodeRuntimeState(project, step, { projectId: "p", stepId: "other", active: true }).running, true);
  assert.equal(nodeRuntimeState(project, step, { projectId: "other", stepId: "build", active: true }).live, null);
  assert.equal(nodeRuntimeState({ ...project, busy: false }, step, null).interrupted, true);
});

test("事件时间显示真实静默时长，不把无新事件断言为卡死", () => {
  const runtime = { active: true, activity: "运行命令：npm test", updatedAt: "2026-09-04T04:00:00Z" };
  assert.match(runtimeActivityText(runtime, Date.parse("2026-09-04T04:00:02Z")), /最近事件 2 秒前/);
  assert.match(runtimeActivityText(runtime, Date.parse("2026-09-04T04:02:00Z")), /120 秒未收到新事件/);
  assert.equal(runtimeActivityText({ ...runtime, active: false }), runtime.activity);
});
