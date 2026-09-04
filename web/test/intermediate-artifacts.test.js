import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { startServer } from "../src/server.js";

const node = (id, kind, dependencies = []) => ({ id, kind, title: id, purpose: id, dependencies, status: dependencies.length ? "locked" : "ready", revision: 1, parallelSafe: true, writeScope: [`${id}/`], conversation: [], options: [], subprocesses: [] });
const result = (artifact, patch = {}) => ({ request: {}, rawOutput: "test-output", result: { artifact, summary: "完成", assistantMessage: "完成", evidence: ["文件已核验"], actualChanges: [], verificationPassed: true, blockingIssues: [], requiresPreview: false, ...patch } });

async function fixture(steps, run, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-intermediate-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(path.join(workspace, "docs"), { recursive: true });
  const runtime = await startServer({ port: 0, dataDirectory: directory, workspace, executeWithHarness: run });
  try {
    const created = await runtime.store.createProject({ title: "中间产物测试", goal: "多步骤制作汽车" });
    const project = runtime.store.project(created.id);
    await runtime.store.mutate(() => {
      Object.assign(project, { workspace, phase: "workspace", executionMode: "adaptive-graph", primaryArtifact: { filename: "index.html", kind: "html", acceptanceCriteria: ["入口可用"] }, steps });
    });
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": runtime.token };
    const runStep = (body) => fetch(`${runtime.url}/api/projects/${project.id}/run`, { method: "POST", headers, body: JSON.stringify({ mode: "sequential", ...body }) });
    const artifact = (filename, kind) => ({ filename, kind, projectRoot: workspace, files: [filename], content: "", dependencies: [] });
    await callback({ runtime, project, workspace, runStep, artifact });
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("规格文档留在节点，主模型不被后续核验报告覆盖，最终仍交付 HTML", async () => {
  let artifacts;
  await fixture([node("spec", "analyze"), node("model", "build", ["spec"]), node("report", "verify", ["model"])],
    async (_project, step) => result(artifacts[step.id]), async ({ project, workspace, artifact, runStep }) => {
      for (const file of ["docs/spec.md", "index.html", "docs/report.md"]) await writeFile(path.join(workspace, file), file.endsWith("html") ? "<!doctype html><main>汽车</main>" : "# 文档");
      artifacts = { spec: artifact("docs/spec.md", "markdown"), model: artifact("index.html", "html"), report: artifact("docs/report.md", "markdown") };
      const response = await runStep({ stepId: "spec" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).state.projects.find((item) => item.id === project.id).busy, false);
      assert.equal(project.steps[0].status, "approved");
      assert.equal(project.steps[0].result.artifact.filename, "docs/spec.md");
      assert.equal(project.artifact ?? null, null);
      assert.equal((await runStep({ stepId: "model" })).status, 200);
      assert.equal(project.artifact.filename, "index.html");
      assert.equal((await runStep({ stepId: "report" })).status, 200);
      assert.equal(project.steps[2].result.artifact.filename, "docs/report.md");
      assert.equal(project.artifactStepId, "model");
      assert.equal(project.artifact.filename, "index.html");
      assert.equal((await runStep({})).status, 200);
      assert.equal(project.phase, "complete");
      assert.equal(project.artifact.filename, "index.html");
      assert.equal(project.steps[2].result.artifact.filename, "docs/report.md");
    });
});

test("交付节点不能用规格文档冒充最终主产物，错误和停止状态可查询", async () => {
  let document;
  await fixture([node("deliver", "deliver")], async () => result(document), async ({ project, workspace, artifact, runStep, runtime }) => {
    await writeFile(path.join(workspace, "docs/spec.md"), "# 规格");
    document = artifact("docs/spec.md", "markdown");
    const response = await runStep({});
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /与锁定主交付物/);
    assert.equal(project.steps[0].status, "error");
    assert.equal(project.artifact ?? null, null);
    const { runtime: status } = await (await fetch(`${runtime.url}/api/projects/${project.id}/runtime`)).json();
    assert.equal(status.active, false);
    assert.match(status.activity, /执行失败.*docs\/spec.md/);
  });
});

test("中间产物仍检查真实文件存在和证据，不能绕过验证", async () => {
  let document;
  await fixture([node("spec", "build")], async () => result(document), async ({ project, artifact, runStep }) => {
    document = artifact("docs/missing.md", "markdown");
    const response = await runStep({});
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /入口文件不存在/);
    assert.equal(project.steps[0].status, "error");
  });
});

test("中间节点使用主入口文件名时也必须遵守锁定类型", async () => {
  let document;
  await fixture([node("spec", "analyze")], async () => result(document), async ({ project, workspace, artifact, runStep }) => {
    await writeFile(path.join(workspace, "index.html"), "# 错误类型");
    document = artifact("index.html", "markdown");
    const response = await runStep({ stepId: "spec" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /与锁定主交付物/);
    assert.equal(project.artifact ?? null, null);
  });
});

test("只有中间文档但缺少主入口时不能标记项目交付完成", async () => {
  let document;
  await fixture([node("spec", "build")], async () => result(document), async ({ project, workspace, artifact, runStep }) => {
    await writeFile(path.join(workspace, "docs/spec.md"), "# 规格");
    document = artifact("docs/spec.md", "markdown");
    const response = await runStep({});
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /必须返回完整产物/);
    assert.equal(project.phase, "workspace");
    assert.equal(project.artifact ?? null, null);
  });
});

test("并行分支等待澄清时，已完成分支也接受中间文档且不替换主产物", async () => {
  let document;
  await fixture([node("spec", "build"), node("question", "build")], async (_project, step) => step.id === "spec" ? result(document)
    : { needsUserDirection: true, directionQuestion: "需要哪种风格？", directionOptions: [], request: {}, rawOutput: "question" },
  async ({ project, workspace, artifact, runStep }) => {
    await writeFile(path.join(workspace, "docs/spec.md"), "# 规格");
    document = artifact("docs/spec.md", "markdown");
    const response = await runStep({ mode: "parallel" });
    assert.equal(response.status, 200);
    assert.equal(project.steps[0].status, "approved");
    assert.equal(project.steps[0].result.artifact.filename, "docs/spec.md");
    assert.equal(project.artifact ?? null, null);
    assert.equal(project.executionRun.status, "awaiting_direction");
  });
});
