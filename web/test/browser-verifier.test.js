import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { browserAsset, verifyBrowserArtifact } from "../src/browser-verifier.js";

test("browser verifier refuses URLs, traversal, hidden files and symlink escape", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-boundary-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "browser-outside-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(path.join(root, "index.html"), "<h1>OK</h1>");
  await writeFile(path.join(outside, "private.html"), "private");
  await symlink(path.join(outside, "private.html"), path.join(root, "linked.html"));
  assert.equal((await browserAsset(root, "index.html")).contentType, "text/html");
  for (const entrypoint of ["../private.html", "/etc/passwd", ".env", "linked.html", "https://example.com", "..\\private.html"]) {
    await assert.rejects(() => verifyBrowserArtifact(root, { entrypoint }));
  }
  await assert.rejects(() => verifyBrowserArtifact(root, { entrypoint: "index.html", width: 30000 }));
  await assert.rejects(() => verifyBrowserArtifact(root, { entrypoint: "index.html", executablePath: "/bin/sh" }));
  await symlink(outside, path.join(root, ".loopcanvas-browser"));
  await assert.rejects(() => verifyBrowserArtifact(root, { entrypoint: "index.html" }), /符号链接|未找到/);
  assert.deepEqual(await readdir(outside), ["private.html"]);
});

test("real isolated browser creates PNG and A3 PDF and reports blocked private-network requests", { skip: process.env.LOOPCANVAS_TEST_BROWSER !== "1" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "index.html"), `<!doctype html><meta charset="utf-8"><title>Browser verification</title><style>@page{size:A3 portrait;margin:0}body{margin:0}h1{color:green}</style><h1>Browser verification</h1><script>fetch('http://127.0.0.1:4317/api/state').catch(()=>{})</script>`);
  const { report, screenshot } = await verifyBrowserArtifact(root, { entrypoint: "index.html", width: 800, height: 600 });
  assert.equal(screenshot.subarray(1, 4).toString(), "PNG");
  assert.equal(report.pdf.pageCount, 1);
  assert.ok(Math.abs(report.pdf.pages[0].width - 841.89) < 2);
  assert.ok(Math.abs(report.pdf.pages[0].height - 1190.55) < 2);
  assert.ok(report.issues.length > 0);
  assert.equal(report.acceptancePassed, null);
  assert.equal((await readFile(report.printPDF)).subarray(0, 5).toString(), "%PDF-");
  assert.equal(JSON.parse(await readFile(path.join(path.dirname(report.screenshot), "report.json"))).sourceSHA256, report.sourceSHA256);
});
