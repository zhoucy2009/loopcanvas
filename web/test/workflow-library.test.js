import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowLibrary, WorkflowRuntime } from "../src/workflow-library.js";
import { validateWorkflow, matchWorkflowPrompt, resolveData } from "../public/workflow-model.js";
import { copyGraphSelection, pasteGraphSelection } from "../public/workflow-library-ui.js";
import { resolveModelRoute } from "../src/smart-routing.js";
import { generateWorkflowNodesWithHarness, normalizeTranscriptAnalysisResult } from "../src/harness.js";
import { startServer } from "../src/server.js";
const tool = (id) => ({ id, type: "tool", title: id, tool: "test_tool", arguments: {} });
const definition = () => ({ name: "摘要", triggers: ["click", "drag", "prompt"], variables: { ready: true }, nodes: [tool("first"), tool("second"), { id: "out", type: "output", title: "交付" }], edges: [{from:"first",to:"second",when:"always"},{from:"second",to:"out",when:"always"}] });
async function fixture(t) { const dir = await mkdtemp(path.join(os.tmpdir(), "wf-library-")); const file = path.join(dir,"workflows.sqlite"); const db = new WorkflowLibrary(file); t.after(async () => { db.close(); await rm(dir,{recursive:true,force:true}); }); return { db, dir, file }; }
const outcome = (result = {}) => ({ result: { status: "success", summary: "完成", output: "ok", evidence: ["test"], ...result }, rawOutput: "model-response" });

test("resume rechecks inputs, preserves completed work and failure history, and rejects unsafe replay", async (t) => {
  const { db, dir } = await fixture(t);
  const input = path.join(dir, "input.txt"); await writeFile(input, "source");
  const calls = [];
  const runtime = new WorkflowRuntime(db, async ({ node }, settings) => {
    calls.push(node.id);
    if (node.id === "second" && calls.length === 2) throw new Error("malformed JSON");
    assert.equal(settings.workspace, dir);
    return outcome();
  });
  t.after(() => runtime.close());
  const def = definition(); def.inputs = [{ key: "source", label: "输入", type: "file", required: true }];
  def.nodes[1].tool = "agent_transcript_analyze";
  const w = db.save(def);
  const run = runtime.start(w.id, { inputs: { source: input } }, { workspace: dir });
  await runtime.jobs.get(run.id);
  assert.equal(runtime.canResume(db.get("runs", run.id)), true);
  await rm(input);
  assert.throws(() => runtime.resume(run.id, { workspace: dir }), /输入/);
  assert.equal(db.get("runs", run.id).status, "failed");
  await writeFile(input, "source");
  // Editing the template does not replace the immutable execution snapshot.
  db.save({ ...w, name: "edited", nodes: [tool("new")], edges: [] });
  runtime.resume(run.id, { workspace: path.join(dir, "changed-workspace") });
  assert.throws(() => runtime.resume(run.id, { workspace: dir }));
  await runtime.jobs.get(run.id);
  const finished = db.get("runs", run.id);
  assert.equal(finished.status, "complete");
  assert.deepEqual(calls, ["first", "second", "second", "out"]);
  assert.equal(finished.records[1].error, "malformed JSON");
  assert.equal(finished.attempts[0].error, "malformed JSON");
  assert.equal(finished.workflowRevision, w.revision);
  assert.throws(() => runtime.resume(run.id, { workspace: dir }));
  finished.status = "failed"; finished.nodeStates = { first: "failed" }; db.put("runs", finished);
  assert.throws(() => runtime.resume(run.id, { workspace: dir }), /只有失败的只读/);
});

test("SQLite persists versioned workflows, rejects stale edits, packs and atomically undoes skills", async (t) => {
  const { db, file } = await fixture(t);
  const w = db.save(definition());
  assert.throws(() => db.save({ ...w, revision: 0 }), /其他窗口/);
  const packed = db.pack(w.id,w.revision,["first","second"],"提取摘要");
  assert.equal(packed.nodes.length,2); assert.equal(db.catalog().skills.length,1);
  assert.equal(db.save(packed).revision,packed.revision, "saving unchanged content keeps undo valid");
  assert.match(db.catalog().skills[0].detail,/test_tool/);
  const other = new WorkflowLibrary(file); assert.equal(other.workflow(w.id).revision,2); other.close();
  assert.equal(db.undoPack(w.id,packed.revision).nodes.length,3);
  assert.equal(db.catalog().skills.length,0);
  assert.throws(() => db.save({ ...definition(), name:w.name }), /名称已存在/);
});

