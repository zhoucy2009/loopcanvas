import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
  ADAPTIVE_NODE_RESULT_SCOPE_POLICY, DIRECTION_CONFLICT_POLICY, EXPLORATION_ART_MODEL_POLICY, EXPLORATION_MODEL_POLICY, executionResultForServer, explorationModelPolicy, extractJSONObject, LEARNING_MODEL_POLICY, normalizeExecutionResponse, PREVIEW_TRACE_POLICY,
  normalizeExplorationResponse, normalizeLearningResponse, normalizePlanResponse, normalizeProjectExecutionResponse, normalizeRepositoryOverviewResponse,
  probeCodex, probeLocalAgents, resolveCodex, resolveDsh, runProcess,
  dshInvocationArguments, readDshSessionTelemetry, visualReferencesForAgent
} from "../src/harness.js";

test("Shift 二维编辑要求先审查并同步物体作用范围", () => {
  assert.match(PREVIEW_TRACE_POLICY, /inspectInteractionRegions 必须在移动前审查/);
  assert.match(PREVIEW_TRACE_POLICY, /独立代码维护的碰撞、命中、得分或触发坐标/);
  assert.match(PREVIEW_TRACE_POLICY, /碰撞区、命中区、得分区、触发区、可投放区/);
  assert.match(PREVIEW_TRACE_POLICY, /实时预览必须同时更新物体与这些范围/);
  assert.match(PREVIEW_TRACE_POLICY, /interactionRegionIds 必须逐项确认/);
  assert.match(PREVIEW_TRACE_POLICY, /不能只移动画面/);
});

test("自适应节点只把当前验收失败列为阻断问题", () => {
  assert.match(ADAPTIVE_NODE_RESULT_SCOPE_POLICY, /blockingIssues 只能填写阻止当前节点/);
  assert.match(ADAPTIVE_NODE_RESULT_SCOPE_POLICY, /下游节点尚未创建的文件/);
  assert.match(ADAPTIVE_NODE_RESULT_SCOPE_POLICY, /不得放入 blockingIssues/);
  assert.match(ADAPTIVE_NODE_RESULT_SCOPE_POLICY, /只有 deliver 节点/);
});

test("非空但互相冲突的方向答案必须在执行前重新提问", () => {
  assert.match(DIRECTION_CONFLICT_POLICY, /directionAnswer 非空不等于目标已经明确/);
  assert.match(DIRECTION_CONFLICT_POLICY, /逻辑或物理上不能同时满足/);
  assert.match(DIRECTION_CONFLICT_POLICY, /不得调用工具或修改文件/);
  assert.match(DIRECTION_CONFLICT_POLICY, /needs_user_direction/);
});

test("智能路由 Graph 可以是单节点", () => {
  const plan = normalizePlanResponse({
    requestID: "graph-one",
    executionShape: "graph",
    primaryArtifact: { title: "页面", kind: "html", filename: "index.html", acceptanceCriteria: ["可打开"] },
    steps: [{ id: "one", title: "完成", purpose: "交付", kind: "deliver", dependencies: [], acceptanceCriteria: ["可打开"] }]
  }, "graph-one");
  assert.equal(plan.executionShape, "graph");
  assert.equal(plan.steps.length, 1);
});

test("执行响应可要求用户确认方向，且拒绝不完整问题", () => {
  const requestID = "needs-direction";
  const response = normalizeExecutionResponse({
    requestID,
    status: "needs_user_direction",
    assistantMessage: "部署位置会影响权限边界。",
    directionQuestion: "部署到哪个环境？",
    directionOptions: [
      { id: "staging", label: "预发布", description: "先验证权限与恢复路径" },
      { id: "production", label: "生产", description: "直接影响正式用户" }
    ]
  }, requestID);
  assert.equal(response.needsUserDirection, true);
  assert.equal(response.directionQuestion, "部署到哪个环境？");
  assert.deepEqual(response.directionOptions.map((item) => item.id), ["staging", "production"]);
  assert.throws(() => normalizeExecutionResponse({ requestID, status: "needs_user_direction", directionQuestion: "缺少选项" }, requestID), /2–5 个明确选项/);
});

