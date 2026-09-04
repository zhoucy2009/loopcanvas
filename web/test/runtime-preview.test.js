import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";

function requestWithHost(port, host, pathname = "/") {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, headers: { Host: host } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}

test("运行时产物通过独立 localhost 子域启动、代理并注入图形编辑桥", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-runtime-preview-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const runtime = await startServer({ port: 0, dataDirectory: directory, workspace, runtimePreview: { startupTimeoutMs: 5_000 } });
  try {
    const created = await runtime.store.createProject({ goal: "测试运行时预览" });
    const project = runtime.store.project(created.id);
    const projectRoot = project.workspace;
    await writeFile(path.join(projectRoot, "preview-app.mjs"), `
      import http from "node:http";
      const server = http.createServer((request, response) => {
        if (request.url.startsWith("/asset.js")) {
          response.writeHead(200, { "Content-Type": "text/javascript" });
          return response.end("document.body.dataset.runtime = 'ready'");
        }
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "X-Frame-Options": "DENY" });
        response.end('<!doctype html><html><head></head><body><button data-loopcanvas-trace="runtime-button">运行时界面</button><script src="/asset.js"></script></body></html>');
      });
      server.listen(Number(process.env.PORT), "127.0.0.1");
    `);
    await runtime.store.mutate(() => {
      project.artifact = {
        title: "React 风格运行时产物", kind: "text", filename: "src/App.tsx", files: ["src/App.tsx"],
        projectRoot, entrypoint: "/", runCommands: ["node preview-app.mjs"]
      };
    });

    const port = runtime.server.address().port;
    const previewHost = `preview-${project.id}.localhost:${port}`;
    const shell = await requestWithHost(port, `127.0.0.1:${port}`);
    assert.match(String(shell.headers["content-security-policy"]), /frame-src 'self' http:\/\/\*\.localhost:\*/);
    const page = await requestWithHost(port, previewHost);
    assert.equal(page.status, 200);
    assert.match(page.body, /运行时界面/);
    assert.match(page.body, /__loopcanvas\/preview-trace\.js/);
    assert.equal(page.headers["x-frame-options"], undefined);
    assert.equal(page.headers["content-security-policy"], undefined);

    const asset = await requestWithHost(port, previewHost, "/asset.js");
    assert.equal(asset.status, 200);
    assert.match(asset.body, /dataset\.runtime/);

    const bridge = await requestWithHost(port, previewHost, "/__loopcanvas/preview-trace.js");
    assert.equal(bridge.status, 200);
    assert.match(bridge.body, /loopcanvas:preview-select/);
  } finally {
    await runtime.runtimePreviewManager.close();
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
