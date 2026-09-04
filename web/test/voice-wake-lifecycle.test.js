import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { t, ui, getLanguage, setLanguage } from "../public/i18n.js";
setLanguage("zh-CN");
import { parseVoiceCommand } from "../public/voice-commands.js";

const source = await readFile(new URL("../public/app-v2.js", import.meta.url), "utf8");
const recognitionSource = source.slice(source.indexOf("function startVoiceRecognition()"), source.indexOf("const remoteDeviceIcon"));
const routeSource = source.slice(source.indexOf("async function routeVoiceCommand("), source.indexOf("function startVoiceRecognition()"));
const nativeSource = source.slice(source.indexOf("let nativeWakeClaiming = false;"), source.indexOf("async function routeVoiceCommand("));

function microphoneHarness() {
  const instances = [];
  const transcripts = [];
  const timers = [];
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.starts = (this.starts || 0) + 1; this.onstart(); }
    stop() { this.onend(); }
  }
  const context = vm.createContext({ t, ui, getLanguage,
    voiceRecognition: null, voiceListeningRequested: false, voiceRestartTimer: null,
    voiceCommandRunning: false, voiceConfirmation: null, voiceWakeStatus: "",
    voiceUI: { open: false, listening: false }, remoteUI: { open: false },
    voiceRecognitionConstructor: () => Recognition,
    setVoiceState: () => {}, renderVoicePanel: () => {},
    routeVoiceCommand: (text) => transcripts.push(text),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = () => {}; }
  });
  vm.runInContext(recognitionSource, context);
  return { context, instances, transcripts, timers };
}

function finalResult(text) {
  const result = [{ transcript: text }];
  result.isFinal = true;
  return { resultIndex: 0, results: [result] };
}

test("持续聆听在任务运行时仍接收下一句，仅最终识别触发命令", () => {
  const h = microphoneHarness();
  h.context.startVoiceRecognition();
  const mic = h.instances[0];
  assert.equal(mic.continuous, true);
  mic.onresult({ resultIndex: 0, results: [[{ transcript: "规划" }]] });
  assert.equal(h.transcripts.length, 0);
  mic.onresult(finalResult("规划"));
  h.context.voiceCommandRunning = true;
  mic.onresult(finalResult("hey，审核"));
  assert.deepEqual(h.transcripts, ["规划", "hey，审核"]);
  assert.equal(h.context.voiceListeningRequested, true);
});

test("浏览器结束时恢复等待唤醒，停止后不重启也不接受迟到结果", () => {
  const h = microphoneHarness();
  h.context.startVoiceRecognition();
  const mic = h.instances[0];
  mic.onend();
  h.timers[0]();
  assert.equal(mic.starts, 2);
  h.context.startVoiceRecognition();
  mic.onresult(finalResult("执行"));
  assert.equal(h.context.voiceListeningRequested, false);
  assert.deepEqual(h.transcripts, []);
});

test("麦克风权限失败不自动重试", () => {
  const h = microphoneHarness();
  h.context.startVoiceRecognition();
  h.instances[0].onerror({ error: "not-allowed" });
  h.instances[0].onend();
  assert.equal(h.context.voiceListeningRequested, false);
  assert.equal(h.timers.length, 0);
});

test("实际语音处理器把唤醒词送到规划/审核路由，执行仍保留确认", async () => {
  const called = [];
  const project = { id: "p1", title: "测试项目", steps: [{ id: "s1", title: "构建", result: {}, agentReview: { verdict: "repair" } }] };
  const context = vm.createContext({ t, ui, getLanguage,
    parseVoiceCommand, voiceCommandRunning: false, voiceConfirmation: null,
    voicePendingCommands: [], voiceWakeStatus: "", voiceUI: {}, selectedStepId: null,
    activeProject: () => project, voiceStep: () => project.steps[0],
    setVoiceState: () => {}, renderVoicePanel: () => {}, render: () => {},
    queueMicrotask: () => {}, drainVoiceCommands: () => {},
    showToast: () => {}, announceVoiceRoute: () => {}, routeDisplayLabel: () => "审核者",
    voiceLocalOperationLabel: () => "", executorAgentPreview: () => "执行者",
    startVoicePlan: async (command) => called.push(command.type),
    api: async (url) => { called.push(url); return {}; }, updateFromPayload: () => {}
  });
  vm.runInContext(routeSource, context);
  await context.routeVoiceCommand("hey，规划");
  await context.routeVoiceCommand("审核");
  await context.routeVoiceCommand("执行");
  assert.deepEqual(called, ["plan", "/api/projects/p1/steps/s1/agent-review"]);
  assert.equal(context.voiceConfirmation.command.type, "execute_step");
  assert.match(context.voiceConfirmation.detail, /第 1 步/);
  await context.routeVoiceCommand("hey，审核");
  assert.equal(context.voicePendingCommands.length, 1);
  assert.equal(context.voiceConfirmation.command.type, "execute_step");
});

