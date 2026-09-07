import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_MODELS,
  resolveModelRoute,
  roleForRequest,
  smartRoutingEnabled
} from "../src/smart-routing.js";
import { scopeContextForRole } from "../src/harness.js";
import { CODEX_ROLE_PROFILES, normalizeCodexRoleModels, validateCodexRoleCatalog } from "../public/smart-routing-config.js";

test("every smart role accepts an independent model and reasoning effort", () => {
  const codexRoleModels = Object.fromEntries(Object.keys(CODEX_ROLE_PROFILES).map(key => [key, { model: `gpt-custom-${key}`, effort: "medium" }]));
  const settings = { agentRuntime: "codex", codexRoleModels };
  const kinds = { planner: "route_project", learning: "learning_explain_selection", search: "trusted_public_research", reviewer: "review_step", judge: "review_final", tracer: "trace_preview_source" };
  for (const [role, kind] of Object.entries(kinds)) {
    const route = resolveModelRoute({ kind, agentRole: role }, settings);
    assert.equal(route.model, `gpt-custom-${role}`);
    assert.equal(route.effort, "medium");
  }
  for (const [step, key] of [[{ kind: "build" }, "executorBuild"], [{ kind: "deliver" }, "executorIntegrate"], [{ kind: "deliver", riskLevel: "L2" }, "executorVerify"], [{ kind: "judge" }, "executorVerify"]]) {
    const route = resolveModelRoute({ kind: "execute_step", agentRole: "executor", currentStep: step }, settings);
    assert.equal(route.model, `gpt-custom-${key}`);
  }
  assert.equal(resolveModelRoute({ kind: "route_project", agentRole: "planner" }, { ...settings, smartRouting: false, codexModel: "manual" }).model, "manual");
  assert.equal(resolveModelRoute({ kind: "route_project", agentRole: "planner" }, { ...settings, agentRuntime: "dsh" }).available, false);
});

test("role configuration rejects unknown keys and unavailable model capabilities", () => {
  assert.throws(() => normalizeCodexRoleModels({ executor: { model: "gpt-6-astra", effort: "high" } }), /未知/);
  assert.throws(() => normalizeCodexRoleModels({ planner: { model: "bad model", effort: "high" } }), /格式/);
  assert.throws(() => normalizeCodexRoleModels(JSON.parse('{"__proto__":{"model":"gpt-test"}}')), /未知/);
  const models = [...new Set(Object.values(CODEX_ROLE_PROFILES).map(item => item.model))].map(model => ({ model, supportedReasoningEfforts: ["low", "high", "xhigh"].map(reasoningEffort => ({ reasoningEffort })) }));
  validateCodexRoleCatalog({}, models);
  assert.throws(() => validateCodexRoleCatalog({ planner: { model: "gpt-missing", effort: "high" } }, models), /不可用/);
  assert.throws(() => validateCodexRoleCatalog({ planner: { model: CODEX_MODELS.sol, effort: "max" } }, models), /不支持/);
});

test("角色路由使用稳定的 Codex 模型与默认推理强度", () => {
  assert.deepEqual(resolveModelRoute({ kind: "route_project", agentRole: "planner" }, { agentRuntime: "codex" }), {
    role: "planner", runtime: "codex", model: CODEX_MODELS.sol, effort: "high", selection: "planner",
    routed: true, available: true, fallbackReason: ""
  });
  assert.equal(resolveModelRoute({ kind: "route_project", agentRole: "planner", routePhase: "final" }, { agentRuntime: "codex", codexPlannerFinalEffort: "xhigh" }).effort, "xhigh");
  assert.equal(resolveModelRoute({ kind: "learning_explain_selection", agentRole: "learning" }, { agentRuntime: "codex" }).model, CODEX_MODELS.luna);
  assert.equal(resolveModelRoute({ kind: "trusted_public_research", agentRole: "search" }, { agentRuntime: "codex" }).effort, "low");
  assert.equal(resolveModelRoute({ kind: "review_step", agentRole: "reviewer" }, { agentRuntime: "codex" }).model, CODEX_MODELS.sol);
  assert.equal(resolveModelRoute({ kind: "review_final", agentRole: "judge" }, { agentRuntime: "codex" }).effort, "xhigh");
});

test("executor 根据风险和节点类型确定性选择模型", () => {
  const route = (currentStep) => resolveModelRoute({ kind: "execute_step", agentRole: "executor", currentStep }, { agentRuntime: "codex" });
  assert.equal(route({ kind: "build", riskLevel: "L1" }).model, CODEX_MODELS.luna);
  assert.equal(route({ kind: "integrate", riskLevel: "L1" }).model, CODEX_MODELS.terra);
  assert.equal(route({ kind: "verify", riskLevel: "L1" }).model, CODEX_MODELS.sol);
  assert.equal(route({ kind: "build", riskLevel: "L2" }).model, CODEX_MODELS.sol);
});

test("DSH 保留原模型并明确角色路由不可用及回退原因", () => {
  const route = resolveModelRoute({ kind: "execute_step", agentRole: "executor", currentStep: { kind: "deliver", riskLevel: "L1" } }, {
    agentRuntime: "dsh", model: "deepseek-v4-flash", reasoningEffort: "off"
  });
  assert.equal(route.model, "deepseek-v4-flash");
  assert.equal(route.effort, "off");
  assert.equal(route.available, false);
  assert.match(route.fallbackReason, /DeepSeek Harness/);
  assert.equal(route.requestedModel, CODEX_MODELS.terra);
});

test("上下文按角色隔离并只给执行者当前节点及依赖", () => {
  const items = [
    { kind: "user", stepId: null, content: "goal" },
    { kind: "result", stepId: "a", content: "dependency" },
    { kind: "result", stepId: "b", content: "unrelated" },
    { kind: "result", stepId: "c", content: "excluded" },
    { kind: "system", stepId: null, content: "system" }
  ];
  assert.deepEqual(scopeContextForRole(items, "executor", { stepId: "b", dependencyIds: ["a"] }).map((item) => item.content), ["goal", "dependency", "unrelated"]);
  assert.deepEqual(scopeContextForRole(items, "learning").map((item) => item.content), []);
  assert.equal(roleForRequest({ kind: "learning_explain_selection" }), "learning");
});

test("智能路由对显式角色请求开启，可显式关闭", () => {
  assert.equal(smartRoutingEnabled({}, { kind: "route_project", agentRole: "planner" }), true);
  assert.equal(smartRoutingEnabled({ smartRouting: false }, { kind: "route_project", agentRole: "planner" }), false);
  assert.equal(smartRoutingEnabled({}, { kind: "execute_step", agentRole: "executor" }), true);
  assert.equal(smartRoutingEnabled({}, { kind: "execute_step" }), false);
});

test("规划推理强度只允许 high 或 xhigh，角色与 kind 必须一致", () => {
  assert.equal(resolveModelRoute({ kind: "route_project", agentRole: "planner" }, { agentRuntime: "codex", codexPlannerPlanningEffort: "low" }).effort, "high");
  assert.throws(() => resolveModelRoute({ kind: "execute_step", agentRole: "learning" }, { agentRuntime: "codex" }), /不能处理任务类型/);
});