test("rejects cycles, malformed graph and non-contiguous selections without partial writes", async (t) => {
  const { db } = await fixture(t); const w = db.save(definition());
  assert.throws(() => validateWorkflow({ ...w, edges:[...w.edges,{from:"out",to:"first",when:"always"}] }),/循环/);
  assert.throws(() => db.pack(w.id,w.revision,["first","out"],"bad"),/连续/);
  assert.equal(db.catalog().skills.length,0); assert.equal(db.workflow(w.id).revision,1);
  assert.throws(() => resolveData("{{globals.missing}}",{ globals:{} }),/找不到/);
  assert.equal(resolveData("{{globals.count}}",{globals:{count:2}}),2);
  assert.equal(resolveData("hello {{globals.count}}",{globals:{count:2}}),"hello 2");
});

test("duplicates workflows with unique names and soft-deletes without removing run history", async (t) => {
  const { db } = await fixture(t);
  const source = db.save(definition());
  const firstCopy = db.duplicate(source.id);
  const secondCopy = db.duplicate(source.id);
  assert.equal(firstCopy.name, "摘要 副本");
  assert.equal(secondCopy.name, "摘要 副本 2");
  assert.throws(() => db.remove(firstCopy.id, 0), /版本已变化/);
  db.put("runs", { id: "kept-run", workflowId: firstCopy.id, status: "complete", createdAt: new Date().toISOString() });
  db.remove(firstCopy.id, firstCopy.revision);
  assert.equal(db.catalog().workflows.some((workflow) => workflow.id === firstCopy.id), false);
  assert.equal(db.catalog().runs.some((run) => run.id === "kept-run"), true);
});

test("node copy and paste preserve internal arrows and remap output references", () => {
  const workflow = definition();
  workflow.nodes[1].arguments = { previous: "{{outputs.first}}", external: "{{outputs.out}}" };
  const payload = copyGraphSelection(workflow, ["first", "second"]);
  let index = 0;
  const pasted = pasteGraphSelection(payload, () => `copy-${++index}`);
  assert.deepEqual(pasted.edges, [{ from: "copy-1", to: "copy-2", when: "always" }]);
  assert.equal(pasted.nodes[1].arguments.previous, "{{outputs.copy-1}}");
  assert.equal(pasted.nodes[1].arguments.external, "{{outputs.out}}");
  assert.equal(pasted.nodes[0].x, 32);
});

test("transcript semantic candidates are bounded to real source segments", () => {
  const node = { tool: "agent_transcript_analyze", arguments: { criteria: "识别包袱", contextSeconds: 0.5, transcript: { segments: [
    { text: "前一句", startSeconds: 1, durationSeconds: 2 },
    { text: "结果反转", startSeconds: 3, durationSeconds: 1.5 }
  ] } } };
  const result = normalizeTranscriptAnalysisResult({ status: "success", output: { candidates: [{ sourceSegmentIndexes: [0, 1], text: "模型编造文本", startSeconds: 99, durationSeconds: 99, score: 1.5, keywords: ["反转"] }] } }, node);
  assert.equal(result.output.candidates[0].text, "前一句 结果反转");
  assert.equal(result.output.candidates[0].startSeconds, 0.5);
  assert.equal(result.output.candidates[0].durationSeconds, 4.5);
  assert.equal(result.output.candidates[0].score, 1);
  assert.throws(() => normalizeTranscriptAnalysisResult({ status: "success", output: { candidates: [{ sourceSegmentIndexes: [3] }] } }, node), /来源片段索引/);
});

test("media workflow descriptions deterministically compose transcription, semantic analysis and clipping", async () => {
  const tools = ["local_media_transcribe", "agent_transcript_analyze", "local_media_clip"].map((name) => ({ name, available: true }));
  const generated = await generateWorkflowNodesWithHarness({ prompt: "识别每一句完整捧哏，生成关键词并按句分割音频", tools }, {});
  assert.deepEqual(generated.nodes.map((node) => node.tool), ["local_media_transcribe", "agent_transcript_analyze", "local_media_clip"]);
  assert.equal(generated.nodes[1].arguments.transcript, "{{outputs.transcribe}}");
  assert.equal(generated.nodes[2].arguments.clips, "{{outputs.analyze.candidates}}");
  assert.equal(generated.request.deterministicMediaPipeline, true);
});

