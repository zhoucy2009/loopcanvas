// Shared by the settings UI and server so previews and actual calls agree.
export const CODEX_ROLE_PROFILES = Object.freeze({
  planner: { label: "规划者", model: "gpt-5.6-sol", effort: "high" },
  learning: { label: "学习讲解", model: "gpt-5.6-luna", effort: "low" },
  search: { label: "搜索研究", model: "gpt-5.6-luna", effort: "low" },
  reviewer: { label: "步骤审核", model: "gpt-5.6-sol", effort: "high" },
  judge: { label: "最终审核", model: "gpt-5.6-sol", effort: "xhigh" },
  executorBuild: { label: "执行 · 普通制作", model: "gpt-5.6-luna", effort: "high" },
  executorIntegrate: { label: "执行 · 整合与交付", model: "gpt-5.6-terra", effort: "high" },
  executorVerify: { label: "执行 · 高风险与验证", model: "gpt-5.6-sol", effort: "low" },
  tracer: { label: "源码追溯", model: "gpt-5.6-sol", effort: "low" }
});

export function normalizeCodexRoleModels(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("智能路由配置必须是角色与模型的对应表。");
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(CODEX_ROLE_PROFILES, key)) throw new Error(`未知智能路由角色：${key}`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${key} 的模型配置无效。`);
    const model = String(entry.model ?? "").trim();
    const effort = String(entry.effort ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model) || (effort && !/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(effort))) throw new Error(`${key} 的模型或推理强度格式无效。`);
    result[key] = { model, effort };
  }
  return result;
}

export function codexRoleProfile(key, settings = {}) {
  const profile = CODEX_ROLE_PROFILES[key];
  if (!profile) return null;
  return { model: profile.model, effort: profile.effort, ...settings.codexRoleModels?.[key] };
}

export function executorProfileKey(step = {}) {
  const risk = String(step.riskLevel ?? "L1").toUpperCase();
  const kind = String(step.kind ?? "build").toLowerCase();
  if (["L2", "L3"].includes(risk) || ["verify", "judge"].includes(kind)) return "executorVerify";
  return ["integrate", "deliver"].includes(kind) ? "executorIntegrate" : "executorBuild";
}

export function validateCodexRoleCatalog(overrides, models) {
  const settings = { codexRoleModels: normalizeCodexRoleModels(overrides) };
  for (const [key, definition] of Object.entries(CODEX_ROLE_PROFILES)) {
    const route = codexRoleProfile(key, settings);
    const model = models.find(item => item.model === route.model);
    if (!model) throw new Error(`${definition.label}：模型 ${route.model} 当前不可用，请重新选择。`);
    const efforts = model.supportedReasoningEfforts ?? [];
    if (route.effort && !efforts.some(item => item.reasoningEffort === route.effort)) throw new Error(`${definition.label}：${route.model} 不支持 ${route.effort} 推理强度，请重新选择。`);
    if (!route.effort && efforts.length) throw new Error(`${definition.label}：请选择推理强度。`);
  }
}
