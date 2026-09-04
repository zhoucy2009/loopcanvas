import assert from "node:assert/strict";
import test from "node:test";
import { agentFailureReason, normalizeExecutionResponse } from "../src/harness.js";
import { dependencyStepIds, workflowContext } from "../src/workflow-context.js";
import { ProjectDrafts, ownsProjectView, reconcileProjectState } from "../public/project-ui-state.js";
import { normalizePreviewViewport, previewFit } from "../public/preview-sizing.js";

function project() {
  return {
    id: "project-a", goal: "制作八页中文环保演示", directives: [{ id: "zh", text: "中文" }],
    primaryArtifact: { kind: "html", filename: "slides.html" }, attachments: [{ id: "brief" }], executionReferences: [{ id: "source" }],
    steps: [
      { id: "choice", title: "交付方式", kind: "decision", status: "approved", dependencies: [], directionQuestion: "如何交付？", selectedDirectionOptionId: "pptx", directionAnswer: "本地 PPTX，可导入 Google Slides", result: { summary: "已选 PPTX", evidence: ["用户选择"] } },
      { id: "build", title: "制作", kind: "build", status: "approved", dependencies: ["choice"], acceptanceCriteria: ["8页"], result: { summary: "8页已制作", evidence: ["8张预览"], artifact: { kind: "html", filename: "slides.html", projectRoot: "/tmp/p", content: "不应重复发送大文件" } } },
      { id: "verify", title: "验证", kind: "verify", status: "ready", dependencies: ["build"] },
      { id: "unrelated", title: "无关支线", kind: "build", status: "approved", dependencies: [], result: { summary: "不应继承" } }
    ]
  };
}

test("新会话交接包含传递依赖、用户选择和上游证据，不混入无关支线", () => {
  const source = project(), step = source.steps[2];
  assert.deepEqual([...dependencyStepIds(source, step)].sort(), ["build", "choice"]);
  const context = workflowContext(source, step);
  assert.equal(context.immutableRequirements.goal, source.goal);
  assert.equal(context.confirmedDirections[0].answer, "本地 PPTX，可导入 Google Slides");
  assert.deepEqual(context.dependencyResults.map((item) => item.id), ["choice", "build"]);
  assert.equal(context.dependencyResults[1].result.artifact.content, undefined);
});

test("有证据的验证未通过保留为结果，并提取真正失败原因", () => {
  const raw = { requestID: "verify-1", status: "failure", assistantMessage: "验证完成，发现孤行标点", result: { summary: "第3页需修复", evidence: ["逐页渲染8页"], verificationPassed: false, blockingIssues: ["第3页句号单独换行"], deviation: "Google连接未登录" } };
  const normalized = normalizeExecutionResponse(raw, "verify-1", "", { stepKind: "verify" });
  assert.equal(normalized.result.verificationPassed, false);
  assert.deepEqual(normalized.result.blockingIssues, ["第3页句号单独换行"]);
  assert.equal(agentFailureReason(raw), "验证完成，发现孤行标点");
});

test("项目草稿隔离，旧快照和旧预览响应不会抢占当前项目", () => {
  const storage = new Map(); storage.getItem = storage.get.bind(storage); storage.setItem = storage.set.bind(storage);
  const drafts = new ProjectDrafts(storage);
  drafts.set("a", "goal", "A 的需求"); drafts.set("b", "goal", "B 的需求");
  assert.equal(drafts.get("a", "goal"), "A 的需求"); assert.equal(drafts.get("b", "goal"), "B 的需求");
  const current = { stateRevision: 3, activeProjectId: "b", projects: [{ id: "a" }, { id: "b" }] };
  assert.equal(reconcileProjectState(current, { stateRevision: 2, activeProjectId: "a", projects: [{ id: "a" }] }), current);
  assert.equal(reconcileProjectState(current, { stateRevision: 4, activeProjectId: "a", projects: [{ id: "a" }, { id: "b" }] }).activeProjectId, "b");
  assert.equal(ownsProjectView("a", "b"), false);
});

test("预览尺寸统一归一化且只缩小不放大", () => {
  assert.deepEqual(normalizePreviewViewport({ width: 640.4, height: 360.2 }), { width: 640, height: 360 });
  assert.equal(normalizePreviewViewport({ width: 0, height: 10 }), null);
  assert.deepEqual(previewFit({ width: 640, height: 360 }, { width: 800, height: 600 }), { width: 640, height: 360, scale: 1, fittedWidth: 640, fittedHeight: 360 });
  assert.equal(previewFit({ width: 1280, height: 720 }, { width: 640, height: 500 }).scale, .5);
});