test("prompt triggers match exact saved names and preserve the requested task", async () => {
  const w = { ...definition(), id:"w" };
  for (const prompt of ['用摘要工作流完成测试','请用“摘要”工作流完成测试','用「摘要」工作流完成测试']) assert.deepEqual(matchWorkflowPrompt(prompt,[w]),{workflowId:"w",goal:"测试",trigger:"prompt"});
  assert.equal(matchWorkflowPrompt("普通需求",[w]),null);
  assert.throws(() => matchWorkflowPrompt("用不存在工作流完成测试",[w]),/找不到/);
  assert.throws(() => matchWorkflowPrompt("用摘要工作流完成测试",[{...w,triggers:["click"]}]),/找不到/);
});

test("runtime follows arrows, skips inactive branches, joins active paths and persists state + model records", async (t) => {
  const { db } = await fixture(t);
  const w = db.save({ ...definition(), nodes:[tool("a"),{id:"choice",type:"condition",title:"判断",condition:{path:"globals.ready",operator:"equals",value:true}},tool("yes"),tool("no"),tool("join")], edges:[{from:"a",to:"choice",when:"always"},{from:"choice",to:"yes",when:"true"},{from:"choice",to:"no",when:"false"},{from:"yes",to:"join",when:"always"},{from:"no",to:"join",when:"always"}] });
  const calls = [];
  const rt = new WorkflowRuntime(db,async ({node,run}) => { calls.push(node.id); return outcome({ statePatch:{ globals:{ count:(run.data.globals.count ?? 0)+1 } },artifacts:[{title:node.id,content:"test"}] }); });
  const run = rt.start(w.id,{goal:"测试"},{}); await rt.jobs.get(run.id);
  const saved = db.get("runs",run.id); assert.equal(saved.status,"complete"); assert.deepEqual(calls,["a","yes","join"]); assert.equal(saved.nodeStates.no,"skipped");
  assert.equal(saved.data.globals.count,3); assert.equal(saved.records.length,3); assert.equal(saved.data.artifacts.length,3); assert.equal(saved.records[0].response.rawOutput,"model-response");
  calls.length = 0; const second = rt.start(w.id,{goal:"再次"},{}); await rt.jobs.get(second.id); assert.equal(db.get("runs",second.id).data.globals.count,6);
});

test("packed skills preserve internal output references and run snapshots survive undo", async (t) => {
  const { db } = await fixture(t); const d = definition(); d.nodes[1].arguments = { previous:"{{outputs.first}}" };
  const w = db.save(d), packed = db.pack(w.id,w.revision,["first","second"],"处理");
  const seen = []; const rt = new WorkflowRuntime(db,async ({node}) => { seen.push(node); return outcome(); });
  const run = rt.start(w.id,{},{}); await rt.jobs.get(run.id);
  assert.equal(seen[1].arguments.previous,"ok");
  db.undoPack(w.id,packed.revision); assert.equal(Object.keys(db.get("runs",run.id).skills).length,1);
});

test("failed and cancelled runs retain evidence and do not dispatch downstream work", async (t) => {
  const { db } = await fixture(t); const w = db.save(definition());
  let calls = 0; const rt = new WorkflowRuntime(db,async () => { calls++; return outcome({status:"failure",error:"tool unavailable"}); });
  const run = rt.start(w.id,{},{}); assert.throws(() => rt.start(w.id,{},{}),/正在运行/); await rt.jobs.get(run.id);
  assert.equal(calls,1); assert.equal(db.get("runs",run.id).status,"failed"); assert.equal(db.get("runs",run.id).records[0].response.result.error,"tool unavailable");
  const rt2 = new WorkflowRuntime(db,async (_,__,signal) => new Promise((resolve,reject) => signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true})));
  const cancelled = rt2.start(w.id,{},{}); rt2.stop(cancelled.id); await rt2.jobs.get(cancelled.id); assert.equal(db.get("runs",cancelled.id).status,"cancelled");
});

