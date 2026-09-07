import { validateInputReferences } from "./workflow-inputs.js";
// Shared graph contract. Conditions are data comparisons, never executable code.
export const nodeTypes = { tool: "工具调用", skill: "Skill", condition: "条件分支", approval: "人工确认 / 补充证据", review: "独立审核", output: "集成与输出" };
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export function validateWorkflow(input) {
  const w = structuredClone(input);
  if (!w || typeof w.name !== "string" || !w.name.trim() || w.name.length > 100) throw new Error("工作流名称须为 1–100 个字符。");
  w.name = w.name.trim();
  if (!Array.isArray(w.nodes) || !w.nodes.length || w.nodes.length > 100) throw new Error("工作流需要 1–100 个节点。");
  if (!Array.isArray(w.edges) || w.edges.length > 400) throw new Error("箭头数量无效。");
  if (!Array.isArray(w.triggers) || !w.triggers.length || w.triggers.some((t) => !["click", "drag", "prompt"].includes(t))) throw new Error("请选择有效触发器。");
  if (!plain(w.variables ?? {})) throw new Error("初始变量必须是 JSON 对象。");
  const ids = new Set();
  for (const n of w.nodes) {
    if (!/^[\w-]{1,100}$/.test(n.id) || ["__proto__", "constructor", "prototype"].includes(n.id) || ids.has(n.id)) throw new Error("节点 ID 无效或重复。");
    ids.add(n.id);
    for (const key of ["x", "y"]) if (n[key] !== undefined && (!Number.isFinite(n[key]) || n[key] < 0 || n[key] > 20000)) throw new Error("节点坐标无效。");
    if (!Object.hasOwn(nodeTypes, n.type) || !String(n.title ?? "").trim()) throw new Error("节点类型或名称无效。");
    if (n.type === "tool" && (!String(n.tool ?? "").trim() || !plain(n.arguments ?? {}))) throw new Error("工具节点需要工具名称及 JSON 参数对象。");
    if (n.type === "skill" && !String(n.skillId ?? "").trim()) throw new Error("请选择 Skill。");
    if (["approval", "review"].includes(n.type) && !String(n.instructions ?? "").trim()) throw new Error("确认和审核节点必须填写验收要求。");
    if (n.type === "condition" && (!/^(globals|context|outputs|input)(\.[\w-]+)+$/.test(n.condition?.path ?? "") || !["equals", "notEquals", "exists", "contains"].includes(n.condition?.operator))) throw new Error("条件需要有效数据路径和比较方式。");
  }
  const pairs = new Set();
  for (const e of w.edges) {
    const source = w.nodes.find((n) => n.id === e.from);
    if (!source || !ids.has(e.to) || e.from === e.to) throw new Error("箭头必须连接两个不同的现有节点。");
    const key = `${e.from}:${e.to}`;
    if (pairs.has(key)) throw new Error("同一对节点不能重复连线。");
    pairs.add(key);
    if (source.type === "condition" ? !["true", "false"].includes(e.when) : e.when !== "always") throw new Error("条件箭头必须指定是 / 否；普通箭头使用完成后。");
  }
  topologicalNodes(w);
  w.inputs = validateInputReferences(w);
  if (JSON.stringify(w).length > 1_000_000) throw new Error("工作流定义过大。");
  return w;
}
export function topologicalNodes(w) {
  const pending = new Map(w.nodes.map((n) => [n.id, n]));
  const result = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((n) => !w.edges.some((e) => e.to === n.id && pending.has(e.from)));
    if (!ready.length) throw new Error("箭头形成循环，请移除回环后保存。");
    for (const n of ready) { result.push(n); pending.delete(n.id); }
  }
  return result;
}
export function readData(data, key) {
  return String(key).split(".").reduce((value, part) => value && Object.hasOwn(value, part) ? value[part] : undefined, data);
}
export function conditionMatches(condition, data) {
  const actual = readData(data, condition.path);
  if (condition.operator === "exists") return actual !== undefined && actual !== null;
  if (condition.operator === "contains") return typeof actual === "string" ? actual.includes(String(condition.value)) : Array.isArray(actual) && actual.some((v) => JSON.stringify(v) === JSON.stringify(condition.value));
  const equal = JSON.stringify(actual) === JSON.stringify(condition.value);
  return condition.operator === "equals" ? equal : !equal;
}
export function resolveData(value, data) {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
    const get = (key) => { const result = readData(data, key); if (result === undefined) throw new Error(`找不到变量：${key}`); return result; };
    if (exact) return structuredClone(get(exact[1]));
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => { const v = get(key); return typeof v === "string" ? v : JSON.stringify(v); });
  }
  if (Array.isArray(value)) return value.map((v) => resolveData(v, data));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveData(v, data)]));
  return value;
}
export function matchWorkflowPrompt(prompt, workflows) {
  const match = String(prompt).match(/用\s*[“「"]?(.+?)[”」"]?\s*工作流\s*完成\s*([\s\S]+)/);
  if (!match) return null;
  const name = match[1].trim();
  const matches = workflows.filter((w) => w.name === name && w.triggers.includes("prompt"));
  if (matches.length !== 1) throw new Error(`找不到启用提示词触发的工作流“${name}”。`);
  return { workflowId: matches[0].id, goal: match[2].trim(), trigger: "prompt" };
}
