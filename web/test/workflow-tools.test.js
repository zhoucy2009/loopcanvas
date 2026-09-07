import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkflowTools } from "../src/workflow-tools.js";

test("local media transcription writes durable text and segment artifacts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-tools-"));
  const dataDirectory = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  const inputPath = path.join(root, "meeting.mp3");
  await writeFile(inputPath, "fake audio");
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const processRunner = async (executable, args) => {
    calls.push({ executable, args });
    if (executable === "/usr/bin/xcrun") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: JSON.stringify({ status: "success", locale: "zh-CN", text: "测试转写", segments: [{ text: "测试转写", startSeconds: 0, durationSeconds: 1.2 }], installedLanguageAsset: false }), stderr: "" };
  };
  const tools = createWorkflowTools({ dataDirectory, processRunner });
  const result = await tools.execute({ run: { id: "run-1" }, node: { tool: "local_media_transcribe", arguments: { inputPath } } }, { workspace }, undefined, () => {});
  assert.equal(result.result.status, "success");
  assert.equal(result.result.output.text, "测试转写");
  assert.equal(await readFile(path.join(workspace, "workflow-runs", "run-1", "transcript.txt"), "utf8"), "测试转写\n");
  assert.equal(JSON.parse(await readFile(path.join(workspace, "workflow-runs", "run-1", "transcript.segments.json"), "utf8"))[0].durationSeconds, 1.2);
  assert.equal(calls[0].executable, "/usr/bin/xcrun");
  assert.equal(calls.length, 2);
  assert.equal(await tools.execute({ run: { id: "run-2" }, node: { tool: "another_tool", arguments: {} } }, { workspace }), null);
});

test("local media transcription rejects missing or relative input paths before running a process", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-tools-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const tools = createWorkflowTools({ dataDirectory: path.join(root, "data"), processRunner: async () => { calls++; return { code: 0, stdout: "", stderr: "" }; } });
  await assert.rejects(() => tools.execute({ run: { id: "run" }, node: { tool: "local_media_transcribe", arguments: { inputPath: "video.mp4" } } }, { workspace: root }), /完整路径/);
  assert.equal(calls, 0);
});

test("local media clipping validates timestamps and writes a durable manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-media-clips-"));
  const inputPath = path.join(root, "source.mp4");
  const workspace = path.join(root, "workspace");
  await writeFile(inputPath, "fake video");
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const tools = createWorkflowTools({ dataDirectory: path.join(root, "data"), processRunner: async (executable, args) => {
    calls.push({ executable, args });
    const output = args[args.indexOf("--output") + 1];
    await writeFile(output, "fake clip");
    return { code: 0, stdout: "", stderr: "" };
  } });
  const outcome = await tools.execute({ run: { id: "clip-run" }, node: { tool: "local_media_clip", arguments: { inputPath, clips: [{ startSeconds: 1.25, durationSeconds: 2.5, text: "候选", keywords: ["测试"] }], outputPrefix: "punchline" } } }, { workspace });
  assert.equal(outcome.result.output.clips[0].filename, "punchline-001.mov");
  assert.equal(calls[0].executable, "/usr/bin/avconvert");
  assert.ok(calls[0].args.includes("1.25"));
  const manifest = JSON.parse(await readFile(outcome.result.output.manifestPath, "utf8"));
  assert.equal(manifest[0].durationSeconds, 2.5);
  await assert.rejects(() => tools.execute({ run: { id: "bad-clip" }, node: { tool: "local_media_clip", arguments: { inputPath, clips: [{ startSeconds: -1, durationSeconds: 2 }] } } }, { workspace }), /时间码无效/);
});
