import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCodex } from "../src/codex.js";
import { codexVersion, compareCodexVersions, startCodexAutoUpdates, updateStandaloneCodex } from "../src/codex-installation.js";

async function executable(file, version) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\necho 'codex-cli ${version}'\n`);
  await chmod(file, 0o755);
  return file;
}

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-codex-install-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("chooses the newer Codex across PATH and desktop bundles, preserving explicit overrides", async t => {
  const home = await fixture(t);
  const cli = await executable(path.join(home, "bin", "codex"), "0.150.1");
  const bundle = await executable(path.join(home, "ChatGPT.app", "Contents", "Resources", "codex"), "0.153.4");
  const options = { home, envPath: path.dirname(cli), platform: "darwin", applicationsRoot: home, fallbackPaths: [], explicitPath: "" };
  assert.equal(await resolveCodex(options), bundle);
  assert.equal(await resolveCodex({ ...options, explicitPath: cli }), cli);
  assert.equal(await resolveCodex({ ...options, explicitPath: path.join(home, "missing") }), null);
  await executable(cli, "0.154.0");
  assert.equal(await resolveCodex(options), cli);
  await executable(cli, "0.153.4");
  assert.equal(await resolveCodex(options), bundle);
});

test("recognizes an atomically replaced standalone symlink without restarting the server", async t => {
  const home = await fixture(t);
  const old = await executable(path.join(home, "old", "codex"), "0.150.1");
  const newer = await executable(path.join(home, "new", "codex"), "0.153.4");
  const link = path.join(home, "codex");
  await symlink(old, link);
  assert.equal(await codexVersion(link), "0.150.1");
  await unlink(link);
  await symlink(newer, link);
  assert.equal(await codexVersion(link), "0.153.4");
  assert.ok(compareCodexVersions("0.153.4", "0.153.4-beta.2") > 0);
  assert.ok(compareCodexVersions("0.153.10", "0.153.9") > 0);
});

test("standalone updater uses the native noninteractive updater and verifies the activated version", async t => {
  const home = await fixture(t);
  const old = await executable(path.join(home, "packages", "standalone", "releases", "old", "codex"), "0.150.1");
  const newer = await executable(path.join(home, "packages", "standalone", "releases", "new", "codex"), "0.153.4");
  const link = path.join(home, "codex");
  await symlink(old, link);
  const result = await updateStandaloneCodex({
    discover: async () => [{ path: link, version: "0.150.1" }],
    run: async (file, args, options) => {
      assert.equal(file, link);
      assert.deepEqual(args, ["update"]);
      assert.equal(options.env.CODEX_NON_INTERACTIVE, "1");
      assert.ok(options.timeout > 0);
      await unlink(link);
      await symlink(newer, link);
    }
  });
  assert.deepEqual(result, { status: "updated", before: "0.150.1", after: "0.153.4" });
  assert.match(await readFile(old, "utf8"), /0.150.1/);
});

test("automatic updates skip pinned paths and desktop or package-manager installs", async t => {
  const home = await fixture(t);
  const bundle = await executable(path.join(home, "ChatGPT.app", "Contents", "Resources", "codex"), "0.153.4");
  const run = async () => assert.fail("must not mutate an unmanaged executable");
  assert.equal((await updateStandaloneCodex({ settings: { codexPath: bundle }, run })).status, "pinned");
  assert.equal((await updateStandaloneCodex({ discover: async () => [{ path: bundle, version: "0.153.4" }], run })).status, "unmanaged");
});

test("auto-updates start immediately, deduplicate concurrent checks, retry failures and stop cleanly", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let finish;
  let calls = 0;
  const errors = [], results = [];
  const updater = startCodexAutoUpdates({
    enabled: true, intervalMs: 100,
    update: async () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { finish = resolve; });
      if (calls === 2) throw new Error("offline");
      return { status: "current" };
    },
    onResult: result => results.push(result), onError: error => errors.push(error.message)
  });
  await Promise.resolve();
  assert.equal(updater.check(), updater.ready);
  t.mock.timers.tick(100);
  assert.equal(calls, 1);
  finish({ status: "updated" });
  await updater.ready;
  t.mock.timers.tick(100);
  await updater.check();
  assert.deepEqual(errors, ["offline"]);
  t.mock.timers.tick(100);
  await updater.check();
  assert.equal(calls, 3);
  assert.equal(results.length, 2);
  updater.stop();
  t.mock.timers.tick(1000);
  await updater.check();
  assert.equal(calls, 3);
});

test("auto-update opt-out performs no checks", async () => {
  const updater = startCodexAutoUpdates({ enabled: false, update: async () => assert.fail("disabled") });
  await updater.ready;
  await updater.check();
  updater.stop();
});
