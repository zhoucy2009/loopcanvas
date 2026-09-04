import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readTextAttachment, stageAttachment } from "../src/attachments.js";
import { validateArtifact, validateStepResult } from "../src/artifact-validator.js";

test("附件暂存去重并可恢复文本", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-attachments-"));
  try {
    const state = { draftAttachments: [], projects: [], archivedProjects: [] };
    const first = await stageAttachment({ dataDirectory: directory, state, bytes: Buffer.from("完整需求"), filename: "需求.txt", mimeType: "text/plain" });
    state.draftAttachments.push(first);
    assert.equal(await readTextAttachment(state, first.id), "完整需求");
    await assert.rejects(() => stageAttachment({ dataDirectory: directory, state, bytes: Buffer.from("完整需求"), filename: "重复.txt", mimeType: "text/plain" }), /已经添加/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("制作步骤不能用文字总结冒充完整产物", async () => {
  await assert.rejects(() => validateStepResult({ title: "制作", kind: "build" }, { evidence: ["读过代码"], artifact: null }), /必须返回完整产物/);
});

test("HTML 产物拒绝未授权远程资源并接受完整本地资源", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-artifact-"));
  try {
    await mkdir(path.join(directory, "js"), { recursive: true });
    await writeFile(path.join(directory, "index.html"), "<script src=\"js/app.js\"></script>");
    await writeFile(path.join(directory, "js", "app.js"), "console.log('ok')");
    const step = { options: [{ id: "local", title: "本地" }], selectedOptionId: "local" };
    await validateArtifact({ kind: "html", filename: "index.html", projectRoot: directory, files: ["index.html", "js/app.js"], content: "" }, step);
    await assert.rejects(() => validateArtifact({ kind: "html", filename: "index.html", content: "<script src=\"https://cdn.example/a.js\"></script>" }, step), /未授权的远程资源/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTML 嵌套入口相对自身目录解析本地资源且仍拒绝越界", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-nested-artifact-"));
  try {
    await mkdir(path.join(directory, "engine-model"), { recursive: true });
    await writeFile(path.join(directory, "engine-model", "index.html"), '<link rel="stylesheet" href="./styles.css"><script src="./engine.js"></script>');
    await writeFile(path.join(directory, "engine-model", "styles.css"), "body { color: white; }");
    await writeFile(path.join(directory, "engine-model", "engine.js"), "console.log('ok')");
    const step = { options: [], selectedOptionId: null };
    await validateArtifact({
      kind: "html", filename: "engine-model/index.html", projectRoot: directory,
      files: ["engine-model/index.html", "engine-model/styles.css", "engine-model/engine.js"], content: ""
    }, step);
    await writeFile(path.join(directory, "engine-model", "index.html"), '<script src="../../outside.js"></script>');
    await assert.rejects(() => validateArtifact({
      kind: "html", filename: "engine-model/index.html", projectRoot: directory,
      files: ["engine-model/index.html"], content: ""
    }, step), /本地资源路径越界/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTML 产物只接受与声明 npm 依赖匹配的受支持 CDN 资源", async () => {
  const step = { options: [{ id: "single", title: "单文件 HTML 实现" }], selectedOptionId: "single" };
  const artifact = {
    kind: "html",
    filename: "index.html",
    content: '<script src="https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.min.js"></script>',
    dependencies: ["three@0.165.0"]
  };
  await validateArtifact(artifact, step);
  await validateArtifact({ ...artifact, dependencies: ["Three.js@0.165.0"] }, step);
  await validateArtifact({ ...artifact, dependencies: ["https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.min.js"] }, step);
  await assert.rejects(
    () => validateArtifact({ ...artifact, dependencies: ["Three.js@0.164.0"] }, step),
    /未声明依赖或不受支持 CDN/
  );
  await assert.rejects(
    () => validateArtifact({ ...artifact, dependencies: ["react@19.0.0"] }, step),
    /未声明依赖或不受支持 CDN/
  );
  await assert.rejects(
    () => validateArtifact({ ...artifact, content: '<script src="https://evil.example/npm/three@0.165.0/build/three.min.js"></script>' }, step),
    /未声明依赖或不受支持 CDN/
  );
});

test("HTML 裸 three 模块导入必须声明精确版本", async () => {
  const step = { options: [], selectedOptionId: null };
  const artifact = {
    kind: "html",
    filename: "index.html",
    content: '<script type="module">import * as THREE from "three"; import("three/addons/controls/OrbitControls.js");</script>',
    dependencies: ["three@0.165.0"]
  };
  await validateArtifact(artifact, step);
  await validateArtifact({ ...artifact, dependencies: ["three@0.165.0（运行时从 unpkg CDN 加载）"] }, step);
  await validateArtifact({ ...artifact, dependencies: ["https://unpkg.com/three@0.165.0/build/three.module.js"] }, step);
  await assert.rejects(() => validateArtifact({ ...artifact, dependencies: [] }, step), /缺少 three@精确版本/);
  await assert.rejects(() => validateArtifact({ ...artifact, dependencies: ["three"] }, step), /缺少 three@精确版本/);
  await assert.rejects(() => validateArtifact({ ...artifact, dependencies: ["three@latest"] }, step), /缺少 three@精确版本/);
});

test("HTTPS 引用链接不是运行依赖，脚本、样式与图片仍需校验", async () => {
  const artifact = { kind: "html", filename: "index.html", content: '<a href="https://www.ipcc.ch/report/ar6/syr/summary-for-policymakers/">IPCC 来源</a>' };
  await validateArtifact(artifact, { kind: "build" });
  for (const resource of ['<script src="https://example.com/a.js"></script>', '<link href="https://example.com/a.css" rel="stylesheet">', '<img src="https://example.com/a.png">', '<a href="https://example.com" src="https://example.com/a.png">链接</a>']) {
    await assert.rejects(() => validateArtifact({ ...artifact, content: artifact.content + resource }, { kind: "build" }), /未授权的远程资源/);
  }
  await assert.rejects(() => validateArtifact({ ...artifact, content: '<a href="javascript:alert(1)">链接</a>' }, { kind: "build" }), /危险/);
});
