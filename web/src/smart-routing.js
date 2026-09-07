/**
 * Deterministic role routing for the Codex transport.
 *
 * DSH has no equivalent model identifiers, so callers must keep its configured
 * model and receive an explicit fallback marker instead of pretending that a
 * Sol/Terra/Luna route was used.
 */

import { codexRoleProfile, executorProfileKey } from "../public/smart-routing-config.js";

const CODEX_MODELS = Object.freeze({
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna"
});

const PLANNER_EFFORTS = new Set(["high", "xhigh"]);

export const SMART_ROLE_PROMPTS = Object.freeze({
  planner: "你是计划者。只读分析原始目标、硬约束与必要参考，产出一至十二个真实执行节点、依赖和可检验标准；即使只有一个节点也不得实现、修改文件或宣称交付。",
  executor: "你是执行者。继承原始要求、锁定交付契约、全部上游用户决定和依赖证据；按当前节点的 writeScope 与 acceptanceCriteria 实施和验证，不读取无关角色对话，不推进未来节点，也不得批准自己的结果。",
  learning: "你是学习讲解者。只依据当前源码材料与学习对话，用低成本清晰解释；禁止创建、修改、删除文件，禁止把讲解伪装成执行完成。",
  search: "你是搜索研究者。只做公开网络检索、来源核验和比较；必须区分事实、推断与未知，没有真实来源时如实失败，不修改项目文件。",
  reviewer: "你是独立步骤审核者。只读复核磁盘现状、节点验收标准和可复查证据；执行者摘要只是待验证声明。只给出 pass、repair 或 blocked 裁决，不修文件、不替执行者补做工作。",
  judge: "你是最终裁决者。只读核对原始目标、主交付物标准、所有最新步骤审核结论和最终证据；只给出 pass、repair 或 blocked，不修改文件，不继承执行者的角色假设。",
  tracer: "你是源码追溯者。只在服务端给定候选中依据可观察证据定位，不修改文件，不读取无关对话，也不凭视觉猜测。"
});

export const SMART_ROUTING_POLICY = "智能路由已启用：本次规划调用只负责读取目标、约束和已有状态并返回真实执行 Graph；不得创建、修改或删除项目文件，不得返回 single 直达结果。";

function normalizedRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  return Object.hasOwn(SMART_ROLE_PROMPTS, role) ? role : "";
}

export function roleForRequest(request = {}) {
  const explicit = normalizedRole(request.agentRole ?? request.role);
  if (explicit) return explicit;
  const kind = String(request.kind ?? "");
  if (kind === "route_project") return "planner";
  if (["execute_step", "execute_project"].includes(kind)) return "executor";
  if (kind.startsWith("learning_")) return "learning";
  if (["trusted_public_research", "visual_art_research"].includes(kind)) return "search";
  if (kind === "trace_preview_source") return "tracer";
  return "";
}

const ROLE_KINDS = Object.freeze({
  planner: new Set(["route_project", "custom_workflow_generate"]),
  executor: new Set(["execute_step", "execute_project", "custom_workflow_execute"]),
  learning: new Set(["learning_follow_up", "learning_explain_document", "learning_explain_selection", "learning_repository_document_overviews"]),
  search: new Set(["trusted_public_research", "visual_art_research"]),
  reviewer: new Set(["review_step"]),
  judge: new Set(["review_final"]),
  tracer: new Set(["trace_preview_source"])
});

export function assertRoleMatchesKind(role, kind) {
  if (role && kind && !ROLE_KINDS[role]?.has(String(kind))) throw new Error(`Agent 角色 ${role} 不能处理任务类型 ${kind}。`);
}

function configuredPlannerEffort(settings, request) {
  const phase = String(request.routePhase ?? request.planningPhase ?? "planning").toLowerCase();
  const configured = phase === "final"
    ? settings.codexPlannerFinalEffort ?? settings.codexPlannerFinalReasoningEffort
    : settings.codexPlannerPlanningEffort ?? settings.codexPlannerPlanningReasoningEffort;
  return PLANNER_EFFORTS.has(String(configured ?? "")) ? String(configured) : "high";
}

function executorRoute(request, settings) {
  const step = request.currentStep ?? request.step ?? {};
  const key = executorProfileKey({ riskLevel: step.riskLevel ?? request.riskLevel, kind: step.kind ?? request.stepKind });
  const selection = { executorVerify: "risk-or-verification", executorIntegrate: "integration-or-delivery", executorBuild: "low-risk-build" }[key];
  return { ...codexRoleProfile(key, settings), selection };
}

function codexRoute(request, settings, role = roleForRequest(request)) {
  if (role === "executor") return executorRoute(request, settings);
  const profile = codexRoleProfile(role, settings);
  if (profile) {
    if (role === "planner" && !settings.codexRoleModels?.planner) profile.effort = configuredPlannerEffort(settings, request);
    return { ...profile, selection: role };
  }
  return null;
}

/** Return the effective route without mutating request or settings. */
export function resolveModelRoute(request = {}, settings = {}) {
  // Keep direct callers that only supplied the historical `kind` field fully
  // backward compatible. All LoopCanvas request builders add agentRole.
  const routingRequested = Boolean(String(request.agentRole ?? request.role ?? "").trim())
    || request.routingEnabled === true || request.smartRouting === true;
  const role = routingRequested ? roleForRequest(request) : "";
  assertRoleMatchesKind(role, request.kind);
  const codex = settings.smartRouting === false ? null : codexRoute(request, settings, role);
  const runtime = settings.agentRuntime === "codex" ? "codex" : "dsh";
  if (!codex) {
    return {
      role: role || "legacy",
      runtime,
      model: runtime === "codex" ? String(settings.codexModel ?? "").trim() : String(settings.model ?? "").trim(),
      effort: runtime === "codex" ? String(settings.codexReasoningEffort ?? "").trim() : String(settings.reasoningEffort ?? "").trim(),
      routed: false,
      available: true,
      fallbackReason: settings.smartRouting === false ? "智能路由已关闭，使用手动模型设置。" : "没有明确角色，沿用既有全局模型设置。"
    };
  }
  if (runtime === "codex") return { role, runtime, ...codex, routed: true, available: true, fallbackReason: "" };
  return {
    role,
    runtime,
    model: String(settings.model ?? "").trim(),
    effort: String(settings.reasoningEffort ?? "").trim(),
    requestedRuntime: "codex",
    requestedModel: codex.model,
    requestedEffort: codex.effort,
    routed: true,
    available: false,
    fallbackReason: "当前执行引擎是 DeepSeek Harness；智能路由角色模型仅可由 Codex App Server 提供。"
  };
}

export function smartRoutingEnabled(settings = {}, request = {}) {
  const requested = Boolean(String(request.agentRole ?? request.role ?? "").trim()) || request.routingEnabled === true || request.smartRouting === true;
  return requested && settings.smartRouting !== false;
}

export { CODEX_MODELS };