test("dsh 调用在基础设置后叠加插件 patch", () => {
  assert.deepEqual(dshInvocationArguments("/tmp/base.yml", "prompt", "/tmp/plugins.yml"), [
    "--profile", "headless", "--patch", "/tmp/base.yml", "--patch", "/tmp/plugins.yml", "prompt"
  ]);
  assert.deepEqual(dshInvocationArguments("/tmp/base.yml", "prompt"), ["--profile", "headless", "--patch", "/tmp/base.yml", "prompt"]);
});

test("dsh session telemetry 汇总缓存、上下文与工具活动，不虚构 API 余额", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-dsh-telemetry-"));
  try {
    const sessionFile = path.join(directory, "session.jsonl.zstd");
    const rows = [
      { type: "request/context", data: { contextWindow: 1000 } },
      { type: "tool/call", data: { name: "str-replace-editor", arguments: JSON.stringify({ path: "src/app.js" }) } },
      { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 10, outputTokens: 20 } } }
    ];
    await writeFile(sessionFile, zstdCompressSync(Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n"))));
    const telemetry = await readDshSessionTelemetry(sessionFile);
    assert.equal(telemetry.activity, "修改文件：src/app.js");
    assert.equal(telemetry.metrics.cumulativeTokens, 170);
    assert.equal(telemetry.metrics.cacheHitRate, 40 / 140);
    assert.equal(telemetry.metrics.contextPercent, 0.15);
    assert.equal(telemetry.metrics.remainingPercent, null);
    assert.equal(telemetry.metrics.remainingText, "Harness 未提供");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolveDsh 优先接受显式可执行文件", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-dsh-explicit-"));
  try {
    const executable = path.join(directory, "dsh");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    assert.equal(await resolveDsh({ explicitPath: executable, home: directory, envPath: "" }), executable);
    assert.equal(await resolveDsh({ explicitPath: path.join(directory, "missing"), home: directory, envPath: "" }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolveDsh 选择最新的 npx 缓存", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-dsh-npx-"));
  try {
    const oldDirectory = path.join(home, ".npm", "_npx", "old");
    const newDirectory = path.join(home, ".npm", "_npx", "new");
    const oldExecutable = path.join(oldDirectory, "node_modules", ".bin", "dsh");
    const newExecutable = path.join(newDirectory, "node_modules", ".bin", "dsh");
    await mkdir(path.dirname(oldExecutable), { recursive: true });
    await mkdir(path.dirname(newExecutable), { recursive: true });
    await writeFile(oldExecutable, "#!/bin/sh\n");
    await writeFile(newExecutable, "#!/bin/sh\n");
    await chmod(oldExecutable, 0o755);
    await chmod(newExecutable, 0o755);
    await utimes(oldDirectory, new Date(1_000), new Date(1_000));
    await utimes(newDirectory, new Date(2_000), new Date(2_000));
    assert.equal(await resolveDsh({ home, envPath: "" }), newExecutable);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveCodex 可从 PATH 与 ChatGPT macOS 应用中首次发现", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-codex-resolve-"));
  try {
    const pathExecutable = path.join(directory, "bin", "codex");
    await mkdir(path.dirname(pathExecutable), { recursive: true });
    await writeFile(pathExecutable, "#!/bin/sh\nexit 0\n");
    await chmod(pathExecutable, 0o755);
    assert.equal(await resolveCodex({ home: directory, envPath: path.dirname(pathExecutable), platform: "darwin", applicationsRoot: directory, fallbackPaths: [] }), pathExecutable);

    const bundledExecutable = path.join(directory, "ChatGPT.app", "Contents", "Resources", "codex");
    await mkdir(path.dirname(bundledExecutable), { recursive: true });
    await writeFile(bundledExecutable, "#!/bin/sh\nexit 0\n");
    await chmod(bundledExecutable, 0o755);
    assert.equal(await resolveCodex({ home: directory, envPath: "", platform: "darwin", applicationsRoot: directory, fallbackPaths: [] }), bundledExecutable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex 与 dsh 能在一次本机 Agent 探测中分别验证", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-agent-probe-"));
  try {
    const dsh = path.join(directory, "dsh");
    const codex = path.join(directory, "codex");
    await writeFile(dsh, "#!/bin/sh\necho '1.0.0'\n");
    await writeFile(codex, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-cli 1.2.3'; exit 0; fi\nif [ \"$1\" = \"app-server\" ] && [ \"$2\" = \"--help\" ]; then echo 'Usage: codex app-server --listen stdio://'; exit 0; fi\nexit 1\n");
    await chmod(dsh, 0o755);
    await chmod(codex, 0o755);

    const codexProbe = await probeCodex({ codexPath: codex });
    assert.equal(codexProbe.supportsAppServer, true);
    assert.equal(codexProbe.version, "codex-cli 1.2.3");

    const installation = await probeLocalAgents({ dshPath: dsh, codexPath: codex });
    assert.equal(installation.dsh.ready, true);
    assert.equal(installation.codex.ready, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function option(id, recommended = false) {
  return { id, title: id, isRecommended: recommended };
}

function plannedSubprocesses(prefix) {
  return ["scope", "work", "verify"].map((part) => ({
    id: `${prefix}-${part}`,
    title: `${prefix}-${part}`,
    purpose: `${part} 的可观察结果`,
    options: [option(`${prefix}-${part}-a`, true), option(`${prefix}-${part}-b`)]
  }));
}

function plannedStep(id, title, kind, dependencies = []) {
  return { id, title, purpose: title, kind, dependencies, options: [option(`${id}-a`, true), option(`${id}-b`)] };
}

const primaryArtifact = { title: "演示页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["页面可以打开"] };

test("normalizePlanResponse 接受不含方案的真实执行图", () => {
  const requestID = "request-1";
  const response = normalizePlanResponse({
    requestID,
    status: "success",
    executionShape: "graph",
    primaryArtifact,
    steps: [
      { id: "build", title: "制作", kind: "build", dependencies: [], parallelSafe: false, writeScope: ["index.html"] },
      { id: "verify", title: "验证", kind: "verify", dependencies: ["build"], requiresUserDirection: true, directionQuestion: "选择验证目标", directionOptions: [
        { id: "speed", label: "速度优先", description: "先验证主路径" },
        { id: "coverage", label: "覆盖优先", description: "扩大边界样本" }
      ] }
    ]
  }, requestID);
  assert.equal(response.executionShape, "graph");
  assert.equal(response.steps.length, 2);
  assert.deepEqual(response.steps[1].dependencies, ["build"]);
  assert.equal(response.primaryArtifact.filename, "index.html");
  assert.deepEqual(response.steps[0].subprocesses, []);
  assert.deepEqual(response.steps[0].options, []);
  assert.equal(response.steps[1].directionQuestion, "选择验证目标");
  assert.deepEqual(response.steps[1].directionOptions.map((option) => option.id), ["speed", "coverage"]);
});

test("normalizePlanResponse 要求方向节点提供选项并兼容旧 A/B 问题", () => {
  const requestID = "direction-options";
  assert.throws(() => normalizePlanResponse({ requestID, primaryArtifact, executionShape: "graph", steps: [
    { id: "build", title: "制作", kind: "build", dependencies: [] },
    { id: "direction", title: "方向", kind: "decision", dependencies: ["build"], requiresUserDirection: true, directionQuestion: "选择目标" }
  ] }, requestID), /2–5 个明确选项/);
  const inferred = normalizePlanResponse({ requestID, primaryArtifact, executionShape: "graph", steps: [
    { id: "build", title: "制作", kind: "build", dependencies: [] },
    { id: "direction", title: "方向", kind: "decision", dependencies: ["build"], requiresUserDirection: true, directionQuestion: "选择方向 A（操作人员）或方向 B（管理者）" }
  ] }, requestID);
  assert.deepEqual(inferred.steps[1].directionOptions.map((option) => option.label), ["方向 A", "方向 B"]);
});

test("normalizePlanResponse 拒绝非法依赖", () => {
  const steps = [plannedStep("build", "制作", "build", ["missing"]), plannedStep("verify", "验证", "verify", ["build"]), plannedStep("deliver", "交付", "deliver", ["verify"])];
  assert.throws(() => normalizePlanResponse({ requestID: "x", primaryArtifact, steps }, "x"), /依赖/);
});

test("normalizePlanResponse 拒绝缺少主交付物，并要求 single 同时返回执行结果", () => {
  const steps = [{ id: "build", title: "制作", kind: "build", dependencies: [] }, { id: "verify", title: "验证", kind: "verify", dependencies: ["build"] }];
  assert.throws(() => normalizePlanResponse({ requestID: "missing-artifact", steps }, "missing-artifact"), /主交付物/);
  assert.throws(() => normalizePlanResponse({ requestID: "single", executionShape: "single", primaryArtifact, steps: [steps[0]] }, "single"), /步骤结果/);
  const response = normalizePlanResponse({ requestID: "single-ok", executionShape: "single", primaryArtifact, steps: [steps[0]], result: {
    summary: "完成", actualChanges: ["index.html"], evidence: ["页面可读"], deviation: "无", rollback: "恢复文件", verificationPassed: true, blockingIssues: [],
    artifact: { title: "演示页面", kind: "html", filename: "index.html", content: "<main>ok</main>" }
  } }, "single-ok");
  assert.equal(response.executionShape, "single");
  assert.equal(response.execution.artifact.filename, "index.html");
});

test("一步直达带视觉参考时必须返回逐项使用证据", () => {
  const visualReferences = [{ id: "qwen-svg", mode: "svg-source", pixelAccess: false, sourceAccess: true, agentText: "<svg viewBox=\"0 0 32 32\">...</svg>" }];
  const response = {
    requestID: "single-visual", executionShape: "single", primaryArtifact,
    steps: [{ id: "deliver", title: "直接交付", kind: "deliver", dependencies: [] }],
    result: {
      summary: "完成", actualChanges: ["index.html"], evidence: ["页面可读"], verificationPassed: true, blockingIssues: [],
      artifact: { title: "演示页面", kind: "html", filename: "index.html", content: "<main>ok</main>" }
    }
  };
  assert.throws(() => normalizePlanResponse(response, "single-visual", { requiredVisualReferences: visualReferences }), /未确认使用 1 个视觉参考/);
  response.result.visualReferencesUsed = [{ id: "qwen-svg", appliedAs: "使用连续环形带作为主轮廓", evidence: "index.html 的品牌图形 SVG" }];
  assert.equal(normalizePlanResponse(response, "single-visual", { requiredVisualReferences: visualReferences }).execution.visualReferencesUsed[0].id, "qwen-svg");
});

test("项目级连续执行必须覆盖全部方案、检查点和锁定主交付物", () => {
  const project = { primaryArtifact, steps: [plannedStep("build", "制作", "build"), plannedStep("verify", "验证", "verify"), plannedStep("deliver", "交付", "deliver")] };
  for (const step of project.steps) step.selectedOptionId = step.options[0].id;
  const response = { requestID: "project-run", status: "success", result: {
    appliedOptionIds: project.steps.map((step) => step.selectedOptionId), summary: "完成", evidence: ["测试通过"], verificationPassed: true,
    checkpoints: project.steps.map((step) => ({ stepId: step.id, summary: step.title, evidence: ["已核对"], verificationPassed: true })),
    artifact: { title: "演示页面", kind: "html", filename: "index.html", content: "<main>ok</main>" }
  } };
  assert.equal(normalizeProjectExecutionResponse(response, "project-run", project).checkpoints.length, 3);
  assert.throws(() => normalizeProjectExecutionResponse({ ...response, result: { ...response.result, checkpoints: response.result.checkpoints.slice(1) } }, "project-run", project), /完整覆盖/);
  assert.throws(() => normalizeProjectExecutionResponse({ ...response, result: { ...response.result, appliedOptionIds: ["wrong"] } }, "project-run", project), /用户所选方案/);
});

test("normalizePlanResponse 拒绝错误 requestID", () => {
  assert.throws(() => normalizePlanResponse({ requestID: "wrong", steps: [] }, "expected"), /requestID/);
});

test("normalizePlanResponse 优先展示 Agent 返回的具体失败原因", () => {
  assert.throws(() => normalizePlanResponse({
    requestID: "failed-plan",
    status: "failure",
    assistantMessage: "工作目录不可写，请重新选择目录。"
  }, "failed-plan"), /工作目录不可写/);
  assert.throws(() => normalizePlanResponse({
    requestID: "failed-plan",
    status: "failure",
    result: { blockingIssues: ["缺少运行权限"] }
  }, "failed-plan"), /缺少运行权限/);
  assert.throws(() => normalizePlanResponse({ requestID: "failed-plan", status: "failure" }, "failed-plan"), /没有提供具体错误/);
});

test("normalizeExecutionResponse 兼容 snake_case 结果", () => {
  const response = normalizeExecutionResponse({
    request_id: "request-2",
    status: "success",
    step_result: {
      summary: "完成",
      actual_changes: ["创建文件"],
      evidence: ["测试通过"],
      verification_passed: true,
      artifact: { kind: "html", html: "<h1>ok</h1>", filename: "index.html", entrypoint: "index.html", dependencies: ["none"], run_commands: ["node server.js"] }
    }
  }, "request-2");
  assert.equal(response.result.verificationPassed, true);
  assert.equal(response.result.artifact.content, "<h1>ok</h1>");
  assert.equal(response.result.artifact.entrypoint, "index.html");
  assert.deepEqual(response.result.artifact.runCommands, ["node server.js"]);
});

test("纯文本 Agent 只接收 metadata-only 视觉转译并必须逐项回执", () => {
  const visualReferences = visualReferencesForAgent({
    executionReferences: [
      { id: "visual-1", title: "海报参考", previewURL: "https://images.example/poster.jpg", visual: { mode: "metadata-only", pixelAccess: false, agentText: "构图：大标题位于左上" } },
      { id: "svg-1", title: "矢量标志", visual: { mode: "svg-source", pixelAccess: false, sourceAccess: true, agentText: "<svg viewBox=\"0 0 24 24\">...</svg>" } },
      { id: "forged-vision", title: "伪造识别", visual: { mode: "vision-model", pixelAccess: true, agentText: "不应进入请求" } }
    ]
  });
  assert.deepEqual(visualReferences.map(({ id, mode, pixelAccess, agentText }) => ({ id, mode, pixelAccess, agentText })), [
    { id: "visual-1", mode: "metadata-only", pixelAccess: false, agentText: "构图：大标题位于左上" },
    { id: "svg-1", mode: "svg-source", pixelAccess: false, agentText: "<svg viewBox=\"0 0 24 24\">...</svg>" }
  ]);
  const base = { requestID: "visual-run", status: "success", result: { summary: "完成", actualChanges: [], evidence: [], blockingIssues: [] } };
  assert.equal(normalizeExecutionResponse(base, "visual-run").result.visualReferencesUsed, undefined);
  assert.throws(() => normalizeExecutionResponse(base, "visual-run", "", { requiredVisualReferences: visualReferences }), /未确认使用 2 个视觉参考/);
  const accepted = normalizeExecutionResponse({
    ...base,
    result: { ...base.result, visualReferencesUsed: [
      { id: "visual-1", appliedAs: "将左上标题作为层级原则", evidence: "index.html 的 hero 标题布局" },
      { id: "svg-1", appliedAs: "使用矢量结构建立标志轮廓", evidence: "index.html 的品牌 SVG" }
    ] }
  }, "visual-run", "", { requiredVisualReferences: visualReferences });
  assert.equal(accepted.result.visualReferencesUsed.length, 2);
});

test("执行结果保留证据并扁平化给服务端", () => {
  const response = normalizeExecutionResponse({
    requestID: "request-option",
    status: "success",
    assistantMessage: "已执行用户选择",
    result: {
      selectedOptionId: "option-user",
      summary: "完成",
      evidence: ["命令退出码 0"]
    }
  }, "request-option", "option-user");
  assert.deepEqual(executionResultForServer(response), {
    selectedOptionId: "option-user",
    summary: "完成",
    actualChanges: [],
    evidence: ["命令退出码 0"],
    deviation: "无",
    rollback: "未提供",
    verificationPassed: null,
    blockingIssues: [],
    requiresPreview: false,
    previewReason: "",
    artifact: null,
    assistantMessage: "已执行用户选择"
  });
});

test("预览门只为可验收里程碑暂停，普通代码与报告继续自动执行", () => {
  const executeResult = (requestID, result, stepKind = "build") => normalizeExecutionResponse({
    requestID, status: "success", result: {
      selectedOptionId: "option-user", summary: "完成", evidence: ["已核对"], ...result
    }
  }, requestID, "option-user", { stepKind }).result;
  const htmlArtifact = { kind: "html", html: "<main>苹果模型</main>", filename: "index.html" };

  const codeOnly = executeResult("preview-code", { requiresPreview: false, artifact: htmlArtifact });
  assert.equal(codeOnly.requiresPreview, false);
  assert.equal(codeOnly.previewReason, "");

  const visualMilestone = executeResult("preview-model", { requiresPreview: true, previewReason: "苹果模型已经可旋转检查。", artifact: htmlArtifact });
  assert.equal(visualMilestone.requiresPreview, true);
  assert.equal(visualMilestone.previewReason, "苹果模型已经可旋转检查。");

  const report = executeResult("preview-report", { requiresPreview: true, previewReason: "不应采用", artifact: { kind: "markdown", content: "# 测试报告", filename: "report.md" } }, "verify");
  assert.equal(report.requiresPreview, false);
  assert.equal(report.previewReason, "");

  const finalDeliverable = executeResult("preview-final", { requiresPreview: false, artifact: { kind: "markdown", content: "# 最终成果", filename: "final.md" } }, "deliver");
  assert.equal(finalDeliverable.requiresPreview, true);
  assert.equal(finalDeliverable.previewReason, "最终成果需要预览验收。");
});

test("执行结果必须回传并匹配用户所选方案", () => {
  const base = { requestID: "request-option", status: "success", result: { summary: "完成", evidence: ["证据"] } };
  assert.throws(() => normalizeExecutionResponse(base, "request-option", "option-user"), /缺少 selectedOptionId/);
  assert.throws(() => normalizeExecutionResponse({ ...base, result: { ...base.result, selectedOptionId: "option-recommended" } }, "request-option", "option-user"), /与用户所选方案 option-user 不一致/);
});

test("学习模式响应与只读约束被规范化", () => {
  const result = normalizeLearningResponse({ requestID: "learn-1", answer: "这段代码读取计数。", key_points: ["只读"], code_references: [{ label: "读取位置", start_line: 2, end_line: 99 }] }, "learn-1", { maxLine: 8 });
  assert.equal(result.answer, "这段代码读取计数。");
  assert.deepEqual(result.keyPoints, ["只读"]);
  assert.deepEqual(result.codeReferences[0], { label: "读取位置", startLine: 2, endLine: 8 });
  assert.match(LEARNING_MODEL_POLICY, /不能修改/);
  assert.match(LEARNING_MODEL_POLICY, /不得输出补丁/);
  assert.match(LEARNING_MODEL_POLICY, /真实行号/);
});

test("整篇学习章节保留有效源码范围并限制越界行号", () => {
  const result = normalizeLearningResponse({
    requestID: "learn-document-1", answer: "完整运行流程", sections: [
      { title: "初始化", explanation: "建立状态并注册监听。", start_line: 2, end_line: 80, key_points: ["状态"] }
    ]
  }, "learn-document-1", { maxLine: 40, requireSections: true });
  assert.equal(result.sections[0].startLine, 2);
  assert.equal(result.sections[0].endLine, 40);
  assert.throws(() => normalizeLearningResponse({ requestID: "learn-document-2", answer: "没有章节" }, "learn-document-2", { requireSections: true }), /没有返回带源码行号/);
});

test("仓库文档概要必须覆盖每个请求文件且不能引入陌生路径", () => {
  const requested = [{ path: "src/a.js", language: "javascript", lineCount: 10, sizeBytes: 100, truncated: false }];
  const result = normalizeRepositoryOverviewResponse({ requestID: "repo-1", documents: [
    { path: "src/a.js", summary: "入口文件", responsibilities: ["启动"], key_symbols: ["main"] },
    { path: "secret.js", summary: "不应接受" }
  ] }, "repo-1", requested);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "src/a.js");
  assert.throws(() => normalizeRepositoryOverviewResponse({ requestID: "repo-2", documents: [] }, "repo-2", requested), /未返回 1 个/);
});

test("探索模式只接受网页来源并保留可信度", () => {
  const result = normalizeExplorationResponse({
    requestID: "explore-1", answer: "优先查看官方仓库。", sources: [
      { title: "官方仓库", url: "https://github.com/example/repo", credibility: "high", credibilityReason: "维护者仓库" },
      { title: "本地文件", url: "file:///tmp/fake", credibility: "high" }
    ]
  }, "explore-1");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].credibility, "high");
  assert.match(EXPLORATION_MODEL_POLICY, /官方文档/);
  assert.match(EXPLORATION_MODEL_POLICY, /不得杜撰/);
  assert.match(EXPLORATION_MODEL_POLICY, /实际调用 web_search/);
  assert.match(EXPLORATION_ART_MODEL_POLICY, /Pinterest/);
  assert.match(EXPLORATION_ART_MODEL_POLICY, /著作权/);
  assert.match(explorationModelPolicy("art"), /追溯到创作者官网/);
  assert.equal(explorationModelPolicy("research"), EXPLORATION_MODEL_POLICY);
  assert.throws(() => normalizeExplorationResponse({ requestID: "explore-empty", answer: "离线记忆答案", sources: [] }, "explore-empty"), /不能把模型记忆标记为联网搜索结果/);
});

test("extractJSONObject 容忍说明文字、尾随内容与代码围栏", () => {
  assert.deepEqual(extractJSONObject(`好的，这是结果：{"a":1} 以上完成。`), { a: 1 });
  assert.deepEqual(extractJSONObject("```json\n{\"a\":2}\n```"), { a: 2 });
  assert.deepEqual(extractJSONObject(`{"nested":{"list":[1,2,3]}} 尾部说明`), { nested: { list: [1, 2, 3] } });
  assert.deepEqual(extractJSONObject("{\"requestID\":\"r1\",\"steps\":[]}"), { requestID: "r1", steps: [] });
});

test("extractJSONObject 在输出前导被截断时给出明确错误", () => {
  assert.throws(() => extractJSONObject(`"summary":"被截断的内容"`), /没有返回可解析的完整 JSON 对象/);
});

test("extractJSONObject 自动修复末尾缺失的闭合花括号", () => {
  assert.deepEqual(extractJSONObject('{"a":1'), { a: 1 });
  assert.deepEqual(extractJSONObject('{"steps":[{"id":"one","title":"步骤","options":[]}'), { steps: [{ id: "one", title: "步骤", options: [] }] });
  assert.deepEqual(extractJSONObject('说明 {"nested":{"x":1}'), { nested: { x: 1 } });
  assert.deepEqual(extractJSONObject('{"a":{"b":{"c":[1,2,3]}}'), { a: { b: { c: [1, 2, 3] } } });
  assert.deepEqual(extractJSONObject('{"content":"body { color: red }"'), { content: "body { color: red }" });
});

test("extractJSONObject 不做危险修复，内部损坏时给出明确错误", () => {
  assert.throws(() => extractJSONObject('{"a":1 x}'), /没有返回可解析的完整 JSON 对象/);
  assert.throws(() => extractJSONObject('{"a":'), /没有返回可解析的完整 JSON 对象/);
  assert.throws(() => extractJSONObject(`${"{".repeat(20)}"a":1`), /没有返回可解析的完整 JSON 对象/);
});

test("runProcess 流式落盘不截断大输出并可解析尾部 JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-stream-"));
  try {
    const size = 12 * 1024 * 1024;
    const output = await runProcess(process.execPath, ["-e", `process.stdout.write('x'.repeat(${size})); process.stdout.write(JSON.stringify({ok:true,size:${size}}));`], { outputDir: directory });
    assert.equal(output.code, 0);
    assert.ok(output.stdoutPath);
    const captured = await readFile(output.stdoutPath, "utf8");
    assert.ok(captured.length >= size);
    assert.deepEqual(extractJSONObject(captured), { ok: true, size });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
