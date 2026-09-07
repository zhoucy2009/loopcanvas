import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceCheckpoints } from "../src/workspace-checkpoints.js";
import { applyAdaptiveRoute, StateStore } from "../src/store.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-worktree-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  return { directory, workspace, checkpoints: new WorkspaceCheckpoints(path.join(directory, "snapshots")) };
}

test("Git worktree restores exact bytes, ignored files, symlinks, modes and empty directories without changing project Git", async (t) => {
  const { directory, workspace, checkpoints } = await fixture(t);
  const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  await writeFile(path.join(workspace, "tracked.txt"), "committed\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Initial");
  const head = git("rev-parse", "HEAD");
  await writeFile(path.join(workspace, "tracked.txt"), "staged\n");
  git("add", ".");
  const index = await readFile(path.join(workspace, ".git/index"));
  await writeFile(path.join(workspace, "tracked.txt"), "unstaged\r\n");
  await writeFile(path.join(workspace, ".gitignore"), "ignored.bin\n");
  await writeFile(path.join(workspace, ".gitattributes"), "* text eol=lf\n");
  const binary = Buffer.from([0, 255, 13, 10, 128]);
  await writeFile(path.join(workspace, "ignored.bin"), binary);
  await writeFile(path.join(workspace, "run.sh"), "#!/bin/sh\n");
  await chmod(path.join(workspace, "run.sh"), 0o751);
  await mkdir(path.join(workspace, "empty"));
  const outside = path.join(directory, "outside.txt");
  await writeFile(outside, "outside");
  await symlink(outside, path.join(workspace, "link"));
  const snapshot = await checkpoints.capture(workspace);
  await rm(path.join(workspace, "tracked.txt"));
  await rm(path.join(workspace, "empty"), { recursive: true });
  await writeFile(path.join(workspace, "ignored.bin"), "changed");
  await writeFile(path.join(workspace, "new.txt"), "new");
  await rm(path.join(workspace, "link"));
  await mkdir(path.join(workspace, "link"));
  const transaction = await checkpoints.restore(workspace, snapshot);
  await transaction.dispose();
  assert.equal(await readFile(path.join(workspace, "tracked.txt"), "utf8"), "unstaged\r\n");
  assert.deepEqual(await readFile(path.join(workspace, "ignored.bin")), binary);
  assert.equal((await lstat(path.join(workspace, "run.sh"))).mode & 0o777, 0o751);
  assert.deepEqual(await readdir(path.join(workspace, "empty")), []);
  assert.equal(await readlink(path.join(workspace, "link")), outside);
  assert.equal(await readFile(outside, "utf8"), "outside");
  await assert.rejects(lstat(path.join(workspace, "new.txt")), { code: "ENOENT" });
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.deepEqual(await readFile(path.join(workspace, ".git/index")), index);
});

test("step rollback restores the previous whole workflow, survives reload and reuses checkpoints", async (t) => {
  const { directory, workspace } = await fixture(t);
  let store = new StateStore(path.join(directory, "state.json"), workspace);
  await store.load();
  const id = (await store.createProject({ goal: "rollback" })).id;
  let project = store.project(id);
  applyAdaptiveRoute(project, { executionShape: "graph", primaryArtifact: { filename: "result.txt" }, steps: [{ id: "a", title: "A", dependencies: [] }, { id: "b", title: "B", dependencies: ["a"] }] });
  const file = path.join(project.workspace, "result.txt");
  await writeFile(file, "before A");
  const a = await store.createCheckpoint(id, "before A", { kind: "execution", stepId: "a" });
  await writeFile(file, "after A");
  await store.mutate(() => { project.steps[0].status = "approved"; project.steps[0].result = { summary: "A" }; project.steps[1].status = "ready"; });
  const b = await store.createCheckpoint(id, "before B", { kind: "execution", stepId: "b" });
  await writeFile(file, "after B");
  await store.mutate(() => { project.steps[1].status = "approved"; project.steps[1].agentReview = { verdict: "pass" }; project.finalReview = { status: "passed" }; project.artifact = { filename: "result.txt" }; });
  store = new StateStore(path.join(directory, "state.json"), workspace);
  await store.load();
  await store.rollbackStep(id, "b");
  project = store.project(id);
  assert.equal(await readFile(file, "utf8"), "after A");
  assert.equal(project.steps[0].status, "approved");
  assert.equal(project.steps[1].status, "ready");
  assert.equal(project.steps[1].agentReview, null);
  assert.equal(project.artifact, null);
  assert.equal(project.finalReview, null);
  await store.rollbackStep(id, "b");
  await store.rollbackStep(id, "a");
  assert.equal(await readFile(file, "utf8"), "before A");
  assert.deepEqual(store.project(id).steps.map((step) => step.status), ["ready", "locked"]);
  assert.deepEqual(store.project(id).checkpoints.map((checkpoint) => checkpoint.id), [a, b]);
  await store.restoreCheckpoint(id, b);
  assert.equal(await readFile(file, "utf8"), "after A");
  // A rerun must capture its actual input, not reuse the initial execution's files.
  await writeFile(file, "manual repair before retry");
  const retry = await store.createCheckpoint(id, "retry B", { kind: "execution", stepId: "b" });
  await writeFile(file, "retry output");
  await store.rollbackStep(id, "b");
  assert.equal(await readFile(file, "utf8"), "manual repair before retry");
  assert.equal(store.project(id).steps[1].rollbackCheckpointId, retry);
});

test("a failed state save undoes file restoration; missing and legacy snapshots never claim success", async (t) => {
  const { directory, workspace } = await fixture(t);
  const store = new StateStore(path.join(directory, "state.json"), workspace);
  await store.load();
  const id = (await store.createProject({ goal: "transaction" })).id;
  const file = path.join(store.project(id).workspace, "value");
  await writeFile(file, "before");
  const checkpoint = await store.createCheckpoint(id);
  await writeFile(file, "after");
  const before = store.snapshot();
  const save = store.save;
  store.save = async () => { throw new Error("disk full"); };
  await assert.rejects(store.restoreCheckpoint(id, checkpoint), /disk full/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(await readFile(file, "utf8"), "after");
  store.save = save;
  const metadata = store.project(id).checkpoints[0].workspaceSnapshot;
  metadata.commit = "0".repeat(40);
  await assert.rejects(store.restoreCheckpoint(id, checkpoint));
  assert.equal(await readFile(file, "utf8"), "after");
  delete store.project(id).checkpoints[0].workspaceSnapshot;
  await assert.rejects(store.restoreCheckpoint(id, checkpoint), /没有文件快照/);
  assert.equal(await readFile(file, "utf8"), "after");
});

test("checkpoint storage inside a workspace is rejected before snapshotting", async (t) => {
  const { workspace } = await fixture(t);
  await assert.rejects(new WorkspaceCheckpoints(path.join(workspace, "snapshots")).capture(workspace), /不能互相包含/);
});