test("restart marks unfinished work interrupted without replay", async (t) => {
  const { db, file } = await fixture(t); db.put("runs",{id:"interrupted",status:"running",records:[{title:"written"}]});
  const restarted = new WorkflowLibrary(file); assert.equal(restarted.get("runs","interrupted").status,"interrupted"); assert.equal(restarted.get("runs","interrupted").records.length,1); restarted.close();
});

test("custom workflow request kinds route through configured model roles", () => {
  assert.equal(resolveModelRoute({kind:"custom_workflow_generate",agentRole:"planner"},{smartRouting:false}).role,"planner");
  assert.equal(resolveModelRoute({kind:"custom_workflow_execute",agentRole:"executor"},{smartRouting:false}).role,"executor");
});

test("API requires token, saves generated nodes, triggers a run and serves durable history", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(),"wf-api-"));
  let generatedInput;
  let generatedNodes = [{...tool("a"),tool:"exec_command"},{...tool("b"),tool:"exec_command", arguments:{previous:"{{outputs.a}}"}}];
  const server = await startServer({ port:0, dataDirectory:dir, workspace:path.join(dir,"workspace"), listCodexTools:async () => [{ name:"exec_command", title:"Command", description:"Run", arguments:{type:"object"}, source:"codex-core", binding:{kind:"codex-core",name:"exec_command"}, available:true }], generateWorkflowNodesWithHarness:async (input) => { generatedInput = input; return {nodes:generatedNodes}; }, executeWorkflowNodeWithHarness:async () => outcome() });
  t.after(async () => { await new Promise((r)=>server.server.close(r)); await rm(dir,{recursive:true,force:true}); });
  const request = async (route,body,token = server.token) => { const r = await fetch(`${server.url}/api/workflow-library${route}`,body === undefined ? {} : {method:"POST",headers:{"Content-Type":"application/json","X-LoopCanvas-Token":token},body:JSON.stringify(body)}); return {status:r.status,...await r.json()}; };
  assert.equal((await request("/save",definition(),"wrong")).status,403);
  const tools = await request("/tools"); assert.equal(tools.tools[0].name,"local_media_transcribe");
  const generated = await request("/generate",{prompt:"读后总结"}); assert.equal(generated.nodes.length,2); assert.notEqual(generated.nodes[0].id,"a"); assert.equal(generated.nodes[1].arguments.previous,`{{outputs.${generated.nodes[0].id}}}`);
  assert.deepEqual(generated.nodes[0].toolBinding,{kind:"codex-core",name:"exec_command"});
  assert.equal(generatedInput.tools[0].name,"local_media_transcribe");
  generatedNodes = [{...tool("bad"),tool:"exec_command",arguments:{inputPath:"{{globals.inputVideoPath}}"}}];
  assert.match((await request("/generate",{prompt:"转写视频"})).error,/未初始化/);
  generatedNodes = [{...tool("bad"),tool:"exec_command",arguments:{workdir:"/tmp/loopcanvas-readonly-mode-stale"}}];
  assert.match((await request("/generate",{prompt:"读取文件"})).error,/临时工作目录|固定工作目录/);
  generatedNodes = [{...tool("a"),tool:"exec_command"},{...tool("b"),tool:"exec_command", arguments:{previous:"{{outputs.a}}"}}];
  const skillDir = path.join(dir,"workspace",".agents","skills","local-test");
  await mkdir(skillDir,{recursive:true}); await writeFile(path.join(skillDir,"SKILL.md"),"---\nname: local-test\ndescription: test\n---\nRead the input.");
  const available = await request("/available-skills");
  const source = available.skills.find((s)=>s.name === "local-test"); assert.ok(source);
  const imported = await request("/import-skill",{id:source.id}); assert.equal(imported.skill.name,"local-test");
  assert.equal((await request("/import-skill",{id:"/etc/passwd"})).status,400);
  const saved = await request("/save",definition()); assert.ok(saved.workflow.id);
  const duplicated = await request(`/workflows/${saved.workflow.id}/duplicate`,{}); assert.equal(duplicated.workflow.name,"摘要 副本");
  assert.equal((await request(`/workflows/${duplicated.workflow.id}/delete`,{revision:0})).status,400);
  assert.equal((await request(`/workflows/${duplicated.workflow.id}/delete`,{revision:duplicated.workflow.revision})).deleted,true);
  assert.equal((await request("")).workflows.some((workflow)=>workflow.id === duplicated.workflow.id),false);
  const triggered = await request("/trigger",{prompt:"用摘要工作流完成测试"}); assert.equal(triggered.matched,true);
  await server.workflowRuntime.jobs.get(triggered.run.id);
  const read = await request(`/runs/${triggered.run.id}`); assert.equal(read.run.status,"complete"); assert.equal((await request("")).runs.length,1);
  assert.equal((await request("/trigger",{prompt:"用不存在工作流完成测试"})).status,400);
});

