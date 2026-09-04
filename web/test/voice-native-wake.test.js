import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VoiceWakeBroker } from "../src/voice-wake.js";
import { startServer } from "../src/server.js";

test("原生唤醒仅接受白名单、绑定项目并且只能领取一次", () => {
  const broker = new VoiceWakeBroker();
  const id = randomUUID();
  const project = { id: "p1", selectedStepId: "s1", steps: [{ id: "s1", status: "ready" }] };
  assert.throws(() => broker.create({ id, role: "delete" }, project), /无效/);
  assert.throws(() => broker.create({ id: "guess", role: "plan" }, project), /无效/);
  broker.create({ id, role: "execute" }, project);
  assert.deepEqual(broker.create({ id, role: "execute" }, null), { id });
  assert.deepEqual(broker.claim(id), { id, role: "execute", projectId: "p1", stepId: "s1" });
  assert.throws(() => broker.claim(id), /已处理/);
  assert.throws(() => broker.create({ id, role: "review" }, project), /不一致/);
});

test("原生唤醒事件过期并限制容量，审核绑定已有结果", () => {
  let now = 1;
  const broker = new VoiceWakeBroker({ now: () => now, ttl: 10, limit: 1 });
  const id = randomUUID();
  broker.create({ id, role: "review" }, { id: "p", steps: [{ id: "done", result: {} }, { id: "next" }] });
  assert.equal(broker.claim(id).stepId, "done");
  assert.throws(() => broker.create({ id: randomUUID(), role: "plan" }, null), /频繁/);
  now = 12;
  assert.throws(() => broker.claim(id), /过期/);
  assert.ok(broker.create({ id: randomUUID(), role: "plan" }, null));
});

test("后台唤醒接口有会话令牌保护且不直接运行 Agent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-native-wake-"));
  const runtime = await startServer({ port: 0, dataDirectory: directory, workspace: path.join(directory, "workspace") });
  const post = (url, data, token = runtime.token) => fetch(runtime.url + url, {
    method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": token }, body: JSON.stringify(data)
  });
  try {
    const id = randomUUID();
    assert.equal((await post("/api/voice/wake", { id, role: "plan" }, "bad")).status, 403);
    assert.equal((await post("/api/voice/wake", { id, role: "plan" })).status, 201);
    const payload = await (await post(`/api/voice/wake/${id}/claim`, {})).json();
    assert.equal(payload.event.role, "plan");
    assert.equal(payload.event.projectId, null);
    assert.equal(runtime.store.state.projects.length, 0);
    assert.equal((await post(`/api/voice/wake/${id}/claim`, {})).status, 400);
    for (const role of ["new_request", "gather"]) {
      const nextID = randomUUID();
      assert.equal((await post("/api/voice/wake", { id: nextID, role })).status, 201);
      const next = await (await post(`/api/voice/wake/${nextID}/claim`, {})).json();
      assert.equal(next.event.role, role);
    }
    assert.deepEqual(await (await fetch(runtime.url + "/api/agents/presence")).json(), { calls: [] });
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("工作状态接口随真实规划调用进入和退出，失败也会归队", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-presence-"));
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const runtime = await startServer({
    port: 0, dataDirectory: directory, workspace: path.join(directory, "workspace"),
    probeHarness: async () => ({ version: "test" }),
    planWithHarness: async () => { entered(); await held; throw new Error("controlled failure"); }
  });
  const post = (route, body) => fetch(runtime.url + route, { method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": runtime.token }, body: JSON.stringify(body) });
  try {
    const created = await (await post("/api/projects/draft", {})).json();
    const id = created.state.activeProjectId;
    const response = post(`/api/projects/${id}/plan`, { goal: "isolated test" });
    await started;
    const active = await (await fetch(runtime.url + "/api/agents/presence")).json();
    assert.equal(active.calls.length, 1);
    assert.equal(active.calls[0].role, "plan");
    assert.equal(active.calls[0].projectId, id);
    assert.ok(!JSON.stringify(active).includes("isolated test"));
    release();
    assert.equal((await response).status, 400);
    assert.deepEqual(await (await fetch(runtime.url + "/api/agents/presence")).json(), { calls: [] });
  } finally {
    release();
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
