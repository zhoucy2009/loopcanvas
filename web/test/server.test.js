import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { writeConversationRecord } from "../src/conversations.js";

test("本机服务提供页面并保护写接口", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-server-"));
  const explorationCalls = [];
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "workspace"),
    probeLocalAgents: async ({ dshPath }) => ({
      node: { found: true, path: process.execPath, version: process.version },
      dsh: { found: true, ready: true, path: dshPath, version: "test-dsh" },
      codex: { found: true, ready: true, path: "/test/codex", version: "test-codex", supportsAppServer: true }
    }),
    listCodexModels: async () => [{
      id: "gpt-test", model: "gpt-test", displayName: "GPT Test", isDefault: true,
      defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }]
    }],
    probeHarness: async (settings) => ({ version: settings.dshPath === "/bin/echo" ? "--version" : "0.1.0-rc.6" }),
    exploreWithHarness: async (input, settings) => {
      explorationCalls.push({ input, settings });
      return {
        result: { answer: "已整理艺术方向。", sources: [{ title: "Pinterest 搜索", url: "https://www.pinterest.com/search/pins/?q=bauhaus", type: "pinterest", credibility: "medium", credibilityReason: "灵感发现入口", projectRelevance: "视觉参考", summary: "用于发现相关图像" }], unknowns: [], nextQuestions: [] },
        request: { kind: "visual_art_research", explorationKind: input.kind },
        rawOutput: "{\"status\":\"success\"}"
      };
    }
  });
  try {
    await writeFile(path.join(directory, "AGENTS.md"), "# 测试规则\n");
    const page = await fetch(runtime.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /DSH Workflow/);

    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    assert.ok(bootstrap.token);
    assert.equal(bootstrap.runtime.address, "仅本机 127.0.0.1");
    assert.ok("codex" in bootstrap.installation);

    const denied = await fetch(`${runtime.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "不应创建" })
    });
    assert.equal(denied.status, 403);

    const probed = await fetch(`${runtime.url}/api/harness/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token },
      body: JSON.stringify({ dshPath: "/bin/echo" })
    });
    assert.equal(probed.status, 200);
    assert.equal((await probed.json()).probe.version, "--version");

    const agentsProbed = await fetch(`${runtime.url}/api/agents/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token },
      body: JSON.stringify({ dshPath: "/bin/echo" })
    });
    assert.equal(agentsProbed.status, 200);
    const agentsPayload = await agentsProbed.json();
    assert.equal(agentsPayload.installation.dsh.version, "test-dsh");
    assert.equal(agentsPayload.installation.codex.supportsAppServer, true);

    const modelsResponse = await fetch(`${runtime.url}/api/codex/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token },
      body: "{}"
    });
    assert.equal(modelsResponse.status, 200);
    assert.equal((await modelsResponse.json()).models[0].model, "gpt-test");

    const uploaded = await fetch(`${runtime.url}/api/attachments`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-File-Name": encodeURIComponent("需求.txt"), "X-LoopCanvas-Token": bootstrap.token },
      body: "附件需求"
    });
    assert.equal(uploaded.status, 201);
    const uploadedPayload = await uploaded.json();
    assert.equal(uploadedPayload.attachment.kind, "text");

    const attachmentContent = await fetch(`${runtime.url}/api/attachments/${uploadedPayload.attachment.id}/content`);
    assert.equal(await attachmentContent.text(), "附件需求");

    const created = await fetch(`${runtime.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token },
      body: JSON.stringify({ goal: "允许创建", attachmentIds: [uploadedPayload.attachment.id] })
    });
    assert.equal(created.status, 201);
    const payload = await created.json();
    assert.equal(payload.state.projects[0].goal, "允许创建");
    assert.equal(payload.state.projects[0].attachments.length, 1);
    const runtimeStatus = await (await fetch(`${runtime.url}/api/projects/${payload.state.projects[0].id}/runtime`)).json();
    assert.equal(runtimeStatus.runtime.active, false);
    assert.equal(runtimeStatus.runtime.activity, "等待自动执行");
    assert.equal(runtimeStatus.runtime.metrics, null);

    const artExploration = await fetch(`${runtime.url}/api/explore`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token },
      body: JSON.stringify({ projectId: payload.state.projects[0].id, kind: "art", query: "包豪斯海报" })
    });
    assert.equal(artExploration.status, 200);
    const artPayload = await artExploration.json();
    assert.equal(artPayload.thread.kind, "art");
    assert.equal(artPayload.thread.messages.at(-1).details.sources[0].type, "pinterest");
    assert.equal(explorationCalls.at(-1).input.kind, "art");
    assert.match(explorationCalls.at(-1).settings.dshPluginPatch, /- id: tool-web\n  disabled: false/);

    const mixedExploration = await fetch(`${runtime.url}/api/explore`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token },
      body: JSON.stringify({ projectId: payload.state.projects[0].id, threadId: artPayload.thread.id, kind: "research", query: "改成技术研究" })
    });
    assert.equal(mixedExploration.status, 400);

    const drafted = await fetch(`${runtime.url}/api/projects/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token },
      body: "{}"
    });
    assert.equal(drafted.status, 201);
    const draftPayload = await drafted.json();
    assert.equal(draftPayload.state.projects.length, 2);
    assert.equal(draftPayload.state.projects[0].goal, "");
    assert.equal(draftPayload.state.activeProjectId, draftPayload.state.projects[0].id);
    assert.equal(draftPayload.state.projects[1].goal, "允许创建");

    const pinned = await (await fetch(`${runtime.url}/api/projects/${payload.state.projects[0].id}/pin`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token }, body: JSON.stringify({ pinned: true })
    })).json();
    assert.ok(pinned.state.projects.find((item) => item.id === payload.state.projects[0].id).pinnedAt);
    const archivedTask = await (await fetch(`${runtime.url}/api/projects/${payload.state.projects[0].id}/archive`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token }, body: "{}"
    })).json();
    assert.equal(archivedTask.state.projects.some((item) => item.id === payload.state.projects[0].id), false);
    assert.equal(archivedTask.state.archivedProjects.find((item) => item.id === payload.state.projects[0].id).pinnedAt, null);
    const restoredTask = await (await fetch(`${runtime.url}/api/projects/${payload.state.projects[0].id}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token }, body: "{}"
    })).json();
    assert.equal(restoredTask.state.activeProjectId, payload.state.projects[0].id);
    assert.equal(restoredTask.state.archivedProjects.some((item) => item.id === payload.state.projects[0].id), false);

    const project = runtime.store.project(payload.state.projects[0].id);
    await runtime.store.mutate(() => {
      project.artifact = { title: "交互预览", kind: "html", content: "<button id=ok>可交互</button><script>document.body.dataset.ready='yes'</script>", filename: "index.html", files: [] };
      project.learningThreads = [{ id: "thread-one", title: "src/main.js:1-1", module: "explanation", selection: { filePath: "src/main.js", startLine: 1, endLine: 1, code: "const value = 1;" }, messages: [] }];
    });
    const archiveThread = await (await fetch(`${runtime.url}/api/projects/${project.id}/learning/threads/thread-one`, { method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token }, body: JSON.stringify({ action: "archive" }) })).json();
    assert.equal(archiveThread.state.projects.find((item) => item.id === project.id).archivedLearningThreads[0].id, "thread-one");
    const restoreThread = await (await fetch(`${runtime.url}/api/projects/${project.id}/learning/threads/thread-one`, { method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token }, body: JSON.stringify({ action: "restore" }) })).json();
    assert.equal(restoreThread.state.projects.find((item) => item.id === project.id).learningThreads[0].id, "thread-one");
    const deleteThread = await (await fetch(`${runtime.url}/api/projects/${project.id}/learning/threads/thread-one`, { method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token }, body: JSON.stringify({ action: "delete" }) })).json();
    assert.equal(deleteThread.state.projects.find((item) => item.id === project.id).deletedLearningThreads[0].id, "thread-one");
    const restoreDeletedThread = await (await fetch(`${runtime.url}/api/projects/${project.id}/learning/threads/thread-one`, { method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token }, body: JSON.stringify({ action: "restore-deleted" }) })).json();
    assert.equal(restoreDeletedThread.state.projects.find((item) => item.id === project.id).learningThreads[0].id, "thread-one");
    const preview = await fetch(`${runtime.url}/preview/${project.id}/`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-security-policy"), /connect-src 'none'/);
    const previewHTML = await preview.text();
    assert.match(previewHTML, /dshwf-preview-error/);
    assert.match(previewHTML, /dataset\.ready/);

    const agents = await (await fetch(`${runtime.url}/api/capabilities/agents`)).json();
    assert.match(agents.document.content, /测试规则/);

    const diagnostics = await (await fetch(`${runtime.url}/api/diagnostics`)).json();
    assert.deepEqual(diagnostics.items, []);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("预览使用嵌套入口 URL 并加载同目录本地资源", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-nested-preview-"));
  const workspace = path.join(directory, "workspace");
  const runtime = await startServer({ port: 0, dataDirectory: directory, workspace });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "嵌套预览" }) })).json();
    const project = runtime.store.project(created.state.projects[0].id);
    await mkdir(path.join(project.workspace, "engine-model"), { recursive: true });
    await writeFile(path.join(project.workspace, "engine-model", "index.html"), '<!doctype html><link rel="stylesheet" href="./styles.css"><main>预览</main>');
    await writeFile(path.join(project.workspace, "engine-model", "styles.css"), "main { color: green; }");
    await runtime.store.mutate(() => {
      project.artifact = {
        title: "嵌套预览", kind: "html", content: "", filename: "engine-model/index.html",
        projectRoot: project.workspace, files: ["engine-model/index.html", "engine-model/styles.css"], dependencies: []
      };
    });

    const preview = await fetch(`${runtime.url}/preview/${project.id}/`);
    assert.equal(preview.status, 200);
    assert.ok(preview.url.endsWith(`/preview/${project.id}/engine-model/index.html`));
    const previewCSP = preview.headers.get("content-security-policy") ?? "";
    assert.match(previewCSP, /style-src[^;]*'self'/);
    assert.ok(previewCSP.includes(runtime.url));
    const previewHTML = await preview.text();
    assert.match(previewHTML, /preview-trace\.js/);
    assert.match(previewHTML, /\[hidden\]\{display:none!important\}/);
    const stylesheet = await fetch(new URL("./styles.css", preview.url));
    assert.equal(stylesheet.status, 200);
    assert.equal(await stylesheet.text(), "main { color: green; }");
    assert.equal((await fetch(`${runtime.url}/preview/${project.id}/styles.css`)).status, 403);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("预览通过同源代理加载已声明 CDN 依赖并拒绝未声明资源", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-preview-dependency-"));
  const fetched = [];
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "workspace"),
    fetchPreviewDependency: async (resource, options) => {
      fetched.push({ resource, redirect: options.redirect });
      return new Response("window.THREE = { proxied: true };", { status: 200, headers: { "Content-Type": "application/javascript" } });
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "联网 Three.js 预览" }) })).json();
    const project = runtime.store.project(created.state.projects[0].id);
    const remote = "https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.min.js";
    await runtime.store.mutate(() => {
      project.artifact = {
        title: "联网预览", kind: "html", filename: "index.html", files: [], dependencies: ["three@0.160.1"],
        content: `<script src="${remote}"></script><script>document.body.dataset.loaded = String(Boolean(window.THREE))</script>`
      };
    });

    const preview = await fetch(`${runtime.url}/preview/${project.id}/`);
    const html = await preview.text();
    assert.doesNotMatch(html, new RegExp(`<script src=["']${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(html, /data-loopcanvas-remote-src="https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.160\.1\/build\/three\.min\.js"/);
    const proxyPath = html.match(/<script src="([^"]*__dependency__\/[^"]+)"/)?.[1];
    assert.ok(proxyPath);
    const dependency = await fetch(new URL(proxyPath, runtime.url));
    assert.equal(dependency.status, 200);
    assert.equal(dependency.headers.get("access-control-allow-origin"), "*");
    assert.equal(dependency.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(await dependency.text(), "window.THREE = { proxied: true };");
    assert.deepEqual(fetched, [{ resource: remote, redirect: "error" }]);

    const undeclared = await fetch(`${runtime.url}/preview/${project.id}/__dependency__/cdn.jsdelivr.net/npm/react@19.0.0/index.js`);
    assert.equal(undeclared.status, 403);
    assert.equal(fetched.length, 1);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("单步校验失败会在同一次执行内自动修复并保留拒绝记录", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-retry-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "index.html"), "<!doctype html><title>ok</title>\n");
  const feedbacks = [];
  let attempt = 0;
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace,
    executeWithHarness: async (_project, _step, _settings, feedback) => {
      feedbacks.push(feedback);
      attempt += 1;
      const filename = attempt === 1 ? "apple.obj" : "index.html";
      return {
        request: { id: `request-${attempt}` },
        rawOutput: JSON.stringify({ attempt, filename }),
        result: {
          assistantMessage: "当前步骤已执行。",
          summary: "测试产物",
          actualChanges: [filename],
          evidence: [filename],
          deviation: "无",
          rollback: "删除测试文件",
          artifact: { title: "测试产物", kind: "text", content: "完整内容", filename, projectRoot: workspace, files: [] }
        }
      };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "导出 OBJ" }) })).json();
    const project = runtime.store.project(created.state.projects[0].id);
    await runtime.store.mutate(() => {
      project.workspace = workspace;
      project.steps = [{
        id: "export-obj", title: "导出 OBJ", purpose: "生成可核查的模型文件", kind: "build", status: "ready",
        revision: 1, riskLevel: "L1", appliedDirectiveIDs: [], dependencies: [], conversation: [],
        options: [{ id: "standard-obj", title: "标准 OBJ", isRecommended: true }], selectedOptionId: "standard-obj"
      }];
      project.selectedStepId = "export-obj";
    });

    const response = await fetch(`${runtime.url}/api/projects/${project.id}/steps/export-obj/execute`, { method: "POST", headers, body: JSON.stringify({ feedback: "保留法线。" }) });
    assert.equal(response.status, 200);
    assert.equal(attempt, 2);
    assert.equal(feedbacks[0], "保留法线。");
    assert.match(feedbacks[1], /^保留法线。/);
    assert.match(feedbacks[1], /自动纠错/);
    assert.match(feedbacks[1], /上一结果被客观校验拒绝：产物入口文件不存在：apple\.obj/);
    assert.match(feedbacks[1], /不要只改返回 JSON/);
    const completed = runtime.store.project(project.id);
    assert.equal(completed.steps[0].status, "review");
    assert.equal(completed.pendingAction, null);
    assert.match(completed.decisionLog.at(-1).title, /自动纠错已通过/);
    const records = await (await fetch(`${runtime.url}/api/projects/${project.id}/conversations`)).json();
    assert.equal(records.items.length, 2);
    assert.deepEqual(new Set(records.items.map((item) => item.status)), new Set(["failed", "success"]));
    const rejected = records.items.find((item) => item.status === "failed");
    const rejectedDetail = await (await fetch(`${runtime.url}/api/projects/${project.id}/conversations/${encodeURIComponent(rejected.id)}`)).json();
    assert.match(rejectedDetail.record.output, /\"attempt\":1/);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("自动修复达到上限仍不会提交未通过校验的结果", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-retry-limit-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  let attempt = 0;
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace,
    executeWithHarness: async () => {
      attempt += 1;
      const filename = `missing-${attempt}.txt`;
      return {
        request: { id: `request-${attempt}` },
        rawOutput: JSON.stringify({ attempt, filename }),
        result: {
          assistantMessage: "错误地声明已完成。",
          summary: "不存在的产物",
          actualChanges: [filename],
          evidence: [filename],
          deviation: "无",
          rollback: "无修改",
          artifact: { title: "坏产物", kind: "text", content: "声明内容", filename, projectRoot: workspace, files: [] }
        }
      };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "生成文本产物" }) })).json();
    const project = runtime.store.project(created.state.projects[0].id);
    await runtime.store.mutate(() => {
      project.workspace = workspace;
      project.steps = [{
        id: "build-text", title: "生成文本", purpose: "生成真实文件", kind: "build", status: "ready",
        revision: 1, riskLevel: "L1", appliedDirectiveIDs: [], dependencies: [], conversation: [],
        options: [{ id: "plain-text", title: "纯文本", isRecommended: true }], selectedOptionId: "plain-text"
      }];
      project.selectedStepId = "build-text";
    });

    const response = await fetch(`${runtime.url}/api/projects/${project.id}/steps/build-text/execute`, { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 400);
    assert.equal(attempt, 3);
    const failed = runtime.store.project(project.id);
    assert.equal(failed.steps[0].status, "ready");
    assert.equal(failed.steps[0].result, undefined);
    assert.equal(failed.artifact, null);
    assert.match(failed.pendingAction.error, /产物入口文件不存在：missing-3\.txt/);
    const records = await (await fetch(`${runtime.url}/api/projects/${project.id}/conversations`)).json();
    assert.equal(records.items.length, 3);
    assert.ok(records.items.every((item) => item.status === "failed"));
    assert.ok(records.items.every((item) => /自动校验拒绝/.test(item.error)));
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("自动纠错调用失败时保留上一条具体校验原因", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-retry-cause-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  let attempt = 0;
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace,
    executeWithHarness: async () => {
      attempt += 1;
      if (attempt === 2) throw new Error("Agent 执行失败。");
      return {
        request: { id: "specific-cause" },
        rawOutput: "{}",
        result: {
          assistantMessage: "错误地声明完成。",
          summary: "缺少真实入口",
          actualChanges: ["missing.html"],
          evidence: ["missing.html"],
          deviation: "无",
          rollback: "无修改",
          artifact: { title: "缺失产物", kind: "html", content: "<main>未落盘</main>", filename: "missing.html", projectRoot: workspace, files: [] }
        }
      };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "保留失败原因" }) })).json();
    const project = runtime.store.project(created.state.projects[0].id);
    await runtime.store.mutate(() => {
      project.executionMode = "stepwise";
      project.steps = [{
        id: "build", title: "构建入口", purpose: "创建入口文件", kind: "build", status: "ready",
        revision: 1, riskLevel: "L1", appliedDirectiveIDs: [], dependencies: [], conversation: [],
        options: [{ id: "html", title: "HTML", isRecommended: true }], selectedOptionId: "html"
      }];
      project.selectedStepId = "build";
    });

    const response = await fetch(`${runtime.url}/api/projects/${project.id}/steps/build/execute`, { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 400);
    assert.equal(attempt, 2);
    const failed = runtime.store.project(project.id);
    assert.match(failed.lastError, /产物入口文件不存在：missing\.html/);
    assert.match(failed.lastError, /自动纠错重试又失败：Agent 执行失败/);
    assert.equal(failed.pendingAction.error, failed.lastError);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("子进程校验失败也会自动修复且只提交当前子进程", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-subprocess-retry-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  let attempt = 0;
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace,
    executeWithHarness: async () => {
      attempt += 1;
      return {
        request: { id: `request-${attempt}` },
        rawOutput: JSON.stringify({ attempt }),
        result: {
          assistantMessage: "当前子进程已执行。",
          summary: "核对集成边界",
          actualChanges: [],
          evidence: ["已核对输入、输出与受影响模块"],
          deviation: "无",
          rollback: "无文件修改",
          artifact: attempt === 1
            ? { title: "错误声明", kind: "text", content: "预期文件", filename: "not-created.md", projectRoot: workspace, files: [] }
            : null
        }
      };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "集成多模块应用" }) })).json();
    const project = runtime.store.project(created.state.projects[0].id);
    await runtime.store.mutate(() => {
      project.workspace = workspace;
      project.steps = [{
        id: "integrate", title: "集成模块", purpose: "连接已有模块", kind: "integrate", status: "ready",
        revision: 1, riskLevel: "L1", appliedDirectiveIDs: [], dependencies: [], conversation: [], result: null,
        options: [{ id: "direct", title: "直接集成", isRecommended: true }], selectedOptionId: "direct",
        selectedSubprocessId: "boundary",
        subprocesses: [
          { id: "boundary", title: "确认集成边界", purpose: "核对输入输出", status: "ready", revision: 1, options: [{ id: "boundary-contract", title: "按现有接口核对", isRecommended: true }], selectedOptionId: "boundary-contract", result: null, resultHistory: [], debugRecords: [] },
          { id: "connect", title: "完成集成", purpose: "连接模块", status: "locked", revision: 1, options: [{ id: "connect-adapter", title: "增加适配层", isRecommended: true }], selectedOptionId: "connect-adapter", result: null, resultHistory: [], debugRecords: [] }
        ]
      }];
      project.selectedStepId = "integrate";
    });

    const response = await fetch(`${runtime.url}/api/projects/${project.id}/steps/integrate/execute`, {
      method: "POST", headers, body: JSON.stringify({ subprocessId: "boundary" })
    });
    assert.equal(response.status, 200);
    assert.equal(attempt, 2);
    const reviewed = runtime.store.project(project.id);
    assert.equal(reviewed.steps[0].status, "review");
    assert.equal(reviewed.steps[0].subprocesses[0].status, "review");
    assert.equal(reviewed.steps[0].subprocesses[1].status, "locked");
    assert.equal(reviewed.artifact, null);

    const approved = await (await fetch(`${runtime.url}/api/projects/${project.id}/steps/integrate/approve`, { method: "POST", headers, body: "{}" })).json();
    const advanced = approved.state.projects.find((item) => item.id === project.id).steps[0];
    assert.equal(advanced.status, "ready");
    assert.equal(advanced.subprocesses[0].status, "approved");
    assert.equal(advanced.subprocesses[1].status, "ready");
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("项目改名、工作目录、项目规则与完整对话记录接口", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-project-"));
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "workspace"),
    extractPublicSource: async () => ({
      content: "这是从来源页面读取到的完整正文。\n\n```js\nexport const parsed = true;\n```",
      metadata: { finalUrl: "https://example.com/article", contentType: "text/html", charCount: 65, truncated: false, codeBlockCount: 1 }
    }),
    runProcess: async (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args.slice(0, 2), ["clone", "--depth"]);
      const destination = args.at(-1);
      await mkdir(path.join(destination, "src"), { recursive: true });
      await writeFile(path.join(destination, "src", "dragged-repository.js"), "export function highlighted() { return true; }\n");
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "制作一个离线工具" }) })).json();
    const id = created.state.projects[0].id;
    assert.ok(created.state.projects[0].workspace.endsWith(`-${id.slice(0, 8)}`));

    const renamed = await (await fetch(`${runtime.url}/api/projects/${id}/rename`, { method: "POST", headers, body: JSON.stringify({ title: "离线工具箱" }) })).json();
    assert.equal(renamed.project.title, "离线工具箱");

    const badWorkspace = await fetch(`${runtime.url}/api/projects/${id}/workspace`, { method: "POST", headers, body: JSON.stringify({ workspace: path.join(directory, "不存在的目录") }) });
    assert.equal(badWorkspace.status, 400);

    const blankWorkspace = await (await fetch(`${runtime.url}/api/projects/${id}/workspace`, { method: "POST", headers, body: JSON.stringify({ workspace: "" }) })).json();
    assert.match(blankWorkspace.project.workspace, /离线工具箱/);

    await mkdir(path.join(blankWorkspace.project.workspace, "src"), { recursive: true });
    await writeFile(path.join(blankWorkspace.project.workspace, "src", "main.js"), "export const answer = 42;\n");
    const sourceList = await (await fetch(`${runtime.url}/api/projects/${id}/source`)).json();
    assert.deepEqual(sourceList.files, ["src/main.js"]);
    const sourceFile = await (await fetch(`${runtime.url}/api/projects/${id}/source?path=${encodeURIComponent("src/main.js")}`)).json();
    assert.match(sourceFile.file.content, /answer = 42/);
    const escapedSource = await fetch(`${runtime.url}/api/projects/${id}/source?path=${encodeURIComponent("../state.json")}`);
    assert.equal(escapedSource.status, 400);

    const localSourceRoot = path.join(directory, "external-source");
    await mkdir(localSourceRoot, { recursive: true });
    await writeFile(path.join(localSourceRoot, "helper.py"), "def answer(): return 42\n");
    const addedLocal = await (await fetch(`${runtime.url}/api/projects/${id}/learning/sources/local`, { method: "POST", headers, body: JSON.stringify({ folderPath: localSourceRoot }) })).json();
    assert.equal(addedLocal.source.type, "local");
    const localList = await (await fetch(`${runtime.url}/api/projects/${id}/source?sourceId=${encodeURIComponent(addedLocal.source.id)}`)).json();
    assert.deepEqual(localList.files, ["helper.py"]);
    assert.equal(localList.sources.length, 2);

    const importStarted = await (await fetch(`${runtime.url}/api/projects/${id}/learning/sources/import`, { method: "POST", headers, body: JSON.stringify({ title: "桌面示例" }) })).json();
    const traversalUpload = await fetch(`${runtime.url}/api/projects/${id}/learning/sources/import/${importStarted.importId}/file`, {
      method: "POST", headers: { "X-LoopCanvas-Token": bootstrap.token, "X-Learning-Path": encodeURIComponent("../secret.js"), "Content-Type": "application/octet-stream" }, body: "secret"
    });
    assert.equal(traversalUpload.status, 400);
    const importedFile = await fetch(`${runtime.url}/api/projects/${id}/learning/sources/import/${importStarted.importId}/file`, {
      method: "POST", headers: { "X-LoopCanvas-Token": bootstrap.token, "X-Learning-Path": encodeURIComponent("desktop/src/view.ts"), "Content-Type": "application/octet-stream" }, body: "export const view = true;\n"
    });
    assert.equal(importedFile.status, 201);
    const committedImport = await (await fetch(`${runtime.url}/api/projects/${id}/learning/sources/import/${importStarted.importId}`, { method: "POST", headers, body: "{}" })).json();
    assert.equal(committedImport.source.type, "upload");
    assert.equal(committedImport.source.fileCount, 1);
    const importedList = await (await fetch(`${runtime.url}/api/projects/${id}/source?sourceId=${encodeURIComponent(committedImport.source.id)}`)).json();
    assert.deepEqual(importedList.files, ["desktop/src/view.ts"]);

    const badRepository = await fetch(`${runtime.url}/api/projects/${id}/learning/sources/github`, { method: "POST", headers, body: JSON.stringify({ url: "https://example.com/not/github" }) });
    assert.equal(badRepository.status, 400);

    const importedRepository = await (await fetch(`${runtime.url}/api/projects/${id}/learning/sources/github`, { method: "POST", headers, body: JSON.stringify({ url: "https://github.com/example/dragged-repository.git?tab=readme" }) })).json();
    assert.equal(importedRepository.source.type, "github");
    assert.equal(importedRepository.source.url, "https://github.com/example/dragged-repository");
    const repositoryFiles = await (await fetch(`${runtime.url}/api/projects/${id}/source?sourceId=${encodeURIComponent(importedRepository.source.id)}`)).json();
    assert.deepEqual(repositoryFiles.files, ["src/dragged-repository.js"]);
    const repositoryFile = await (await fetch(`${runtime.url}/api/projects/${id}/source?sourceId=${encodeURIComponent(importedRepository.source.id)}&path=${encodeURIComponent("src/dragged-repository.js")}`)).json();
    assert.match(repositoryFile.file.content, /function highlighted/);

    const referenced = await (await fetch(`${runtime.url}/api/projects/${id}/references`, { method: "POST", headers, body: JSON.stringify({ reference: { type: "museum", title: "海报参考", url: "https://museum.example/work", summary: "高对比信息层级", origin: "exploration", mediaKind: "image", previewURL: "https://images.example/work.jpg", creator: "示例艺术家", license: "CC BY 4.0", licenseURL: "https://creativecommons.org/licenses/by/4.0/", sourceName: "示例博物馆", width: 1200, height: 1600, visualDescription: "大标题位于左上，留白集中在右下。", visual: { mode: "vision-model", pixelAccess: true, agentText: "客户端伪造文本" } } }) })).json();
    assert.equal(referenced.reference.previewURL, "https://images.example/work.jpg");
    assert.equal(referenced.reference.visual.mode, "metadata-only");
    assert.equal(referenced.reference.visual.pixelAccess, false);
    assert.doesNotMatch(referenced.reference.visual.agentText, /客户端伪造文本/);
    assert.match(referenced.reference.visual.agentText, /纯文本 Agent 未读取图片像素/);
    assert.match(referenced.reference.visual.agentText, /示例艺术家/);
    assert.match(runtime.store.project(id).context.find((item) => item.id === referenced.reference.contextId).content, /metadata-only/);
    assert.equal(referenced.state.projects.find((item) => item.id === id).executionReferences.length, 1);
    assert.match(referenced.state.projects.find((item) => item.id === id).context.at(-1).content, /海报参考/);
    assert.ok(referenced.reference.contextId);

    const learningMaterial = await (await fetch(`${runtime.url}/api/projects/${id}/learning/materials`, { method: "POST", headers, body: JSON.stringify({ reference: { type: "article", title: "拖入的资料", url: "https://example.com/article", summary: "先加入学习文件栏" } }) })).json();
    assert.equal(learningMaterial.material.title, "拖入的资料");
    assert.equal(learningMaterial.material.extractionStatus, "success");
    assert.match(learningMaterial.material.extractedContent, /export const parsed = true/);
    assert.equal(learningMaterial.material.extractionMetadata.codeBlockCount, 1);
    assert.equal(learningMaterial.state.projects.find((item) => item.id === id).learningMaterials.length, 1);

    const summaryOnlyMaterial = await (await fetch(`${runtime.url}/api/projects/${id}/learning/materials`, { method: "POST", headers, body: JSON.stringify({ reference: { type: "note", title: "无链接探索笔记", summary: "这里只有探索阶段的简介", origin: "exploration" } }) })).json();
    assert.equal(summaryOnlyMaterial.material.extractionStatus, "summary-only");
    assert.equal(summaryOnlyMaterial.material.extractedContent, "");
    assert.equal(summaryOnlyMaterial.state.projects.find((item) => item.id === id).learningMaterials.length, 2);

    const removedReference = await (await fetch(`${runtime.url}/api/projects/${id}/references/${encodeURIComponent(referenced.reference.id)}`, { method: "DELETE", headers, body: "{}" })).json();
    const projectAfterReferenceRemoval = removedReference.state.projects.find((item) => item.id === id);
    assert.equal(projectAfterReferenceRemoval.executionReferences.length, 0);
    assert.equal(projectAfterReferenceRemoval.context.some((item) => item.id === referenced.reference.contextId), false);
    assert.equal(projectAfterReferenceRemoval.learningMaterials.length, 2, "移除执行参考不能删除学习资料源");

    const shelfKey = `material:${encodeURIComponent(learningMaterial.material.id)}`;
    const pinnedShelf = await (await fetch(`${runtime.url}/api/projects/${id}/learning/shelf`, {
      method: "POST", headers, body: JSON.stringify({ key: shelfKey, action: "pin" })
    })).json();
    assert.deepEqual(pinnedShelf.state.projects.find((item) => item.id === id).learningShelf, {
      pinned: [shelfKey], archived: []
    });

    const archivedShelf = await (await fetch(`${runtime.url}/api/projects/${id}/learning/shelf`, {
      method: "POST", headers, body: JSON.stringify({ key: shelfKey, action: "archive" })
    })).json();
    const archivedProject = archivedShelf.state.projects.find((item) => item.id === id);
    assert.deepEqual(archivedProject.learningShelf, { pinned: [], archived: [shelfKey] });
    assert.equal(archivedProject.learningMaterials.length, 2, "归档只影响文件栏，不删除学习资料");

    const restoredShelf = await (await fetch(`${runtime.url}/api/projects/${id}/learning/shelf`, {
      method: "POST", headers, body: JSON.stringify({ key: shelfKey, action: "restore" })
    })).json();
    assert.deepEqual(restoredShelf.state.projects.find((item) => item.id === id).learningShelf, {
      pinned: [], archived: []
    });

    const documents = await (await fetch(`${runtime.url}/api/projects/${id}/documents`)).json();
    assert.match(documents.documents.agents.content, /离线工具箱/);
    assert.match(documents.documents.constitution.content, /项目宪法/);

    const saved = await fetch(`${runtime.url}/api/projects/${id}/documents`, { method: "POST", headers, body: JSON.stringify({ name: "宪法.md", content: "# 新宪法\n" }) });
    assert.equal(saved.status, 200);
    const documentsAfter = await (await fetch(`${runtime.url}/api/projects/${id}/documents`)).json();
    assert.match(documentsAfter.documents.constitution.content, /新宪法/);

    const empty = await (await fetch(`${runtime.url}/api/projects/${id}/conversations`)).json();
    assert.deepEqual(empty.items, []);
    await writeConversationRecord(directory, { projectId: id, operation: "plan", status: "success", request: { id: "req-1" }, output: "{\"ok\":true}" });
    const list = await (await fetch(`${runtime.url}/api/projects/${id}/conversations`)).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].operation, "plan");
    const detail = await (await fetch(`${runtime.url}/api/projects/${id}/conversations/${encodeURIComponent(list.items[0].id)}`)).json();
    assert.deepEqual(detail.record.request, { id: "req-1" });
    assert.match(detail.record.output, /ok/);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("暂停后可立即恢复，旧调用收尾不会清除新调用", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-pause-"));
  let callCount = 0;
  let startFirst;
  let startSecond;
  let rejectFirst;
  let rejectSecond;
  const firstStarted = new Promise((resolve) => { startFirst = resolve; });
  const secondStarted = new Promise((resolve) => { startSecond = resolve; });
  const planWithHarness = (_project, _settings, signal) => new Promise((_resolve, reject) => {
    callCount += 1;
    if (callCount === 1) {
      rejectFirst = reject;
      startFirst();
      signal.addEventListener("abort", () => setTimeout(() => rejectFirst(new Error("任务已暂停，Harness 进程已取消。")), 25), { once: true });
    } else {
      rejectSecond = reject;
      startSecond();
      signal.addEventListener("abort", () => rejectSecond(new Error("任务已暂停，Harness 进程已取消。")), { once: true });
    }
  });
  const runtime = await startServer({ port: 0, dataDirectory: directory, workspace: path.join(directory, "workspace"), planWithHarness });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "验证暂停恢复" }) })).json();
    const id = created.state.projects[0].id;

    const firstPlan = fetch(`${runtime.url}/api/projects/${id}/plan`, { method: "POST", headers, body: JSON.stringify({ goal: "验证暂停恢复" }) });
    await firstStarted;
    const paused = await (await fetch(`${runtime.url}/api/projects/${id}/pause`, { method: "POST", headers, body: "{}" })).json();
    const pausedProject = paused.state.projects.find((project) => project.id === id);
    assert.equal(pausedProject.busy, false);
    assert.equal(pausedProject.isPaused, true);
    assert.equal(pausedProject.lastError, null);
    assert.equal(pausedProject.pendingAction.status, "cancelled");

    const resumed = await (await fetch(`${runtime.url}/api/projects/${id}/resume`, { method: "POST", headers, body: "{}" })).json();
    assert.equal(resumed.state.projects.find((project) => project.id === id).isPaused, false);

    const secondPlan = fetch(`${runtime.url}/api/projects/${id}/plan`, { method: "POST", headers, body: JSON.stringify({ goal: "验证暂停恢复" }) });
    await secondStarted;
    assert.equal((await firstPlan).status, 400);
    const duringSecond = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    assert.equal(duringSecond.state.projects.find((project) => project.id === id).busy, true);

    await fetch(`${runtime.url}/api/projects/${id}/pause`, { method: "POST", headers, body: "{}" });
    assert.equal((await secondPlan).status, 400);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("大步骤按子进程逐个执行和验收，最后子进程才要求完整产物", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-subprocess-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "index.html"), "<!doctype html><button>完成</button>\n");
  let calls = 0;
  const runtime = await startServer({
    port: 0, dataDirectory: directory, workspace,
    executeWithHarness: async (_project, step) => {
      calls += 1;
      const final = step.selectedSubprocessId === "process-final";
      return {
        request: { id: `subprocess-${calls}` }, rawOutput: "{}",
        result: {
          assistantMessage: final ? "交付物已核对。" : "边界已确认。",
          summary: final ? "完整产物" : "范围清单",
          actualChanges: final ? ["index.html"] : [], evidence: [final ? "index.html 可读" : "边界清单已记录"], deviation: "无", rollback: "恢复前一版本",
          artifact: final ? { title: "测试页面", kind: "html", content: "<!doctype html><button>完成</button>", filename: "index.html", projectRoot: workspace, files: [] } : null
        }
      };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "分段交付页面" }) })).json();
    const project = runtime.store.project(created.state.projects[0].id);
    await runtime.store.mutate(() => {
      project.workspace = workspace;
      project.steps = [{
        id: "build-page", title: "制作页面", purpose: "完成页面", kind: "build", status: "ready", revision: 1,
        riskLevel: "L1", appliedDirectiveIDs: [], dependencies: [], conversation: [], debugRecords: [],
        options: [{ id: "plain", title: "原生", isRecommended: true }], selectedOptionId: "plain", selectedSubprocessId: "process-scope",
        subprocesses: [
          { id: "process-scope", title: "确认边界", purpose: "记录范围", status: "ready", revision: 1, options: [{ id: "scope-minimal", title: "最小交付范围", isRecommended: true }], selectedOptionId: "scope-minimal", result: null, resultHistory: [], debugRecords: [] },
          { id: "process-final", title: "完成页面", purpose: "生成完整产物", status: "locked", revision: 1, options: [{ id: "final-static", title: "静态页面交付", isRecommended: true }], selectedOptionId: "final-static", result: null, resultHistory: [], debugRecords: [] }
        ]
      }];
      project.selectedStepId = "build-page";
    });
    const first = await fetch(`${runtime.url}/api/projects/${project.id}/steps/build-page/execute`, { method: "POST", headers, body: JSON.stringify({ subprocessId: "process-scope" }) });
    assert.equal(first.status, 200);
    assert.equal(runtime.store.project(project.id).steps[0].subprocesses[0].status, "review");
    await fetch(`${runtime.url}/api/projects/${project.id}/steps/build-page/approve`, { method: "POST", headers, body: "{}" });
    assert.equal(runtime.store.project(project.id).steps[0].subprocesses[1].status, "ready");
    const second = await fetch(`${runtime.url}/api/projects/${project.id}/steps/build-page/execute`, { method: "POST", headers, body: JSON.stringify({ subprocessId: "process-final" }) });
    assert.equal(second.status, 200);
    assert.equal(runtime.store.project(project.id).artifactSubprocessId, "process-final");
    await fetch(`${runtime.url}/api/projects/${project.id}/steps/build-page/approve`, { method: "POST", headers, body: "{}" });
    assert.equal(runtime.store.project(project.id).steps[0].status, "approved");
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("锁定计划仍可选择方案，执行前检查会阻止缺依赖或跳过前序子进程", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-open-plan-"));
  let executeCalls = 0;
  const runtime = await startServer({
    port: 0, dataDirectory: directory, workspace: path.join(directory, "workspace"),
    executeWithHarness: async () => { executeCalls += 1; throw new Error("不应调用 Agent"); }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "开放查看计划" }) })).json();
    const project = runtime.store.project(created.state.projects[0].id);
    await runtime.store.mutate(() => {
      project.steps = [
        { id: "scope", title: "确认范围", purpose: "", kind: "decision", status: "ready", revision: 1, riskLevel: "L1", dependencies: [], conversation: [], debugRecords: [], options: [{ id: "a", title: "A" }], selectedOptionId: "a", subprocesses: [] },
        { id: "build", title: "制作页面", purpose: "", kind: "build", status: "locked", revision: 1, riskLevel: "L1", dependencies: ["scope"], conversation: [], debugRecords: [], options: [{ id: "legacy-b", title: "旧步骤方案" }], selectedOptionId: "legacy-b", selectedSubprocessId: "write", subprocesses: [
          { id: "read", title: "读取状态", purpose: "", status: "locked", revision: 1, options: [{ id: "read-a", title: "读取关键文件" }, { id: "read-b", title: "读取完整清单", isRecommended: true }], selectedOptionId: "read-b", result: null, resultHistory: [], debugRecords: [] },
          { id: "write", title: "实施改动", purpose: "", status: "locked", revision: 1, options: [{ id: "write-a", title: "局部修改", isRecommended: true }, { id: "write-b", title: "替换实现" }], selectedOptionId: "write-a", result: null, resultHistory: [], debugRecords: [] }
        ] }
      ];
    });
    const selected = await fetch(`${runtime.url}/api/projects/${project.id}/steps/build/select`, { method: "POST", headers, body: JSON.stringify({ optionId: "write-b", subprocessId: "write" }) });
    assert.equal(selected.status, 200);
    assert.equal(runtime.store.project(project.id).steps[1].subprocesses[1].selectedOptionId, "write-b");
    assert.equal(runtime.store.project(project.id).steps[1].selectedOptionId, "legacy-b");
    const crossed = await fetch(`${runtime.url}/api/projects/${project.id}/steps/build/select`, { method: "POST", headers, body: JSON.stringify({ optionId: "read-a", subprocessId: "write" }) });
    assert.equal(crossed.status, 400);
    assert.match((await crossed.json()).error, /不属于当前子进程/);
    const preflight = await (await fetch(`${runtime.url}/api/projects/${project.id}/steps/build/execute/preflight`, { method: "POST", headers, body: JSON.stringify({ subprocessId: "write" }) })).json();
    assert.equal(preflight.readiness.allowed, false);
    assert.deepEqual(preflight.readiness.missingStepIds, ["scope"]);
    assert.deepEqual(preflight.readiness.missingSubprocessIds, ["read"]);
    const blocked = await fetch(`${runtime.url}/api/projects/${project.id}/steps/build/execute`, { method: "POST", headers, body: JSON.stringify({ subprocessId: "write" }) });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /确认范围.*读取状态/);
    assert.equal(executeCalls, 0);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("预览回溯由 Agent 在产物候选中选择并把反馈归档到步骤与子进程", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-debug-trace-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "index.html"), '<button id="save" class="primary">保存</button>\n');
  await writeFile(path.join(workspace, "apple.js"), 'leaf.userData.loopcanvas = { traceId: "apple.leaf", label: "绿叶" };\n');
  let traceCalls = 0;
  const runtime = await startServer({
    port: 0, dataDirectory: directory, workspace,
    tracePreviewWithHarness: async ({ candidates }) => { traceCalls += 1; return { request: { id: "trace-1" }, rawOutput: "{}", result: { source: candidates[0], decisionSummary: "id 与按钮文本同时命中。" } }; }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "制作保存按钮" }) })).json();
    const project = runtime.store.project(created.state.projects[0].id);
    await runtime.store.mutate(() => {
      project.workspace = workspace;
      project.artifact = { title: "按钮", kind: "html", content: '<button id="save" class="primary">保存</button>', filename: "index.html", projectRoot: workspace, files: ["apple.js"] };
      project.artifactStepId = "build-button"; project.artifactSubprocessId = "process-button";
      project.steps = [{
        id: "build-button", title: "制作按钮", purpose: "生成保存按钮", kind: "build", status: "review", revision: 1,
        dependencies: [], conversation: [{ role: "assistant", text: "按钮已生成。" }], debugRecords: [],
        options: [{ id: "plain", title: "原生" }], selectedOptionId: "plain", selectedSubprocessId: "process-button",
        subprocesses: [{ id: "process-button", title: "生成按钮", purpose: "实现按钮", status: "review", revision: 1, options: [{ id: "button-native", title: "原生按钮", isRecommended: true }], selectedOptionId: "button-native", result: { assistantMessage: "按钮已生成。" }, resultHistory: [], debugRecords: [] }]
      }];
      project.selectedStepId = "build-button";
    });
    const located = await (await fetch(`${runtime.url}/api/projects/${project.id}/debug/locate`, { method: "POST", headers, body: JSON.stringify({ element: { tag: "button", id: "save", classes: ["primary"], text: "保存", attributes: {} } }) })).json();
    assert.equal(located.record.source.path, "index.html");
    assert.match(located.record.agentDecisionSummary, /id/);
    assert.equal(located.record.locationMethod, "inferred");
    assert.equal(traceCalls, 1);
    const previewResponse = await fetch(`${runtime.url}/preview/${project.id}/`);
    assert.match(previewResponse.headers.get("content-security-policy") ?? "", /script-src[^;]*'self'/);
    const preview = await previewResponse.text();
    assert.match(preview, /<script[^>]+src="\/preview-trace\.js"[^>]*><\/script>/);
    const previewTrace = await (await fetch(`${runtime.url}/preview-trace.js`)).text();
    assert.match(previewTrace, /#f59e0b/);
    assert.match(previewTrace, /meaningfulDOMGroup/);
    assert.match(previewTrace, /registerThree/);
    assert.equal(runtime.store.project(project.id).steps[0].debugRecords.length, 1);
    assert.equal(runtime.store.project(project.id).steps[0].subprocesses[0].debugRecords.length, 1);
    const exact = await (await fetch(`${runtime.url}/api/projects/${project.id}/debug/locate`, { method: "POST", headers, body: JSON.stringify({ target: { kind: "three-object", traceId: "apple.leaf", label: "绿叶" } }) })).json();
    assert.equal(exact.record.source.path, "apple.js");
    assert.equal(exact.record.locationMethod, "exact");
    assert.equal(exact.record.confidence, 1);
    assert.match(exact.record.agentDecisionSummary, /无需 Agent 推测/);
    assert.equal(traceCalls, 1);
    const feedback = await fetch(`${runtime.url}/api/projects/${project.id}/steps/build-button/debug/${located.record.id}`, { method: "POST", headers, body: JSON.stringify({ feedback: "按钮文案改成保存项目" }) });
    assert.equal(feedback.status, 200);
    assert.equal((await feedback.json()).repairQueued, true);
    assert.equal(runtime.store.project(project.id).steps[0].status, "ready");
    assert.equal(runtime.store.project(project.id).steps[0].subprocesses[0].status, "ready");
    assert.equal(runtime.store.project(project.id).steps[0].subprocesses[0].debugRecords[0].feedback, "按钮文案改成保存项目");

    await runtime.store.mutate(() => {
      const stored = runtime.store.project(project.id);
      stored.executionMode = "adaptive-single";
      stored.executionRun = { status: "completed", completedAt: new Date().toISOString() };
      stored.phase = "complete";
      stored.steps[0].status = "approved";
      stored.steps[0].subprocesses[0].status = "approved";
    });
    const completedFeedback = await fetch(`${runtime.url}/api/projects/${project.id}/steps/build-button/debug/${exact.record.id}`, { method: "POST", headers, body: JSON.stringify({ feedback: "绿叶改成浅绿色" }) });
    assert.equal(completedFeedback.status, 200);
    const reopened = runtime.store.project(project.id);
    assert.equal(reopened.phase, "workspace");
    assert.equal(reopened.executionRun.status, "ready");
    assert.equal(reopened.steps[0].status, "ready");
    assert.equal(reopened.steps[0].subprocesses[0].status, "ready");
    assert.equal(reopened.steps[0].debugRecords.find((item) => item.id === exact.record.id).feedback, "绿叶改成浅绿色");
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("新项目在固定目录中只调用一次 Agent 连续构建并把 Graph 节点落为检查点", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-continuous-project-"));
  let calls = 0;
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "deliverables"),
    executeProjectWithHarness: async (project) => {
      calls += 1;
      const html = '<!doctype html><html><head></head><body><main>连续成果</main><script type="module">import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js"; window.__threeReady = Boolean(THREE && OrbitControls);</script></body></html>\n';
      await writeFile(path.join(project.workspace, "index.html"), html);
      return {
        request: { id: "continuous-run" },
        rawOutput: "{}",
        checkpoints: project.steps.map((step) => ({ stepId: step.id, summary: `${step.title}完成`, actualChanges: ["index.html"], evidence: [`${step.id} 已核对`], verificationPassed: true })),
        result: {
          assistantMessage: "同一个 Agent 已连续完成项目。",
          summary: "主交付物完成",
          actualChanges: ["index.html"],
          evidence: ["index.html 可读"],
          deviation: "无",
          rollback: "恢复 index.html 前一版本",
          verificationPassed: true,
          blockingIssues: [],
          requiresPreview: true,
          previewReason: "最终页面可检查",
          artifact: { title: "连续成果", kind: "html", content: html, filename: "index.html", projectRoot: project.workspace, files: [], entrypoint: "index.html", dependencies: ["three@0.165.0（运行时从 unpkg CDN 加载）"] }
        }
      };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "连续构建演示页面" }) })).json();
    const project = runtime.store.project(created.project.id);
    assert.equal((await stat(project.workspace)).isDirectory(), true);
    await runtime.store.mutate(() => {
      project.executionMode = "continuous";
      project.primaryArtifact = { title: "连续成果", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["页面可打开"], projectRoot: project.workspace };
      project.steps = [
        { id: "build", title: "构建", purpose: "完成页面", kind: "build", riskLevel: "L1", dependencies: [], status: "ready", revision: 1, selectedOptionId: "build-direct", options: [{ id: "build-direct", title: "直接构建", isRecommended: true }], conversation: [], debugRecords: [], subprocesses: [] },
        { id: "verify", title: "验证", purpose: "核对页面", kind: "verify", riskLevel: "L1", dependencies: ["build"], status: "locked", revision: 1, selectedOptionId: "verify-local", options: [{ id: "verify-local", title: "本地验证", isRecommended: true }], conversation: [], debugRecords: [], subprocesses: [] },
        { id: "deliver", title: "交付", purpose: "交付页面", kind: "deliver", riskLevel: "L1", dependencies: ["verify"], status: "locked", revision: 1, selectedOptionId: "deliver-html", options: [{ id: "deliver-html", title: "HTML 交付", isRecommended: true }], conversation: [], debugRecords: [], subprocesses: [] }
      ];
    });
    const response = await fetch(`${runtime.url}/api/projects/${project.id}/execute`, { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 200);
    const finished = runtime.store.project(project.id);
    assert.equal(calls, 1);
    assert.deepEqual(finished.steps.map((step) => step.status), ["approved", "approved", "review"]);
    assert.equal(finished.artifact.filename, "index.html");
    assert.equal(finished.primaryArtifact.filename, "index.html");
    assert.equal(finished.executionRun.status, "completed");
    const preview = await fetch(`${runtime.url}/preview/${project.id}/`);
    assert.equal(preview.status, 200);
    const previewHTML = await preview.text();
    assert.match(previewHTML, /<script type="importmap">/);
    assert.match(previewHTML, /__dependency__\/unpkg\.com\/three%400\.165\.0\/build\/three\.module\.js/);
    assert.match(previewHTML, /three\/addons\//);
    assert.ok(previewHTML.indexOf('type="importmap"') < previewHTML.indexOf('type="module"'));
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("连续执行失败后可从完整会话记录恢复产物且不再次调用 Agent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-recover-project-"));
  let agentCalls = 0;
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "deliverables"),
    executeProjectWithHarness: async () => { agentCalls += 1; throw new Error("恢复不应调用 Agent"); }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "恢复 Three.js 苹果" }) })).json();
    const project = runtime.store.project(created.project.id);
    const html = '<!doctype html><script src="https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.min.js"></script><main>苹果</main>\n';
    await writeFile(path.join(project.workspace, "index.html"), html);
    await runtime.store.mutate(() => {
      project.executionMode = "continuous";
      project.primaryArtifact = { title: "3D 苹果", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["页面可打开"], projectRoot: project.workspace };
      project.steps = [
        { id: "build", title: "构建", purpose: "完成页面", kind: "build", riskLevel: "L1", dependencies: [], status: "ready", revision: 1, selectedOptionId: "build-direct", options: [{ id: "build-direct", title: "直接构建", isRecommended: true }], conversation: [], debugRecords: [], subprocesses: [] },
        { id: "verify", title: "验证", purpose: "核对页面", kind: "verify", riskLevel: "L1", dependencies: ["build"], status: "locked", revision: 1, selectedOptionId: "verify-local", options: [{ id: "verify-local", title: "本地验证", isRecommended: true }], conversation: [], debugRecords: [], subprocesses: [] },
        { id: "deliver", title: "交付", purpose: "交付页面", kind: "deliver", riskLevel: "L1", dependencies: ["verify"], status: "locked", revision: 1, selectedOptionId: "deliver-html", options: [{ id: "deliver-html", title: "HTML 交付", isRecommended: true }], conversation: [], debugRecords: [], subprocesses: [] }
      ];
      project.executionRun = { status: "failed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: "旧校验拒绝" };
      project.lastError = "旧校验拒绝";
    });
    const raw = {
      requestID: "recover-request",
      status: "success",
      assistantMessage: "完整结果已生成。",
      result: {
        appliedOptionIds: ["build-direct", "verify-local", "deliver-html"],
        summary: "Three.js 苹果完成",
        actualChanges: ["index.html"],
        evidence: ["index.html 可读"],
        deviation: "无",
        rollback: "恢复 index.html 前一版本",
        verificationPassed: true,
        blockingIssues: [],
        requiresPreview: true,
        previewReason: "可以检查苹果页面",
        checkpoints: project.steps.map((step) => ({ stepId: step.id, summary: `${step.title}完成`, actualChanges: ["index.html"], evidence: [`${step.id} 已核对`], verificationPassed: true })),
        artifact: { title: "3D 苹果", kind: "html", content: html, filename: "index.html", projectRoot: project.workspace, files: [], entrypoint: "index.html", dependencies: ["https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.min.js"] }
      }
    };
    await writeConversationRecord(directory, { projectId: project.id, operation: "execute-project", status: "failed", output: JSON.stringify(raw), error: "旧校验拒绝" });

    const response = await fetch(`${runtime.url}/api/projects/${project.id}/execution/recover`, { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 200);
    assert.equal(agentCalls, 0);
    const recovered = runtime.store.project(project.id);
    assert.equal(recovered.executionRun.status, "completed");
    assert.equal(recovered.lastError, null);
    assert.equal(recovered.artifact.filename, "index.html");
    assert.deepEqual(recovered.steps.map((step) => step.status), ["approved", "approved", "review"]);
    const preview = await fetch(`${runtime.url}/preview/${project.id}/`);
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /three@0\.165\.0/);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("自适应 single 在首调用内直接验证并交付，不再二次执行", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-adaptive-single-"));
  let routeCalls = 0;
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "deliverables"),
    planWithHarness: async (project) => {
      routeCalls += 1;
      const html = "<!doctype html><main>一步完成</main>";
      await writeFile(path.join(project.workspace, "index.html"), html);
      return {
        request: { id: "adaptive-single" }, rawOutput: "{}",
        result: {
          executionShape: "single", assistantMessage: "判断为简单任务并已直接交付。",
          primaryArtifact: { title: "一步页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["页面可打开"] },
          steps: [{ id: "single", title: "直接完成", purpose: "实现并验证", kind: "deliver", dependencies: [], options: [], subprocesses: [] }],
          execution: { summary: "页面完成", actualChanges: ["index.html"], evidence: ["index.html 可读"], deviation: "无", rollback: "恢复 index.html", verificationPassed: true, blockingIssues: [], artifact: { title: "一步页面", kind: "html", content: html, filename: "index.html", projectRoot: project.workspace, files: [], entrypoint: "index.html", dependencies: [], runCommands: [], testCommands: [], testResults: [] } }
        }
      };
    },
    executeWithHarness: async () => { throw new Error("single 不应触发第二次执行"); }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "做一个简单页面" }) })).json();
    const response = await fetch(`${runtime.url}/api/projects/${created.project.id}/plan`, { method: "POST", headers, body: JSON.stringify({ goal: "做一个简单页面" }) });
    assert.equal(response.status, 200);
    const project = runtime.store.project(created.project.id);
    assert.equal(routeCalls, 1);
    assert.equal(project.executionMode, "adaptive-single");
    assert.equal(project.phase, "complete");
    assert.equal(project.artifact.filename, "index.html");
    assert.deepEqual(project.steps.map((step) => step.status), ["approved"]);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("自适应 graph 会暂停方向问题、询问并行方式并在依赖汇合后交付", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-adaptive-graph-"));
  let active = 0;
  let maximumActive = 0;
  const seen = [];
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "deliverables"),
    planWithHarness: async () => ({
      request: { id: "adaptive-graph" }, rawOutput: "{}",
      result: {
        executionShape: "graph", assistantMessage: "需要真实依赖图。",
        primaryArtifact: { title: "组合页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["页面可打开"] },
        steps: [
          { id: "a", title: "方向节点", purpose: "按用户方向准备 A", kind: "build", dependencies: [], parallelSafe: true, writeScope: ["a.txt"], requiresUserDirection: true, directionQuestion: "A 应采用什么方向？", directionOptions: [
            { id: "speed", label: "速度优先", description: "先完成核心路径" },
            { id: "detail", label: "细节优先", description: "扩大边界覆盖" }
          ], options: [], subprocesses: [] },
          { id: "b", title: "独立节点", purpose: "准备 B", kind: "build", dependencies: [], parallelSafe: true, writeScope: ["b.txt"], options: [], subprocesses: [] },
          { id: "deliver", title: "汇合交付", purpose: "组合并验证", kind: "deliver", dependencies: ["a", "b"], parallelSafe: false, writeScope: ["index.html"], options: [], subprocesses: [] }
        ], execution: null
      }
    }),
    executeWithHarness: async (project, step) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      seen.push({ id: step.id, cautionLevel: step.cautionLevel, directionAnswer: step.directionAnswer });
      await new Promise((resolve) => setTimeout(resolve, step.id === "deliver" ? 2 : 20));
      let artifact = null;
      if (step.id === "deliver") {
        const html = "<!doctype html><main>组合完成</main>";
        await writeFile(path.join(project.workspace, "index.html"), html);
        artifact = { title: "组合页面", kind: "html", content: html, filename: "index.html", projectRoot: project.workspace, files: [], entrypoint: "index.html", dependencies: [], runCommands: [], testCommands: [], testResults: [] };
      }
      active -= 1;
      return { request: { id: step.id }, rawOutput: "{}", result: { assistantMessage: `${step.title}完成`, summary: `${step.title}完成`, actualChanges: step.writeScope, evidence: [`${step.id} 已验证`], deviation: "无", rollback: `恢复 ${step.id}`, verificationPassed: true, blockingIssues: [], artifact } };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "组合两个独立部分" }) })).json();
    const projectId = created.project.id;
    assert.equal((await fetch(`${runtime.url}/api/projects/${projectId}/plan`, { method: "POST", headers, body: JSON.stringify({ goal: "组合两个独立部分" }) })).status, 200);

    let response = await fetch(`${runtime.url}/api/projects/${projectId}/run`, { method: "POST", headers, body: JSON.stringify({ mode: "ask" }) });
    assert.equal(response.status, 200);
    assert.equal(runtime.store.project(projectId).executionRun.status, "awaiting_direction");
    assert.equal(seen.length, 0);
    assert.deepEqual(runtime.store.project(projectId).checkpoints.map((item) => item.key), ["decision:a"]);

    assert.equal((await fetch(`${runtime.url}/api/projects/${projectId}/steps/a/caution`, { method: "POST", headers, body: JSON.stringify({ cautionLevel: "high" }) })).status, 200);
    assert.equal((await fetch(`${runtime.url}/api/projects/${projectId}/steps/a/direction`, { method: "POST", headers, body: JSON.stringify({ optionId: "speed", supplemental: "" }) })).status, 200);
    response = await fetch(`${runtime.url}/api/projects/${projectId}/run`, { method: "POST", headers, body: JSON.stringify({ mode: "ask" }) });
    assert.equal(response.status, 200);
    assert.equal(runtime.store.project(projectId).executionRun.status, "awaiting_parallel_choice");
    assert.deepEqual(runtime.store.project(projectId).checkpoints.map((item) => item.key), ["decision:a", "decision:parallel:a+b"]);

    response = await fetch(`${runtime.url}/api/projects/${projectId}/run`, { method: "POST", headers, body: JSON.stringify({ mode: "parallel" }) });
    assert.equal(response.status, 200);
    const finished = runtime.store.project(projectId);
    assert.ok(maximumActive >= 2, "两个独立根节点应出现并发重叠");
    assert.equal(seen.find((item) => item.id === "a").cautionLevel, "high");
    assert.equal(seen.find((item) => item.id === "a").directionAnswer, "速度优先：先完成核心路径");
    assert.deepEqual(finished.steps.map((step) => step.status), ["approved", "approved", "approved"]);
    assert.equal(finished.executionRun.status, "completed");
    assert.equal(finished.artifact.filename, "index.html");
    assert.deepEqual(finished.checkpoints.map((item) => item.key), ["decision:a", "decision:parallel:a+b", "execution:a+b", "execution:deliver"]);
    assert.equal(new Set(finished.checkpoints.map((item) => item.key)).size, finished.checkpoints.length);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("自适应 graph 验证失败时保留节点结果、阻断原因与原始 Agent 记录", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-adaptive-failure-evidence-"));
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "deliverables"),
    planWithHarness: async () => ({
      request: { id: "failure-plan" }, rawOutput: "{}",
      result: {
        executionShape: "graph", assistantMessage: "需要两个节点。",
        primaryArtifact: { title: "失败证据页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["测试通过"] },
        steps: [
          { id: "build", title: "构建数据核心", purpose: "实现并测试", kind: "build", dependencies: [], parallelSafe: false, writeScope: ["js/"], options: [], subprocesses: [] },
          { id: "deliver", title: "交付", purpose: "集成", kind: "deliver", dependencies: ["build"], parallelSafe: false, writeScope: ["index.html"], options: [], subprocesses: [] }
        ], execution: null
      }
    }),
    executeWithHarness: async (_project, step) => {
      assert.equal(step.id, "build", "失败节点不应解锁下游");
      return {
        request: { id: "failed-build-request" }, rawOutput: "raw-failed-node-output",
        result: {
          assistantMessage: "文件已生成，但边界测试不足。", summary: "数据核心已部分完成",
          actualChanges: ["js/data.js"], evidence: ["基础测试 7/7 通过"], deviation: "超大输入边界尚未覆盖",
          rollback: "恢复执行前检查点", verificationPassed: false, blockingIssues: ["缺少超大输入边界测试"], artifact: null
        }
      };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "保留失败证据" }) })).json();
    const projectId = created.project.id;
    assert.equal((await fetch(`${runtime.url}/api/projects/${projectId}/plan`, { method: "POST", headers, body: JSON.stringify({ goal: "保留失败证据" }) })).status, 200);
    const response = await fetch(`${runtime.url}/api/projects/${projectId}/run`, { method: "POST", headers, body: JSON.stringify({ mode: "sequential" }) });
    assert.equal(response.status, 400);
    const failed = runtime.store.project(projectId);
    assert.equal(failed.steps[0].status, "error");
    assert.equal(failed.steps[0].result.summary, "数据核心已部分完成");
    assert.deepEqual(failed.steps[0].result.blockingIssues, ["缺少超大输入边界测试"]);
    assert.match(failed.steps[0].lastError, /缺少超大输入边界测试/);
    assert.equal(failed.steps[1].status, "locked");
    const listing = await (await fetch(`${runtime.url}/api/projects/${projectId}/conversations`, { headers })).json();
    const failedRecordMeta = listing.items.find((item) => item.operation === "execute-node" && item.status === "failed");
    assert.equal(failedRecordMeta.nodeId, "build");
    const record = await (await fetch(`${runtime.url}/api/projects/${projectId}/conversations/${encodeURIComponent(failedRecordMeta.id)}`, { headers })).json();
    assert.equal(record.record.request.id, "failed-build-request");
    assert.equal(record.record.output, "raw-failed-node-output");
    assert.equal(record.record.nodeId, "build");
    assert.match(record.record.error, /缺少超大输入边界测试/);
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("自适应 graph 在执行时遇到关键未知项会暂停提问并保存响应", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-adaptive-direction-"));
  let calls = 0;
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "deliverables"),
    planWithHarness: async () => ({
      request: { id: "direction-plan" }, rawOutput: "{}",
      result: {
        executionShape: "graph", assistantMessage: "先执行构建节点。",
        primaryArtifact: { title: "方向确认页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["页面可打开"] },
        steps: [
          { id: "build", title: "准备部署配置", purpose: "确定安全的目标环境", kind: "build", dependencies: [], parallelSafe: false, writeScope: ["deploy/"], options: [], subprocesses: [] },
          { id: "deliver", title: "交付", purpose: "写入主页面", kind: "deliver", dependencies: ["build"], parallelSafe: false, writeScope: ["index.html"], options: [], subprocesses: [] }
        ], execution: null
      }
    }),
    executeWithHarness: async (_project, step) => {
      calls += 1;
      assert.equal(step.id, "build");
      return {
        needsUserDirection: true,
        assistantMessage: "部署环境尚未确认。",
        directionQuestion: "部署到哪个环境？",
        directionOptions: [
          { id: "staging", label: "预发布", description: "先验证" },
          { id: "production", label: "生产", description: "直接上线" }
        ],
        request: { id: "direction-request" },
        rawOutput: '{"status":"needs_user_direction"}'
      };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "需要确认部署环境" }) })).json();
    const projectId = created.project.id;
    assert.equal((await fetch(`${runtime.url}/api/projects/${projectId}/plan`, { method: "POST", headers, body: JSON.stringify({ goal: "需要确认部署环境" }) })).status, 200);
    assert.equal((await fetch(`${runtime.url}/api/projects/${projectId}/run`, { method: "POST", headers, body: JSON.stringify({ mode: "sequential" }) })).status, 200);
    const waiting = runtime.store.project(projectId);
    assert.equal(calls, 1);
    assert.equal(waiting.executionRun.status, "awaiting_direction");
    assert.equal(waiting.steps[0].status, "ready");
    assert.equal(waiting.steps[0].directionQuestion, "部署到哪个环境？");
    const listing = await (await fetch(`${runtime.url}/api/projects/${projectId}/conversations`, { headers })).json();
    const recordMeta = listing.items.find((item) => item.operation === "execute-node" && item.status === "awaiting_user_direction");
    const record = await (await fetch(`${runtime.url}/api/projects/${projectId}/conversations/${encodeURIComponent(recordMeta.id)}`, { headers })).json();
    assert.equal(record.record.request.id, "direction-request");
    assert.equal(record.record.output, '{"status":"needs_user_direction"}');
    assert.equal((await fetch(`${runtime.url}/api/projects/${projectId}/steps/build/direction`, { method: "POST", headers, body: JSON.stringify({ optionId: "staging", supplemental: "" }) })).status, 200);
    assert.match(runtime.store.project(projectId).steps[0].directionAnswer, /预发布/);
    assert.equal(runtime.store.project(projectId).steps[0].status, "ready");
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("自适应 graph 在 Agent 响应标准化失败时保存原始输出", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-adaptive-raw-failure-"));
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "deliverables"),
    planWithHarness: async () => ({
      request: { id: "raw-failure-plan" }, rawOutput: "{}",
      result: {
        executionShape: "graph", assistantMessage: "执行首个节点。",
        primaryArtifact: { title: "失败记录页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["页面可打开"] },
        steps: [
          { id: "build", title: "构建", purpose: "执行", kind: "build", dependencies: [], parallelSafe: false, writeScope: ["src/"], options: [], subprocesses: [] },
          { id: "deliver", title: "交付", purpose: "完成", kind: "deliver", dependencies: ["build"], parallelSafe: false, writeScope: ["index.html"], options: [], subprocesses: [] }
        ], execution: null
      }
    }),
    executeWithHarness: async (_project, step) => {
      const error = new Error("Agent 返回 failure，但没有提供具体错误。");
      error.executionContext = { request: { id: "raw-failure-request" }, rawOutput: '{"status":"failure"}', stepId: step.id };
      throw error;
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "保存失败响应" }) })).json();
    const projectId = created.project.id;
    assert.equal((await fetch(`${runtime.url}/api/projects/${projectId}/plan`, { method: "POST", headers, body: JSON.stringify({ goal: "保存失败响应" }) })).status, 200);
    assert.equal((await fetch(`${runtime.url}/api/projects/${projectId}/run`, { method: "POST", headers, body: JSON.stringify({ mode: "sequential" }) })).status, 400);
    const listing = await (await fetch(`${runtime.url}/api/projects/${projectId}/conversations`, { headers })).json();
    const recordMeta = listing.items.find((item) => item.operation === "execute-node" && item.status === "failed");
    const record = await (await fetch(`${runtime.url}/api/projects/${projectId}/conversations/${encodeURIComponent(recordMeta.id)}`, { headers })).json();
    assert.equal(record.record.request.id, "raw-failure-request");
    assert.equal(record.record.output, '{"status":"failure"}');
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("自适应 graph 可手动指定一个就绪节点且不会自动推进其他节点", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-adaptive-manual-step-"));
  const calls = [];
  let markExecutionStarted;
  let releaseExecution;
  const executionStarted = new Promise((resolve) => { markExecutionStarted = resolve; });
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  const runtime = await startServer({
    port: 0,
    dataDirectory: directory,
    workspace: path.join(directory, "deliverables"),
    planWithHarness: async () => ({
      request: { id: "manual-plan" }, rawOutput: "{}",
      result: {
        executionShape: "graph", assistantMessage: "两个独立节点。",
        primaryArtifact: { title: "手动执行页面", kind: "html", filename: "index.html", entrypoint: "index.html", acceptanceCriteria: ["页面可打开"] },
        steps: [
          { id: "a", title: "节点 A", purpose: "构建 A", kind: "build", dependencies: [], parallelSafe: true, writeScope: ["a.txt"], options: [], subprocesses: [] },
          { id: "b", title: "节点 B", purpose: "构建 B", kind: "build", dependencies: [], parallelSafe: true, writeScope: ["b.txt"], options: [], subprocesses: [] },
          { id: "deliver", title: "交付", purpose: "集成", kind: "deliver", dependencies: ["a", "b"], parallelSafe: false, writeScope: ["index.html"], options: [], subprocesses: [] }
        ], execution: null
      }
    }),
    executeWithHarness: async (_project, step, _settings, _feedback, _signal, onEvent) => {
      calls.push(step.id);
      onEvent?.({ type: "activity", activity: `修改文件：${step.writeScope[0]}` });
      markExecutionStarted();
      await executionGate;
      return { request: { id: step.id }, rawOutput: "{}", result: { assistantMessage: `${step.title}完成`, summary: `${step.title}完成`, actualChanges: step.writeScope, evidence: [`${step.id} 已验证`], deviation: "无", rollback: `恢复 ${step.id}`, verificationPassed: true, blockingIssues: [], artifact: null } };
    }
  });
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects`, { method: "POST", headers, body: JSON.stringify({ goal: "手动运行节点" }) })).json();
    const projectId = created.project.id;
    assert.equal((await fetch(`${runtime.url}/api/projects/${projectId}/plan`, { method: "POST", headers, body: JSON.stringify({ goal: "手动运行节点" }) })).status, 200);
    const responsePromise = fetch(`${runtime.url}/api/projects/${projectId}/run`, { method: "POST", headers, body: JSON.stringify({ mode: "sequential", stepId: "b" }) });
    await executionStarted;
    let activeRuntime;
    try {
      activeRuntime = await (await fetch(`${runtime.url}/api/projects/${projectId}/runtime`)).json();
    } finally {
      releaseExecution();
    }
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(activeRuntime.runtime.active, true);
    assert.equal(activeRuntime.runtime.percent, null);
    assert.equal(activeRuntime.runtime.activity, "修改文件：b.txt");
    const project = runtime.store.project(projectId);
    assert.deepEqual(calls, ["b"]);
    assert.equal(project.steps.find((step) => step.id === "a").status, "ready");
    assert.equal(project.steps.find((step) => step.id === "b").status, "approved");
    assert.equal(project.steps.find((step) => step.id === "deliver").status, "locked");
    assert.equal(project.executionRun.status, "ready");
    assert.equal(project.pendingAction, null);
    const runtimePayload = await (await fetch(`${runtime.url}/api/projects/${projectId}/runtime`)).json();
    assert.equal(runtimePayload.runtime.active, false);
    assert.equal(runtimePayload.runtime.activity, "等待手动执行");
  } finally {
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