test("原生唤醒无需点击或启动浏览器麦克风即可路由，消费后清除 URL", async () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const calls = [];
  const project = { id: "p1", steps: [{ id: "s1" }, { id: "s2" }] };
  const context = vm.createContext({ t, ui, getLanguage,
    location: { hash: `#voice-wake=${id}`, pathname: "/", search: "" },
    history: { replaceState: () => { context.location.hash = ""; } },
    session: { state: {} }, voiceUI: { open: false }, voiceWakeStatus: "", selectedStepId: null,
    activeProject: () => project,
    api: async (url) => url.endsWith("/claim") ? { event: { id, role: "execute", projectId: "p1", stepId: "s2" } } : { state: {} },
    render: () => {}, renderVoicePanel: () => {}, setVoiceState: () => {},
    routeVoiceCommand: async (text) => calls.push(text)
  });
  vm.runInContext(nativeSource, context);
  assert.equal(await context.receiveNativeWake(), true);
  assert.deepEqual(calls, ["执行第2步"]);
  assert.equal(context.selectedStepId, "s2");
  assert.equal(context.voiceUI.open, true);
  assert.equal(context.location.hash, "");
  assert.equal(await context.receiveNativeWake(), false);
});

test("原生唤醒后活动项目变化时拒绝派发", async () => {
  const calls = [];
  const context = vm.createContext({ t, ui, getLanguage,
    location: { hash: "#voice-wake=12345678-1234-1234-1234-123456789abc", pathname: "/", search: "" },
    history: { replaceState: () => {} }, session: {}, voiceUI: {},
    activeProject: () => ({ id: "new" }),
    api: async (url) => url.endsWith("/claim") ? { event: { role: "plan", projectId: "old" } } : { state: {} },
    setVoiceState: (...args) => calls.push(args), routeVoiceCommand: () => assert.fail("不能调用 Agent")
  });
  vm.runInContext(nativeSource, context);
  await context.receiveNativeWake();
  assert.equal(calls[0][0], "error");
  assert.match(calls[0][2], /项目已改变/);
});

test("原生执行未绑定步骤时拒绝事后选取新目标", async () => {
  const calls = [];
  const context = vm.createContext({ t, ui, getLanguage,
    location: { hash: "#voice-wake=12345678-1234-1234-1234-123456789abc", pathname: "/", search: "" },
    history: { replaceState: () => {} }, session: {}, voiceUI: {},
    activeProject: () => ({ id: "p1", steps: [{ id: "new", status: "ready" }] }),
    api: async (url) => url.endsWith("/claim") ? { event: { role: "execute", projectId: "p1", stepId: null } } : { state: {} },
    setVoiceState: (...args) => calls.push(args), routeVoiceCommand: () => assert.fail("不能调用 Agent")
  });
  vm.runInContext(nativeSource, context);
  await context.receiveNativeWake();
  assert.equal(calls[0][0], "error");
  assert.match(calls[0][2], /没有可执行或可审核/);
});

test("复用同页时连续唤醒不会因领取中或上一 Agent 未完成而漏收", async () => {
  const firstID = "12345678-1234-1234-1234-123456789abc";
  const secondID = "12345678-1234-1234-1234-123456789abd";
  const calls = [], claims = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const context = vm.createContext({ t, ui, getLanguage,
    location: { hash: `#voice-wake=${firstID}`, pathname: "/", search: "" },
    history: { replaceState: () => { context.location.hash = ""; } },
    session: {}, voiceUI: {}, voiceWakeStatus: "", selectedStepId: null,
    activeProject: () => ({ id: "p1", steps: [{ id: "s1" }] }),
    api: async (url) => {
      if (!url.endsWith("/claim")) return { state: {} };
      claims.push(url);
      if (url.includes(firstID)) await gate;
      return { event: { role: url.includes(firstID) ? "plan" : "review", projectId: "p1", stepId: "s1" } };
    },
    render: () => {}, renderVoicePanel: () => {}, setVoiceState: () => assert.fail("Unexpected error"),
    routeVoiceCommand: (text) => { calls.push(text); return new Promise(() => {}); }
  });
  vm.runInContext(nativeSource, context);
  const first = context.receiveNativeWake();
  context.location.hash = `#voice-wake=${secondID}`;
  assert.equal(await context.receiveNativeWake(), true);
  release();
  await first;
  assert.deepEqual(calls, ["规划", "审核第1步"]);
  assert.equal(claims.length, 2);
  assert.equal(context.location.hash, "");
});

test("集合与开新需求是即时界面操作，不等待正在运行的 Agent", async () => {
  const calls = [];
  const context = vm.createContext({ t, ui, getLanguage,
    parseVoiceCommand, voiceCommandRunning: true, voiceConfirmation: {},
    agentSprites: { gather: () => calls.push("gather") }, openNewRequirement: async () => calls.push("new")
  });
  vm.runInContext(routeSource, context);
  await context.routeVoiceCommand("集合");
  await context.routeVoiceCommand("开一个新需求");
  assert.deepEqual(calls, ["gather", "new"]);
  assert.equal(context.voiceCommandRunning, true);
});
