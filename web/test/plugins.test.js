import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanCapabilities } from "../src/capabilities.js";
import { startServer } from "../src/server.js";
import { buildDshPluginPatch, bundledPluginsRoot, DSH_PLUGIN_RUNTIME_VERSION, listPlugins, validateManifest, resolveBundledPluginsRoot } from "../src/plugins.js";

test("validateManifest 拒绝不完整的清单", () => {
  assert.throws(() => validateManifest({ schemaVersion: 1, id: "x" }), /缺少必填字段 name/);
  assert.throws(() => validateManifest({ schemaVersion: 2, id: "x", name: "n" }), /不支持的清单版本/);
  assert.throws(() => validateManifest(null), /清单不是 JSON 对象/);
});

test("内置插件目录包含完整官方清单", async () => {
  const { items } = await listPlugins({ dataDirectory: path.join(os.tmpdir(), "loopcanvas-plugins-unit"), runtimeStates: {} });
  assert.ok(items.length >= 30, `内置插件应不少于 30 个，实际 ${items.length}`);
  for (const item of items) {
    assert.ok(item.manifest, `插件 ${item.id} 应有清单`);
    assert.ok(item.manifest.description.trim(), `${item.id} 应有简介`);
    assert.ok(item.manifest.problem.trim(), `${item.id} 应说明解决的问题`);
    assert.ok(item.manifest.audience.trim(), `${item.id} 应说明推荐人群`);
    assert.ok(item.runtime, `${item.id} 应有运行时同步状态`);
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.ok(byId.has("standard"), "应包含标准模式 preset");
  assert.equal(byId.get("standard").runtime.supported, false, "preset 不能当成单插件同步");
  assert.equal(byId.get("tool-web").runtime.state, "inherited");
  assert.equal(byId.get("tool-web").manifest.package, "@deepseek-ai/dsh-tool-web");
  assert.ok(byId.get("cordis-plugin-timer").manifest.version, "框架插件应有版本");
});

test("插件开启要求确认并同步到 dsh 状态，重启后保留", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-plugins-api-"));
  try {
    const runtimeOptions = { port: 0, dataDirectory: directory, workspace: path.join(directory, "workspace"), probeHarness: async () => ({ version: DSH_PLUGIN_RUNTIME_VERSION, path: "/fake/dsh" }) };
    const runtime = await startServer(runtimeOptions);
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };

    const before = await (await fetch(`${runtime.url}/api/plugins`)).json();
    assert.ok(before.items.some((item) => item.id === "tool-ralph"));
    assert.equal(before.items.find((item) => item.id === "tool-ralph").runtime.state, "inherited");

    const rejected = await fetch(`${runtime.url}/api/plugins/tool-ralph`, { method: "POST", headers, body: JSON.stringify({ enabled: true }) });
    assert.equal(rejected.ok, false, "未确认时必须拒绝开启");
    const turned = await (await fetch(`${runtime.url}/api/plugins/tool-ralph`, { method: "POST", headers, body: JSON.stringify({ enabled: true, confirmed: true }) })).json();
    assert.equal(turned.items.find((item) => item.id === "tool-ralph").runtime.state, "enabled");
    await new Promise((resolve) => runtime.server.close(resolve));

    const second = await startServer(runtimeOptions);
    try {
      const reloaded = await (await fetch(`${second.url}/api/plugins`)).json();
      assert.equal(reloaded.items.find((item) => item.id === "tool-ralph").runtime.state, "enabled", "重启后应保留同步开启状态");
      const back = await (await fetch(`${second.url}/api/plugins/tool-ralph`, { method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": (await (await fetch(`${second.url}/api/bootstrap`)).json()).token }, body: JSON.stringify({ enabled: false }) })).json();
      assert.equal(back.items.find((item) => item.id === "tool-ralph").runtime.state, "disabled");
    } finally {
      await new Promise((resolve) => second.server.close(resolve));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("用户自定义插件可覆盖内置同名插件", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-plugins-user-"));
  try {
    const userPlugins = path.join(directory, "plugins", "tool-web");
    await mkdir(userPlugins, { recursive: true });
    await writeFile(path.join(userPlugins, "plugin.json"), JSON.stringify({
      schemaVersion: 1, id: "tool-web", name: "自定义网页检索", kind: "tool", category: "retrieval",
      package: "@deepseek-ai/dsh-tool-web", version: "9.9.9", source: "https://example.com",
      license: "MIT", author: "你", description: "用户覆盖的内置插件简介。",
      problem: "用户覆盖的问题。", audience: "用户覆盖的人群。", defaultEnabled: false
    }, null, 2));

    const { items } = await listPlugins({ dataDirectory: directory, runtimeStates: {} });
    const custom = items.find((item) => item.id === "tool-web");
    assert.equal(custom.manifest.name, "自定义网页检索", "用户插件应覆盖内置插件");
    assert.equal(custom.manifest.version, "9.9.9");
    assert.equal(custom.runtime.supported, false, "未验证版本不能同步到 dsh");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("同步 patch 使用已验证的 headless 行并支持一个清单映射多个行", async () => {
  const patch = await buildDshPluginPatch({
    dataDirectory: path.join(os.tmpdir(), "loopcanvas-plugin-patch"),
    runtimeStates: { "tool-web": true, "cordis-plugin-hmr": false, "tool-subagent": true }
  });
  assert.match(patch, /- id: tool-web\n  disabled: false/);
  assert.match(patch, /- id: hmr\n  disabled: true/);
  assert.match(patch, /- id: tool-subagent\n  disabled: false/);
  assert.match(patch, /- id: tool-subagent-fork\n  disabled: false/);
  await assert.rejects(
    () => buildDshPluginPatch({ dataDirectory: path.join(os.tmpdir(), "loopcanvas-plugin-patch"), runtimeStates: { standard: true } }),
    /无法同步/
  );
});

test("本机 Codex 插件使用 manifest 名称而不是 .codex-plugin 目录名", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-codex-plugins-"));
  try {
    const manifestDirectory = path.join(home, ".codex", "plugins", "cache", "provider", "example", "1.0.0", ".codex-plugin");
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(path.join(manifestDirectory, "plugin.json"), JSON.stringify({ name: "Example Plugin" }));

    const items = await scanCapabilities("plugins", path.join(home, "workspace"), { homeDirectory: home });

    assert.equal(items.length, 1);
    assert.equal(items[0].name, "Example Plugin");
    assert.match(items[0].path, /\.codex-plugin\/plugin\.json$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});


test("plugin roots support both source checkouts and installed npm packages", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-package-plugins-"));
  try {
    const source = path.join(directory, "web", "src");
    await mkdir(source, { recursive: true });
    await mkdir(path.join(directory, "plugins"));
    assert.equal(resolveBundledPluginsRoot(source), path.join(directory, "plugins"));
    await mkdir(path.join(directory, "web", "plugins"));
    assert.equal(resolveBundledPluginsRoot(source), path.join(directory, "web", "plugins"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
