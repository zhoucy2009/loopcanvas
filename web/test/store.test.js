import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeDirectives, answerStepDirection, approveStep, applyAdaptiveRoute, applyPlan, executionReadiness, moveStep, readyAdaptiveSteps, recoverInterruptedAdaptiveExecution, rejectStep, reopenStep, rollbackStep, SCHEMA_VERSION, setStepCaution, StateStore
} from "../src/store.js";

test("StateStore 原子保存项目并可重新载入", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-store-"));
  try {
    const file = path.join(directory, "state.json");
    const first = new StateStore(file, path.join(directory, "workspace"));
    await first.load();
    const project = await first.createProject({ goal: "制作一个本机网站" });
    assert.equal(project.pendingAction, null);
    const second = new StateStore(file, path.join(directory, "workspace"));
    await second.load();
    assert.equal(second.project(project.id).goal, "制作一个本机网站");
    assert.equal(second.state.activeProjectId, project.id);
    assert.equal(second.project(project.id).pinnedAt, null);
  assert.deepEqual(second.project(project.id).learningThreads, []);
  assert.deepEqual(second.project(project.id).archivedLearningThreads, []);
  assert.deepEqual(second.project(project.id).deletedLearningThreads, []);
  assert.deepEqual(second.project(project.id).learningSources, []);
  assert.deepEqual(second.project(project.id).learningMaterials, []);
  assert.deepEqual(second.project(project.id).learningShelf, { pinned: [], archived: [] });
  assert.deepEqual(second.project(project.id).explorationThreads, []);
    assert.deepEqual(second.project(project.id).executionReferences, []);
    assert.deepEqual(second.state.explorationThreads, []);
    assert.deepEqual(second.state.dshPluginStates, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("空白草稿会成为独立活动项目且不放宽普通创建校验", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-draft-"));
  try {
    const store = new StateStore(path.join(directory, "state.json"), path.join(directory, "workspace"));
    await store.load();
    const existing = await store.createProject({ goal: "已有项目" });
    const draft = await store.createProject({ goal: "", draft: true });
    assert.notEqual(draft.id, existing.id);
    assert.equal(draft.goal, "");
    assert.equal(store.state.activeProjectId, draft.id);
    assert.equal(store.project(existing.id).goal, "已有项目");
    await assert.rejects(() => store.createProject({ goal: "" }), /请先输入要完成的目标/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("步骤验收只解锁依赖已完成的后续步骤", () => {
  const project = { phase: "intake", updatedAt: "", context: [], steps: [] };
  applyPlan(project, [
    { id: "one", title: "一", purpose: "", kind: "build", dependencies: [], options: [{ id: "a", isRecommended: true }] },
    { id: "two", title: "二", purpose: "", kind: "verify", dependencies: ["one"], options: [{ id: "b" }] },
    { id: "three", title: "三", purpose: "", kind: "deliver", dependencies: ["two"], options: [{ id: "c" }] }
  ]);
  assert.equal(project.steps[1].status, "locked");
  project.steps[0].status = "review";
  approveStep(project, "one");
  assert.equal(project.steps[1].status, "ready");
  assert.equal(project.steps[2].status, "locked");
});

test("整个计划可浏览，但执行前置检查会精确指出缺失依赖与前序子进程", () => {
  const project = { phase: "intake", updatedAt: "", context: [], steps: [] };
  applyPlan(project, [
    { id: "scope", title: "确认范围", purpose: "", kind: "decision", dependencies: [], options: [{ id: "a", isRecommended: true }] },
    { id: "build", title: "制作页面", purpose: "", kind: "build", dependencies: ["scope"], options: [{ id: "b", isRecommended: true }], subprocesses: [
      { id: "read", title: "读取状态", purpose: "", options: [{ id: "inspect", title: "检查现状", isRecommended: true }, { id: "inventory", title: "列出输入" }] },
      { id: "write", title: "实施改动", purpose: "", options: [{ id: "local", title: "局部修改", isRecommended: true }, { id: "replace", title: "替换实现" }] }
    ] }
  ]);
  const missingStep = executionReadiness(project, "build", "read");
  assert.equal(missingStep.allowed, false);
  assert.deepEqual(missingStep.missingStepIds, ["scope"]);
  assert.match(missingStep.reasons.join(" "), /确认范围/);
  project.steps[0].status = "approved";
  project.steps[1].subprocesses[0].status = "review";
  const qualityGuard = executionReadiness(project, "build", "write");
  assert.equal(qualityGuard.allowed, false);
  assert.deepEqual(qualityGuard.missingSubprocessIds, ["read"]);
  assert.match(qualityGuard.reasons.join(" "), /结果质量可能不稳定/);
  project.steps[1].subprocesses[0].status = "approved";
  assert.equal(executionReadiness(project, "build", "write").allowed, true);
});

test("连续项目登记主交付物前禁止退回单步执行", () => {
  const project = {
    executionMode: "continuous",
    primaryArtifact: { title: "主交付物", kind: "html", filename: "index.html" },
    artifact: null,
    isPaused: false,
    steps: [{
      id: "build", title: "构建主交付物", status: "ready", dependencies: [],
      options: [{ id: "single", title: "单文件" }], selectedOptionId: "single", subprocesses: []
    }]
  };
  const blocked = executionReadiness(project, "build");
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reasons.join(" "), /连续项目尚未登记主交付物/);

  project.artifact = { title: "主交付物", kind: "html", filename: "index.html" };
  assert.equal(executionReadiness(project, "build").allowed, true);
});

test("旧状态自动迁移到当前版本并保留项目且不把 UI 偏好当成 dsh 同步", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-migrate-"));
  try {
    const file = path.join(directory, "state.json");
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      activeProjectId: "old",
      settings: { workspace: path.join(directory, "workspace") },
      pluginStates: { "tool-web": true },
      projects: [{ id: "old", title: "旧项目", goal: "必须本机运行", phase: "intake", steps: [], context: [], artifact: null }]
    }));
    const store = new StateStore(file, path.join(directory, "workspace"));
    await store.load();
    assert.equal(store.state.schemaVersion, SCHEMA_VERSION);
    assert.equal(store.state.settings.agentRuntime, "dsh");
    assert.equal(store.state.settings.codexModel, "");
    assert.deepEqual(store.state.dshPluginStates, {});
    assert.equal(store.project("old").title, "旧项目");
    assert.equal(store.project("old").directives[0].strength, "required");
    assert.equal(JSON.parse(await readFile(file, "utf8")).schemaVersion, SCHEMA_VERSION);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("旧版大步骤方案不会被错误复制给子进程", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-subprocess-option-migration-"));
  try {
    const file = path.join(directory, "state.json");
    await writeFile(file, JSON.stringify({
      schemaVersion: 5,
      activeProjectId: "legacy",
      settings: { workspace: path.join(directory, "workspace") },
      projects: [{
        id: "legacy", title: "旧计划", goal: "制作模型", phase: "workspace", context: [],
        steps: [{
          id: "model", title: "确认模型", purpose: "确认组成", kind: "decision", status: "ready", dependencies: [],
          options: [{ id: "style", title: "写实风格", isRecommended: true }], selectedOptionId: "style",
          subprocesses: [{ id: "parts", title: "确定组成", purpose: "选择模型组成", status: "ready" }]
        }]
      }]
    }));
    const store = new StateStore(file, path.join(directory, "workspace"));
    await store.load();
    const project = store.project("legacy");
    assert.equal(project.steps[0].options[0].title, "写实风格");
    assert.deepEqual(project.steps[0].subprocesses[0].options, []);
    assert.equal(project.steps[0].subprocesses[0].selectedOptionId, null);
    const readiness = executionReadiness(project, "model", "parts");
    assert.equal(readiness.requiresPlanRefresh, true);
    assert.match(readiness.reasons.join(" "), /旧版计划结构/);
    assert.equal(JSON.parse(await readFile(file, "utf8")).schemaVersion, SCHEMA_VERSION);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("DeepSeek 与 Codex 分别保存模型设置并可切换执行引擎", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-runtime-settings-"));
  try {
    const store = new StateStore(path.join(directory, "state.json"), path.join(directory, "workspace"));
    await store.load();
    await store.updateSettings({
      agentRuntime: "codex",
      model: "deepseek-v4-flash",
      reasoningEffort: "max",
      cautionLevel: "high",
      codexModel: "gpt-test",
      codexReasoningEffort: "low"
    });
    assert.equal(store.state.settings.agentRuntime, "codex");
    assert.equal(store.state.settings.model, "deepseek-v4-flash");
    assert.equal(store.state.settings.reasoningEffort, "max");
    assert.equal(store.state.settings.cautionLevel, "high");
    assert.equal(store.state.settings.codexModel, "gpt-test");
    assert.equal(store.state.settings.codexReasoningEffort, "low");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("自适应执行图不生成方案或子进程，并支持方向与节点谨慎等级", () => {
  const project = { workspace: "/tmp/adaptive", phase: "intake", updatedAt: "", context: [], decisionLog: [], agents: [], steps: [] };
  applyAdaptiveRoute(project, {
    executionShape: "graph",
    assistantMessage: "需要两个真实节点",
    primaryArtifact: { title: "页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["可打开"] },
    steps: [
      { id: "build", title: "实现", purpose: "写页面", kind: "build", dependencies: [], parallelSafe: false, writeScope: ["index.html"] },
      { id: "direction", title: "确认方向", purpose: "选择呈现重点", kind: "decision", dependencies: ["build"], requiresUserDirection: true, directionQuestion: "更重视速度还是细节？", directionOptions: [
        { id: "speed", label: "速度优先", description: "先完成核心路径" },
        { id: "detail", label: "细节优先", description: "扩大边界覆盖" }
      ] }
    ]
  });
  assert.equal(project.executionMode, "adaptive-graph");
  assert.deepEqual(project.steps.map((step) => step.options), [[], []]);
  assert.deepEqual(project.steps.map((step) => step.subprocesses), [[], []]);
  setStepCaution(project, "build", "high");
  assert.equal(project.steps[0].cautionLevel, "high");
  project.steps[0].status = "approved";
  assert.equal(readyAdaptiveSteps(project)[0].id, "direction");
  answerStepDirection(project, "direction", { optionId: "speed", supplemental: "" });
  assert.equal(project.steps[1].selectedDirectionOptionId, "speed");
  assert.equal(project.steps[1].directionSupplement, "");
  assert.equal(project.steps[1].directionAnswer, "速度优先：先完成核心路径");
  assert.equal(project.steps[1].status, "approved");
  assert.equal(project.steps[1].result.verificationPassed, true);
  const buildWithDirection = { phase: "workspace", updatedAt: "", context: [], decisionLog: [], steps: [{ id: "directed-build", title: "按方向构建", kind: "build", status: "ready", dependencies: [], requiresUserDirection: true, directionQuestion: "选择构建方向", directionOptions: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] };
  answerStepDirection(buildWithDirection, "directed-build", { optionId: "a", supplemental: "" });
  assert.equal(buildWithDirection.steps[0].status, "ready", "非 decision 节点收到方向后仍需 Agent 执行");
});

test("已回答却执行失败的旧 decision 节点在加载时直接完成", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-direction-decision-recovery-"));
  try {
    const statePath = path.join(directory, "state.json");
    await writeFile(statePath, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      activeProjectId: "project",
      settings: {},
      projects: [{
        id: "project", title: "方向恢复", goal: "选择方向", phase: "workspace", executionMode: "adaptive-graph", selectedStepId: "decision",
        lastError: "Agent 执行失败。", pendingAction: { type: "adaptive_run", status: "failed", error: "Agent 执行失败。" },
        executionRun: { status: "failed", error: "Agent 执行失败。", awaitingStepIds: [] }, context: [], decisionLog: [], agents: [], checkpoints: [],
        steps: [
          { id: "decision", title: "确认方向", kind: "decision", status: "error", dependencies: [], requiresUserDirection: true, directionQuestion: "选 A 或 B", directionOptions: [{ id: "a", label: "A" }, { id: "b", label: "B" }], selectedDirectionOptionId: "a", directionAnswer: "A", lastError: "Agent 执行失败。" },
          { id: "build", title: "按方向构建", kind: "build", status: "locked", dependencies: ["decision"] }
        ]
      }],
      archivedProjects: [], draftAttachments: [], pluginStates: {}, dshPluginStates: {}, explorationThreads: []
    }));
    const store = new StateStore(statePath, path.join(directory, "workspace"));
    await store.load();
    const restored = store.project("project");
    assert.equal(restored.steps[0].status, "approved");
    assert.equal(restored.steps[0].lastError, null);
    assert.equal(restored.steps[0].result.verificationPassed, true);
    assert.equal(restored.lastError, null);
    assert.equal(restored.pendingAction, null);
    assert.equal(restored.executionRun.status, "ready");
    assert.equal(readyAdaptiveSteps(restored)[0].id, "build");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("自适应节点回退会重新锁定下游并清除旧交付登记", () => {
  const project = { workspace: "/tmp/adaptive", phase: "complete", updatedAt: "", context: [], decisionLog: [], agents: [], steps: [], artifact: { filename: "index.html" } };
  applyAdaptiveRoute(project, {
    executionShape: "graph", assistantMessage: "图", primaryArtifact: { title: "页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["可打开"] },
    steps: [{ id: "one", title: "一", dependencies: [] }, { id: "two", title: "二", dependencies: ["one"] }]
  });
  project.steps[0].status = "approved"; project.steps[0].result = { summary: "一" };
  project.steps[1].status = "approved"; project.steps[1].result = { summary: "二" };
  project.artifact = { filename: "index.html" }; project.phase = "complete";
  rollbackStep(project, "one");
  assert.equal(project.steps[0].status, "ready");
  assert.equal(project.steps[1].status, "locked");
  assert.equal(project.steps[1].result, null);
  assert.equal(project.artifact, null);
  assert.equal(project.executionRun.status, "ready");
});

test("重新加载会把没有活动调用的自适应执行中节点恢复为待执行", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-interrupted-adaptive-"));
  const file = path.join(directory, "state.json");
  try {
    const first = new StateStore(file, path.join(directory, "workspace"));
    await first.load();
    const created = await first.createProject({ goal: "恢复中断节点" });
    await first.mutate(() => {
      const project = first.project(created.id);
      applyAdaptiveRoute(project, {
        executionShape: "graph", assistantMessage: "图", primaryArtifact: { title: "页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["可打开"] },
        steps: [{ id: "build", title: "构建", dependencies: [] }, { id: "deliver", title: "交付", dependencies: ["build"] }]
      });
      project.steps[0].status = "running";
      project.executionRun = { status: "running", awaitingStepIds: [] };
      project.pendingAction = { type: "adaptive_run", status: "running", stepId: "build" };
    });
    const second = new StateStore(file, path.join(directory, "workspace"));
    await second.load();
    const recovered = second.project(created.id);
    assert.equal(recovered.steps[0].status, "ready");
    assert.equal(recovered.executionRun.status, "ready");
    assert.equal(recovered.pendingAction, null);
    assert.equal(recoverInterruptedAdaptiveExecution(recovered), false, "恢复应当幂等");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("需求分析区分必须、偏好和禁止", () => {
  const directives = analyzeDirectives("必须离线；我希望使用深色主题；不要上传 API Key");
  assert.deepEqual(directives.map((item) => item.strength), ["required", "preferred", "forbidden"]);
});

test("项目归档可恢复，固定检查点去重且回退不会生成新检查点", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-lifecycle-"));
  try {
    const store = new StateStore(path.join(directory, "state.json"), path.join(directory, "workspace"));
    await store.load();
    const project = await store.createProject({ goal: "生命周期" });
    for (let index = 0; index < 42; index += 1) await store.createCheckpoint(project.id, `检查点 ${index}`);
    assert.equal(store.project(project.id).checkpoints.length, 40);
    await store.createCheckpoint(project.id, "第 1 步 · 决策前 · 方向确认", { stepId: "direction", kind: "decision", key: "decision:direction" });
    await store.createCheckpoint(project.id, "不应重复", { stepId: "direction", kind: "decision", key: "decision:direction" });
    assert.equal(store.project(project.id).checkpoints.filter((item) => item.key === "decision:direction").length, 1);
    const targetCheckpoint = structuredClone(store.project(project.id).checkpoints[2]);
    const checkpointIds = store.project(project.id).checkpoints.map((item) => item.id);
    await store.mutate(() => { store.project(project.id).title = "回退前临时标题"; });
    await store.restoreCheckpoint(project.id, targetCheckpoint.id);
    const restoredFromTarget = store.project(project.id);
    assert.equal(restoredFromTarget.title, "生命周期");
    assert.equal(restoredFromTarget.checkpoints.length, 40);
    assert.equal(restoredFromTarget.isPaused, true);
    assert.equal(restoredFromTarget.pendingAction, null);
    assert.ok(restoredFromTarget.checkpoints.some((item) => item.id === targetCheckpoint.id), "使用后仍保留所选检查点");
    assert.deepEqual(restoredFromTarget.checkpoints.map((item) => item.id), checkpointIds);
    await store.restoreCheckpoint(project.id, targetCheckpoint.id);
    assert.deepEqual(store.project(project.id).checkpoints.map((item) => item.id), checkpointIds, "反复回退不应生成或删除检查点");
    assert.ok(store.project(project.id).checkpoints.every((item) => !item.reason.startsWith("回退到“")));
    await store.setProjectPinned(project.id, true);
    assert.match(store.project(project.id).pinnedAt, /^\d{4}-\d{2}-\d{2}T/);
    await store.archiveProject(project.id);
    assert.equal(store.state.projects.length, 0);
    assert.equal(store.state.archivedProjects.length, 1);
    assert.equal(store.state.archivedProjects[0].pinnedAt, null, "归档任务不保留工作列表置顶状态");
    await store.restoreArchivedProject(project.id);
    assert.equal(store.project(project.id).title, "生命周期");
    assert.equal(store.project(project.id).pinnedAt, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("加载旧状态时移除递归回退检查点并保留普通检查点", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-checkpoint-migration-"));
  const file = path.join(directory, "state.json");
  try {
    const store = new StateStore(file, path.join(directory, "workspace"));
    await store.load();
    const project = await store.createProject({ goal: "迁移检查点" });
    await store.createCheckpoint(project.id, "第 1 步 · 重要执行前 · 构建", { stepId: "build", kind: "execution", key: "execution:build" });
    await store.mutate((state) => {
      state.schemaVersion = 11;
      const snapshot = structuredClone(state.projects[0].checkpoints[0].snapshot);
      state.projects[0].checkpoints.push(
        { id: "nested-1", at: new Date().toISOString(), reason: "回退到“第 1 步”前自动保存", stepId: "build", snapshot },
        { id: "nested-2", at: new Date().toISOString(), reason: "回退到\"回退点\"前自动保存", stepId: "build", snapshot }
      );
    });
    const reloaded = new StateStore(file, path.join(directory, "workspace"));
    await reloaded.load();
    assert.deepEqual(reloaded.project(project.id).checkpoints.map((item) => item.key), ["execution:build"]);
    assert.equal(JSON.parse(await readFile(file, "utf8")).schemaVersion, SCHEMA_VERSION);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("连续计划保留零子进程并把主交付物绑定到固定项目目录", () => {
  const project = { workspace: "/tmp/loopcanvas-project", phase: "intake", updatedAt: "", context: [], decisionLog: [], steps: [] };
  applyPlan(project, [
    { id: "build", title: "构建", purpose: "完成成果", kind: "build", dependencies: [], options: [{ id: "direct", isRecommended: true }], subprocesses: [] },
    { id: "verify", title: "验证", purpose: "核对成果", kind: "verify", dependencies: ["build"], options: [{ id: "local", isRecommended: true }], subprocesses: [] },
    { id: "deliver", title: "交付", purpose: "交付成果", kind: "deliver", dependencies: ["verify"], options: [{ id: "html", isRecommended: true }], subprocesses: [] }
  ], "路线完成", { title: "页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["可打开"] });
  assert.deepEqual(project.steps.map((step) => step.subprocesses), [[], [], []]);
  assert.equal(project.primaryArtifact.projectRoot, project.workspace);
  assert.equal(project.executionMode, "continuous");
});

test("返工上游会让已通过下游进入 stale", () => {
  const project = { phase: "workspace", updatedAt: "", context: [], decisionLog: [], steps: [] };
  applyPlan(project, [
    { id: "one", title: "制作", purpose: "", kind: "build", dependencies: [], options: [{ id: "a" }] },
    { id: "two", title: "集成", purpose: "", kind: "integrate", dependencies: ["one"], options: [{ id: "b" }] }
  ]);
  project.steps[0].status = "approved";
  project.steps[1].status = "approved";
  reopenStep(project, "one", "修改基础结构");
  assert.equal(project.steps[0].status, "ready");
  assert.equal(project.steps[1].status, "stale");
});

test("验证失败不能误验收", () => {
  const project = { phase: "workspace", updatedAt: "", context: [], decisionLog: [], steps: [{ id: "verify", title: "验证", kind: "verify", status: "review", revision: 1, dependencies: [], result: { verificationPassed: false, blockingIssues: ["未通过"] } }] };
  assert.throws(() => approveStep(project, "verify"), /必须明确通过/);
});

test("要求修改会增加版本并保留反馈", () => {
  const project = { phase: "workspace", updatedAt: "", context: [], decisionLog: [], steps: [{ id: "one", title: "步骤", status: "review", revision: 1, dependencies: [], result: { summary: "旧" } }] };
  rejectStep(project, "one", "调整布局");
  assert.equal(project.steps[0].revision, 2);
  assert.equal(project.steps[0].lastFeedback, "调整布局");
  assert.equal(project.steps[0].result, null);
});

test("步骤移动保持拓扑依赖并允许移动到末尾", () => {
  const project = { decisionLog: [], steps: [
    { id: "one", dependencies: [] }, { id: "parallel", dependencies: [] }, { id: "two", dependencies: ["one"] }
  ] };
  assert.throws(() => moveStep(project, "one", null), /破坏步骤依赖/);
  moveStep(project, "parallel", null);
  assert.deepEqual(project.steps.map((step) => step.id), ["one", "two", "parallel"]);
});

test("项目改名保留工作目录，工作目录可自动派生并显式覆盖", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-workspace-"));
  try {
    const store = new StateStore(path.join(directory, "state.json"), path.join(directory, "workspace"));
    await store.load();
    const project = await store.createProject({ title: "本机网站", goal: "做一个本机网站" });
    assert.ok(project.workspace.endsWith(`-${project.id.slice(0, 8)}`));
    const derived = project.workspace;

    const renamed = await store.renameProject(project.id, "改名后的网站");
    assert.equal(renamed.title, "改名后的网站");
    assert.equal(store.project(project.id).workspace, derived, "改名不应移动已有工作目录");

    const cleared = await store.updateProjectWorkspace(project.id, "");
    assert.match(cleared.workspace, /改名后的网站/);
    assert.ok(cleared.workspace.endsWith(`-${project.id.slice(0, 8)}`));

    const explicit = path.join(directory, "explicit-folder");
    const updated = await store.updateProjectWorkspace(project.id, explicit);
    assert.equal(store.project(project.id).workspace, explicit);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
