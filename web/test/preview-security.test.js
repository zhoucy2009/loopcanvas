import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { resolveVerificationBrowser } from "../src/browser-verifier.js";
import { startServer } from "../src/server.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "preview-security-"));
  const runtime = await startServer({ port: 0, dataDirectory: directory, workspace: path.join(directory, "workspace") });
  t.after(async () => {
    await new Promise(resolve => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const { token } = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
  const created = await (await fetch(`${runtime.url}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": token }, body: JSON.stringify({ goal: "Preview security regression" })
  })).json();
  const project = runtime.store.project(created.state.projects[0].id);
  await mkdir(project.workspace, { recursive: true });
  const content = `<h1>Security fixture</h1><script>window.executed = true; try { parent.document.body.dataset.compromised = 'yes'; window.parentAccess = true; } catch { window.parentAccess = false; }</script>`;
  await writeFile(path.join(project.workspace, "index.html"), content);
  await writeFile(path.join(project.workspace, "other.html"), content);
  await writeFile(path.join(directory, "private.txt"), "private-outside-workspace");
  await symlink(path.join(directory, "private.txt"), path.join(project.workspace, "linked.txt"));
  await runtime.store.mutate(() => {
    project.artifact = { kind: "html", title: "Preview", filename: "index.html", projectRoot: project.workspace,
      content: "", files: ["index.html", "other.html", "linked.txt"], dependencies: [] };
  });
  return { runtime, project, directory, preview: `${runtime.url}/preview/${project.id}/` };
}

test("preview entry and secondary documents have an opaque sandbox; declared symlinks cannot escape", async t => {
  const { preview, runtime, project } = await fixture(t);
  for (const name of ["index.html", "other.html"]) {
    const response = await fetch(preview + name);
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /(?:^|;\s*)sandbox allow-scripts;/);
    assert.doesNotMatch(csp, /allow-same-origin/);
  }
  const escaped = await fetch(preview + "linked.txt");
  assert.equal(escaped.status, 403);
  assert.doesNotMatch(await escaped.text(), /private-outside-workspace/);
  await runtime.store.mutate(() => { project.artifact = { kind: "html", filename: "index.html", content: "<h1>Inline</h1>" }; });
  assert.match((await fetch(preview)).headers.get("content-security-policy"), /sandbox allow-scripts;/);
});

test("real browser runs preview scripts but denies access to the admin document", { skip: process.env.LOOPCANVAS_TEST_BROWSER !== "1" }, async t => {
  const { preview, runtime, directory } = await fixture(t);
  const browser = await chromium.launch({ executablePath: await resolveVerificationBrowser(), headless: true, chromiumSandbox: true,
    env: { PATH: process.env.PATH || "", HOME: directory, TMPDIR: directory } });
  try {
    const page = await browser.newPage();
    await page.goto(runtime.url);
    for (const name of ["index.html", "other.html"]) {
      await page.evaluate(src => {
        document.querySelector("#security-frame")?.remove();
        const frame = document.createElement("iframe");
        frame.id = "security-frame";
        frame.src = src;
        document.body.append(frame);
      }, preview + name);
      const frame = page.frameLocator("#security-frame");
      await frame.locator("body").waitFor();
      assert.deepEqual(await frame.locator("body").evaluate(() => ({ executed: window.executed, parentAccess: window.parentAccess })), { executed: true, parentAccess: false });
      assert.equal(await page.evaluate(() => document.body.dataset.compromised), undefined);
    }
  } finally { await browser.close(); }
});
