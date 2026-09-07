import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { StateStore } from "../src/store.js";
import { resolveModelRoute } from "../src/smart-routing.js";
import { CODEX_ROLE_PROFILES } from "../public/smart-routing-config.js";

test("role models survive settings API and disk reload; invalid saves leave state intact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-role-settings-"));
  const models = [...new Set([...Object.values(CODEX_ROLE_PROFILES).map(item => item.model), "gpt-6-astra"])].map(model => ({ model, supportedReasoningEfforts: ["low", "high", "xhigh"].map(reasoningEffort => ({ reasoningEffort })) }));
  const runtime = await startServer({ port: 0, dataDirectory: directory, workspace: directory, listCodexModels: async () => models });
  const post = value => fetch(`${runtime.url}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": runtime.token }, body: JSON.stringify(value) });
  try {
    const overrides = { planner: { model: "gpt-6-astra", effort: "high" }, executorBuild: { model: "gpt-5.6-terra", effort: "low" } };
    const saved = await post({ agentRuntime: "codex", smartRouting: true, codexRoleModels: overrides });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).settings.codexRoleModels, overrides);
    const store = new StateStore(path.join(directory, "state.json"), directory);
    await store.load();
    assert.deepEqual(store.state.settings.codexRoleModels, overrides);
    assert.equal(resolveModelRoute({ kind: "route_project", agentRole: "planner" }, store.state.settings).model, "gpt-6-astra");
    const before = runtime.store.snapshot();
    const invalid = await post({ codexRoleModels: { planner: { model: "gpt-6-astra", effort: "unsupported" } } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(runtime.store.snapshot(), before);
    const unavailable = await post({ codexRoleModels: { planner: { model: "missing", effort: "high" } } });
    assert.equal(unavailable.status, 400);
    assert.deepEqual(runtime.store.snapshot(), before);
    await post({ cautionLevel: "high" });
    assert.deepEqual(runtime.store.state.settings.codexRoleModels, overrides);
    const reset = await post({ codexRoleModels: {} });
    assert.equal(reset.status, 200);
    assert.deepEqual(runtime.store.state.settings.codexRoleModels, {});
  } finally {
    await new Promise(resolve => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
