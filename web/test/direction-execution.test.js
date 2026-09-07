import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { applyAdaptiveRoute, StateStore } from "../src/store.js";

for (const kind of ["decision", "build"]) {
  for (const outcome of ["pass", "repair", "clarify", "review-error"]) {
    test(`${kind}: direction input runs the executor before review (${outcome})`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-direction-execution-"));
      const executions = [];
      let retries = 0;
      const result = { summary: "已整理云端实施方案", actualChanges: [], evidence: ["已核对服务接口及数据边界"], verificationPassed: true, blockingIssues: [], artifact: null };
      const review = { verdict: "pass", summary: "方案通过", findings: [], verifiedEvidence: ["独立核对方案"] };
      const runtime = await startServer({ port: 0, dataDirectory: directory, workspace: path.join(directory, "workspace"), enforceAgentReviewChain: true,
        executeWithHarness: async (_project, step) => {
          executions.push(structuredClone(step));
          if (outcome === "clarify" && executions.length === 1) return { needsUserDirection: true, directionQuestion: "云端预算上限是多少？", directionOptions: [{ id: "free", label: "仅免费额度" }, { id: "paid", label: "每月不超过 10 元" }] };
          if (outcome === "review-error") {
            const error = new Error("审核连接中断");
            error.completedExecution = { result, reviewPending: true };
            throw error;
          }
          return { result, agentReview: outcome === "repair" && executions.length === 1 ? { ...review, verdict: "repair", summary: "补充超时处理", findings: [{ repairInstruction: "完善异常处理方案" }] } : review };
        },
        reviewStepWithHarness: async () => { retries++; return review; }
      });
      try {
        const project = runtime.store.project((await runtime.store.createProject({ goal: "构建视频分析网站" })).id);
        await runtime.store.mutate(state => {
          state.settings.smartRouting = true;
          applyAdaptiveRoute(project, { executionShape: "graph", primaryArtifact: { kind: "html", filename: "index.html" }, steps: [
            { id: "choose", title: "选择分析方式", kind, dependencies: [], requiresUserDirection: true, directionQuestion: "分析方式？", directionOptions: [{ id: "cloud", label: "云端分析" }, { id: "local", label: "本地分析" }], acceptanceCriteria: ["已选择路线", "实施边界明确"] },
            { id: "next", title: "下游构建", kind: "build", dependencies: ["choose"] }
          ] });
        });
        const { token } = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
        const post = (suffix, body) => fetch(`${runtime.url}/api/projects/${project.id}${suffix}`, { method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": token }, body: JSON.stringify(body) });
        const step = project.steps[0];
        assert.equal((await post("/steps/choose/direction", { optionId: "cloud", supplemental: "视频不持久保存" })).status, 200);
        assert.equal(executions.length, 0);
        assert.equal(retries, 0);
        assert.equal(step.status, "ready");
        assert.equal(step.result, null);
        assert.equal(project.steps[1].status, "locked");
        const answer = step.directionAnswer;
        const assertPersisted = async () => {
          const saved = new StateStore(path.join(directory, "state.json"), project.workspace);
          await saved.load();
          const restored = saved.project(project.id);
          assert.equal(restored.steps[0].status, step.status);
          assert.equal(restored.steps[0].directionAnswer, step.directionAnswer);
          assert.equal(restored.steps[1].status, project.steps[1].status);
        };
        await assertPersisted();
        const run = await post("/run", { mode: "sequential", stepId: "choose" });
        assert.equal(run.status, outcome === "review-error" ? 400 : 200);
        assert.equal(executions.length, 1);
        assert.equal(executions[0].directionAnswer, answer);
        if (outcome === "clarify") {
          assert.equal(project.executionRun.status, "awaiting_direction");
          assert.equal(step.directionQuestion, "云端预算上限是多少？");
          assert.ok(project.context.some(item => item.kind === "decision" && item.content.includes(answer)));
          assert.equal((await post("/steps/choose/direction", { optionId: "free" })).status, 200);
          assert.equal((await post("/run", { mode: "sequential", stepId: "choose" })).status, 200);
          assert.equal(executions[1].directionAnswer, "仅免费额度");
        } else {
          assert.equal(step.directionAnswer, answer);
          assert.equal(step.selectedDirectionOptionId, "cloud");
          if (outcome === "repair") {
            assert.match(step.lastFeedback, /完善异常处理方案/);
            assert.equal(step.status, "ready");
            await assertPersisted();
            assert.equal((await post("/run", { mode: "sequential", stepId: "choose" })).status, 200);
            assert.equal(executions[1].directionAnswer, answer);
          }
          if (outcome === "review-error") {
            assert.equal(step.status, "error");
            assert.equal(step.reviewPending, true);
            await assertPersisted();
            assert.equal((await post("/steps/choose/agent-review", {})).status, 200);
            assert.equal(executions.length, 1);
            assert.equal(retries, 1);
          }
        }
        assert.equal(step.status, "approved");
        assert.equal(step.agentReview.verdict, "pass");
        assert.equal(project.steps[1].status, "ready");
      } finally {
        await new Promise(resolve => runtime.server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
