import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeMediaMatch } from "../src/media-match.js";
import { videoCompositionNodes } from "../public/workflow-media-model.js";
import { generateWorkflowNodesWithHarness } from "../src/harness.js";
import { BUILTIN_WORKFLOW_TOOLS } from "../src/workflow-tools.js";
import { startServer } from "../src/server.js";

test("two-video generation preserves independent inputs and a real composition step", async () => {
  const prompt = "在第二个视频每句话后插入于谦捧哏片段，输出完整视频";
  const generated = await generateWorkflowNodesWithHarness({ prompt, tools: BUILTIN_WORKFLOW_TOOLS.map((tool) => ({ ...tool, available: true })) }, {});
  assert.deepEqual(generated.nodes.filter((node) => node.tool === "local_media_transcribe").map((node) => node.arguments.inputPath), ["{{input.input1}}", "{{input.input2}}"]);
  assert.deepEqual(generated.inputs.map((input) => input.key), ["input1", "input2"]);
  assert.equal(generated.nodes.at(-1).type, "approval", "delivery requires actual viewing confirmation");
  assert.equal(generated.nodes.at(-2).tool, "local_media_compose");
  assert.equal(generated.nodes.at(-3).type, "review", "composition follows independent review");
  assert.equal(generated.nodes.at(-4).tool, "agent_media_match");
  await assert.rejects(() => generateWorkflowNodesWithHarness({ prompt, tools: [] }, {}), /不能生成不完整/);
});

test("semantic matching computes timecodes from both real candidate lists and rejects fabricated indexes", () => {
  const args = { sourceCandidates: [{ text: "回应", startSeconds: 1, durationSeconds: 2 }], targetCandidates: [{ text: "主视频句子", startSeconds: 3, durationSeconds: 4 }] };
  const result = { status: "success", output: { matches: [{ sourceIndex: 0, targetIndex: 0, atSeconds: 999, sourceStartSeconds: 999 }] } };
  const normalized = normalizeMediaMatch(result, args);
  assert.equal(normalized.output.insertions[0].atSeconds, 7);
  assert.equal(normalized.output.insertions[0].sourceStartSeconds, 1);
  assert.throws(() => normalizeMediaMatch({ status: "success", output: { matches: [] } }, args), /未生成成片/);
  assert.throws(() => normalizeMediaMatch({ status: "success", output: { matches: [{ sourceIndex: 4, targetIndex: 0 }] } }, args), /不存在/);
});

test("two-video execution blocks missing second media and missing final output; downloads are scoped to the run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wf-two-video-"));
  const server = await startServer({ port: 0, dataDirectory: path.join(root, "data"), workspace: root, listCodexTools: async () => [] });
  t.after(async () => { await new Promise((resolve) => server.server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const nodes = videoCompositionNodes("双视频插入");
  const workflow = server.workflowLibrary.save({ name: "合成验收", nodes, edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id, when: "always" })), triggers: ["click"] });
  const sourceVideo = path.join(root, "source.mp4"), targetVideo = path.join(root, "target.mp4");
  await writeFile(sourceVideo, "source"); await writeFile(targetVideo, "target");
  assert.throws(() => server.workflowRuntime.start(workflow.id, { sourceVideo }, { workspace: root }), /targetVideo/);
  assert.throws(() => server.workflowRuntime.start(workflow.id, { sourceVideo, targetVideo: sourceVideo }, { workspace: root }), /不同文件/);
  assert.equal(server.workflowLibrary.catalog().runs.length, 0);
  server.workflowRuntime.execute = async () => ({ result: { status: "success", output: { candidates: [], insertions: [] } } });
  const run = server.workflowRuntime.start(workflow.id, { sourceVideo, targetVideo }, { workspace: root });
  await server.workflowRuntime.jobs.get(run.id);
  assert.equal(server.workflowLibrary.get("runs", run.id).status, "failed");
  assert.match(server.workflowLibrary.get("runs", run.id).error, /成品视频/);
  const directory = path.join(root, "workflow-runs", run.id);
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "finished.mp4"), "0123456789");
  await symlink(sourceVideo, path.join(directory, "escape.mp4"));
  const recorded = server.workflowLibrary.get("runs", run.id);
  recorded.data.artifacts = [{ title: "成片", path: "finished.mp4", role: "final" }, { path: "../../source.mp4" }, { path: "escape.mp4" }];
  server.workflowLibrary.put("runs", recorded);
  const url = `${server.url}/api/workflow-library/runs/${run.id}/artifacts/0`;
  const download = await fetch(url); assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition"), /attachment/); assert.equal(await download.text(), "0123456789");
  const range = await fetch(url, { headers: { Range: "bytes=2-5" } }); assert.equal(range.status, 206); assert.equal(await range.text(), "2345");
  assert.equal((await fetch(url, { headers: { Range: "bytes=50-" } })).status, 416);
  for (const index of [1, 2, 99]) assert.equal((await fetch(url.slice(0, -1) + index)).status, 400);
});
