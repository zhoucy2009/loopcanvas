import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentPrompt, serializeAgentRequest } from "../src/agent-prompt.js";
import { codexPrompt } from "../src/codex.js";

const request = {
  id: "request-prompt",
  kind: "execute_step",
  userGoal: "做一个简单页面，不要登录，也不要增加后台。",
  focus: "只完成首页",
  selectedOption: { id: "plain", title: "纯静态方案" },
  modelPolicy: "如实报告。",
  responseInstructions: "只返回 JSON。"
};

test("Codex 优化外层提示词但不改写用户 request", () => {
  const before = structuredClone(request);
  const prompt = codexPrompt(request, "/tmp/project", { agents: "项目规则", constitution: "项目宪法" }, true);

  assert.deepEqual(request, before);
  const serialized = prompt.slice(prompt.lastIndexOf("\n") + 1);
  assert.deepEqual(JSON.parse(serialized), request);
  assert.match(prompt, /目标与解释边界/);
  assert.match(prompt, /不得改变原意、遗漏硬约束、增加未要求功能、扩大范围/);
  assert.match(prompt, /只完成 request\.focus 指定的定点修正/);
  assert.match(prompt, /workspace-write/);
  assert.match(prompt, /项目规则/);
  assert.match(prompt, /项目宪法/);
});

test("DSH 使用同一套优化规则并只引用原始请求文件", () => {
  const prompt = buildAgentPrompt({
    runtime: "dsh",
    workspace: "/tmp/project",
    request,
    requestPath: "/tmp/request.json",
    accessBoundary: "只能在工作目录内写入。"
  });

  assert.match(prompt, /DeepSeek Harness/);
  assert.match(prompt, /先完整读取请求文件：\/tmp\/request\.json/);
  assert.match(prompt, /不得修改文件内容/);
  assert.match(prompt, /当前任务边界（execute_step）/);
  assert.match(prompt, /关键歧义影响安全、权限、兼容性或验收/);
  assert.match(prompt, /directionAnswer 非空不等于歧义已解决/);
  assert.match(prompt, /逻辑或物理上不能同时满足/);
  assert.match(prompt, /不得顺手推进无关里程碑/);
  assert.doesNotMatch(prompt, new RegExp(request.userGoal));
});

test("只读 Codex 提示词明确禁止状态变更", () => {
  const prompt = codexPrompt(request, "/tmp/project", {}, false);
  assert.match(prompt, /read-only/);
  assert.match(prompt, /不得创建、修改或删除任何文件/);
});

test("连续项目提示词允许同一 Agent 推进全部里程碑", () => {
  const prompt = codexPrompt({ ...request, kind: "execute_project" }, "/tmp/project", {}, true);
  assert.match(prompt, /连续完成 request\.selectedPlan 中的全部里程碑/);
  assert.match(prompt, /不得在每个节点停下等待再次派发/);
  assert.doesNotMatch(prompt, /只处理当前 request 和当前步骤/);
});

test("自适应首调用只在 single 分支执行，graph 分支先返回真实节点", () => {
  const prompt = codexPrompt({ ...request, kind: "route_project" }, "/tmp/project", {}, true);
  assert.match(prompt, /若为 single，在当前调用内直接实现、验证并交付/);
  assert.match(prompt, /若为 graph，只返回 Harness 真正需要的执行节点与依赖/);
  assert.match(prompt, /不得为了展示流程人为拆步/);
});

test("稳定序列化不改变 request 值并把动态 id 放到末尾", () => {
  const before = structuredClone(request);
  const serialized = serializeAgentRequest(request);
  assert.deepEqual(JSON.parse(serialized), request);
  assert.deepEqual(request, before);
  assert.ok(serialized.lastIndexOf('"id"') > serialized.indexOf('"responseInstructions"'));
});