test("API builds the complete media pipeline without asking the planning model to rediscover tools", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wf-media-api-"));
  const server = await startServer({ port: 0, dataDirectory: dir, workspace: path.join(dir, "workspace"), listCodexTools: async () => [] });
  t.after(async () => { await new Promise((resolve) => server.server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(`${server.url}/api/workflow-library/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": server.token },
    body: JSON.stringify({ prompt: "识别每一句完整捧哏，生成关键词并按句分割音频" })
  });
  const generated = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(generated.nodes.map((node) => node.tool), ["local_media_transcribe", "agent_transcript_analyze", "local_media_clip"]);
  assert.equal(generated.nodes[1].arguments.transcript, `{{outputs.${generated.nodes[0].id}}}`);
  assert.equal(generated.nodes[2].arguments.clips, `{{outputs.${generated.nodes[1].id}.candidates}}`);
});

test("media import requires token, streams bytes locally and hands the imported path to a run", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wf-media-import-"));
  let receivedPath;
  const server = await startServer({ port: 0, dataDirectory: dir, workspace: path.join(dir, "workspace"), listCodexTools: async () => [], executeWorkflowNodeWithHarness: async (input) => { receivedPath = input.node.arguments.inputPath; return outcome(); } });
  t.after(async () => { await new Promise((resolve) => server.server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const headers = { "X-LoopCanvas-Token": server.token, "Content-Type": "application/octet-stream", "X-Workflow-Filename": encodeURIComponent("../视频.mp4") };
  const bytes = Buffer.alloc(1_100_000, 7);
  const upload = (body, override = {}) => fetch(`${server.url}/api/workflow-library/media`, { method: "POST", headers: { ...headers, ...override }, body });
  assert.equal((await upload("x", { "X-LoopCanvas-Token": "bad" })).status, 403);
  assert.equal((await upload("x", { "X-Workflow-Filename": "file.html" })).status, 400);
  assert.equal((await upload("")).status, 400);
  assert.deepEqual(await readdir(path.join(dir, "workflow-media")), []);
  const response = await upload(bytes);
  assert.equal(response.status, 200);
  const { media } = await response.json();
  assert.equal(media.name, "视频.mp4");
  assert.equal(path.dirname(media.path), path.join(dir, "workflow-media"));
  assert.deepEqual(await readFile(media.path), bytes);
  const workflow = server.workflowLibrary.save({ name: "导入测试", triggers: ["click", "drag"], nodes: [{ ...tool("media"), arguments: { inputPath: "{{input.goal}}" } }], edges: [] });
  const run = server.workflowRuntime.start(workflow.id, { goal: media.path, trigger: "drag" }, {});
  await server.workflowRuntime.jobs.get(run.id);
  assert.equal(receivedPath, await realpath(media.path));
  assert.equal(server.workflowLibrary.get("runs", run.id).status, "complete");
});

test("media workflows reject missing input before persisting a failed run, including packed skills", async (t) => {
  const { db } = await fixture(t);
  const runtime = new WorkflowRuntime(db, async () => outcome());
  let workflow = db.save({ name: "媒体", triggers: ["click", "drag"], nodes: [{ ...tool("media"), tool: "local_media_transcribe", arguments: { inputPath: "{{input.goal}}" } }, tool("next")], edges: [{ from: "media", to: "next", when: "always" }] });
  assert.throws(() => runtime.start(workflow.id, { trigger: "drag" }, {}), /输入检查未通过/);
  workflow = db.pack(workflow.id, workflow.revision, ["media", "next"], "媒体 Skill");
  assert.throws(() => runtime.start(workflow.id, {}, {}), /输入检查未通过/);
  assert.equal(db.catalog().runs.length, 0);
});
