import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRepositoryOverviewDocuments, findPreviewSourceCandidates, isSupportedSourceFile, listSourceFiles, parseGitHubRepositoryURL, readSourceDocument, readSourceFile, readSourceSelection } from "../src/source-browser.js";

test("源码浏览忽略依赖目录并拒绝路径越界", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-source-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-outside-"));
  try {
    await mkdir(path.join(directory, "src"), { recursive: true });
    await mkdir(path.join(directory, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(directory, "src", "main.js"), "const value = { count: 1 };\nconsole.log(value.count);\n");
    await writeFile(path.join(directory, "README.md"), "# 项目\n");
    await writeFile(path.join(directory, "node_modules", "pkg", "index.js"), "ignored\n");
    await writeFile(path.join(outside, "secret.js"), "secret\n");
    await symlink(path.join(outside, "secret.js"), path.join(directory, "src", "linked.js"));

    assert.deepEqual(await listSourceFiles(directory), ["README.md", "src/main.js"]);
    const file = await readSourceFile(directory, "src/main.js");
    assert.equal(file.language, "javascript");
    const selection = await readSourceSelection(directory, "src/main.js", 1, 2);
    assert.equal(selection.startLine, 1);
    assert.match(selection.code, /console\.log/);
    await assert.rejects(() => readSourceFile(directory, "../secret.js"), /超出项目工作目录/);
    await assert.rejects(() => readSourceFile(directory, "src/linked.js"), /超出|不存在|不受支持/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("源码选区限制最大行数", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-selection-"));
  try {
    await writeFile(path.join(directory, "large.py"), Array.from({ length: 260 }, (_, index) => `print(${index})`).join("\n"));
    await assert.rejects(() => readSourceSelection(directory, "large.py", 1, 250), /最多解释 240 行/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("整篇学习读取完整源码并限制超长文件", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-document-"));
  try {
    await writeFile(path.join(directory, "small.js"), "const state = {};\nstate.ready = true;\n");
    const document = await readSourceDocument(directory, "small.js");
    assert.equal(document.startLine, 1);
    assert.equal(document.endLine, 3);
    assert.match(document.code, /state\.ready/);
    await writeFile(path.join(directory, "huge.js"), Array.from({ length: 4_001 }, (_, index) => `const value${index} = ${index};`).join("\n"));
    await assert.rejects(() => readSourceDocument(directory, "huge.js"), /最多分析 4000 行/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("GitHub 导入只接受规范公开仓库地址", () => {
  assert.deepEqual(parseGitHubRepositoryURL("https://github.com/openai/openai-node"), {
    owner: "openai", repository: "openai-node", url: "https://github.com/openai/openai-node.git", webURL: "https://github.com/openai/openai-node"
  });
  assert.equal(parseGitHubRepositoryURL("https://github.com/openai/openai-node.git").repository, "openai-node");
  assert.throws(() => parseGitHubRepositoryURL("https://gitlab.com/openai/openai-node"), /只支持公开/);
  assert.throws(() => parseGitHubRepositoryURL("https://github.com/openai/openai-node/issues"), /必须是/);
  assert.throws(() => parseGitHubRepositoryURL("https://user@github.com/openai/openai-node"), /不能包含账号凭据/);
  assert.throws(() => parseGitHubRepositoryURL("https://github.com:8443/openai/openai-node"), /自定义端口/);
});

test("桌面导入只接受受支持的源码文件名", () => {
  assert.equal(isSupportedSourceFile("main.ts"), true);
  assert.equal(isSupportedSourceFile("Dockerfile"), true);
  assert.equal(isSupportedSourceFile("photo.png"), false);
});

test("预览元素只在产物清单内形成源码候选", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-preview-source-"));
  try {
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "index.html"), '<main><button id="save" class="primary action">保存项目</button></main>\n');
    await writeFile(path.join(directory, "src", "styles.css"), ".primary { color: rebeccapurple; }\n");
    await writeFile(path.join(directory, "secret.js"), 'document.querySelector("#save").remove();\n');
    const artifact = { kind: "html", filename: "index.html", files: ["src/styles.css"], projectRoot: directory };
    const candidates = await findPreviewSourceCandidates(artifact, { tag: "button", id: "save", classes: ["primary", "action"], text: "保存项目" });
    assert.equal(candidates[0].path, "index.html");
    assert.match(candidates[0].code, /保存项目/);
    assert.ok(candidates[0].signals.includes("id=save"));
    assert.equal(candidates.some((item) => item.path === "secret.js"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("预览对象 traceId 在 canvas 内直接形成精确源码候选", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-preview-trace-"));
  try {
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "index.html"), '<canvas id="scene"></canvas>\n');
    await writeFile(path.join(directory, "src", "apple.js"), 'leaf.userData.loopcanvas = { traceId: "apple.leaf", label: "绿叶" };\n');
    const artifact = { kind: "html", filename: "index.html", files: ["src/apple.js"], projectRoot: directory };
    const candidates = await findPreviewSourceCandidates(artifact, { kind: "three-object", traceId: "apple.leaf", label: "绿叶" });
    assert.equal(candidates[0].path, "src/apple.js");
    assert.ok(candidates[0].score >= 100);
    assert.ok(candidates[0].signals.includes("traceId=apple.leaf"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("没有 traceId 的 Three.js 自动组可按对象名形成源码候选", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-preview-object-"));
  try {
    await writeFile(path.join(directory, "index.html"), '<canvas id="scene"></canvas>\n');
    await writeFile(path.join(directory, "apple.js"), 'const appleLeaf = new THREE.Mesh(geometry, material);\nappleLeaf.name = "apple-leaf";\n');
    const artifact = { kind: "html", filename: "index.html", files: ["apple.js"], projectRoot: directory };
    const candidates = await findPreviewSourceCandidates(artifact, { kind: "three-group", groupId: "three:Apple/apple-leaf", objectName: "apple-leaf", objectPath: ["Apple", "apple-leaf"], label: "apple-leaf" });
    assert.equal(candidates[0].path, "apple.js");
    assert.ok(candidates[0].signals.includes("object=apple-leaf"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("仓库概要清单覆盖每个源码文档并标记截断与 Token 估算", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-repository-overview-"));
  try {
    await writeFile(path.join(directory, "small.js"), "export const small = true;\n");
    await writeFile(path.join(directory, "large.py"), "x = 1\n".repeat(3_000));
    const prepared = await buildRepositoryOverviewDocuments(directory, { maxExcerptBytes: 128 });
    assert.equal(prepared.documents.length, 2);
    assert.equal(prepared.documents.find((item) => item.path === "large.py").truncated, true);
    assert.equal(prepared.estimate.fileCount, 2);
    assert.ok(prepared.estimate.estimatedTokens > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
