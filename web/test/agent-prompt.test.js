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
  assert.match(prompt, /request\.currentStep 与 request\.focus 指定的当前节点/);
  assert.match(prompt, /confirmedDirections/);
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

test("智能规划即使只有一步也只返回 Graph 且不执行", () => {
  const prompt = codexPrompt({ ...request, kind: "route_project", agentRole: "planner" }, "/tmp/project", {}, false);
  assert.match(prompt, /只返回单节点 Graph/);
  assert.match(prompt, /不实现、不验证交付、不修改文件/);
  assert.match(prompt, /不得为了展示流程人为拆步/);
});

test("角色提示词明确职责且不改写 request", () => {
  const requestWithRole = { ...request, kind: "learning_explain_selection", agentRole: "learning" };
  const before = structuredClone(requestWithRole);
  const prompt = buildAgentPrompt({ runtime: "codex", workspace: "/tmp/project", request: requestWithRole });
  assert.deepEqual(requestWithRole, before);
  assert.match(prompt, /当前 Agent 角色（learning）/);
  assert.match(prompt, /学习讲解者/);
  assert.match(prompt, /不会改变原始 request/);
});

test("智能路由规划提示要求只读 Graph", () => {
  const prompt = buildAgentPrompt({ runtime: "codex", workspace: "/tmp/project", request: { ...request, kind: "route_project", agentRole: "planner", smartRouting: true } });
  assert.match(prompt, /只返回单节点 Graph/);
});

test("关闭智能路由后的兼容 single 使用可写交付边界而不是 planner 只读角色", () => {
  const prompt = buildAgentPrompt({ runtime: "dsh", workspace: "/tmp/project", request: { ...request, kind: "route_project", smartRouting: false } });
  assert.match(prompt, /兼容交付协议/);
  assert.match(prompt, /同一次调用内完成实现与验证/);
  assert.doesNotMatch(prompt, /当前 Agent 角色（planner）/);
  assert.doesNotMatch(prompt, /只返回单节点 Graph/);
});

test("角色与任务类型冲突会在构造提示词前被拒绝", () => {
  assert.throws(() => buildAgentPrompt({ runtime: "codex", workspace: "/tmp/project", request: { ...request, kind: "execute_step", agentRole: "learning" } }), /不能处理任务类型/);
});

test("稳定序列化不改变 request 值并把动态 id 放到末尾", () => {
  const before = structuredClone(request);
  const serialized = serializeAgentRequest(request);
  assert.deepEqual(JSON.parse(serialized), request);
  assert.deepEqual(request, before);
  assert.ok(serialized.lastIndexOf('"id"') > serialized.indexOf('"responseInstructions"'));
});


test("custom workflow execution prompt permits its node while generation stays read-only", () => {
  const execution = buildAgentPrompt({runtime:"codex",workspace:"/tmp/workflow",request:{id:"wf",kind:"custom_workflow_execute",agentRole:"executor"}});
  assert.match(execution,/只执行 request.node/);
  assert.doesNotMatch(execution,/本次是只读分析/);
  const generation = buildAgentPrompt({runtime:"codex",workspace:"/tmp/workflow",request:{id:"wf",kind:"custom_workflow_generate",agentRole:"planner"}});
  assert.match(generation,/不得实际执行工具调用/);
});
