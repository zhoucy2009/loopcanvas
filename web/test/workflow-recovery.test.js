import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowLibrary, WorkflowRuntime } from "../src/workflow-library.js";
import { reviewedVideoCompositionPlan } from "../public/workflow-media-model.js";
import { validateWorkflow, topologicalNodes } from "../public/workflow-model.js";
import { failureRecovery, reviewResponseSchema } from "../src/workflow-response.js";
import { startServer } from "../src/server.js";

const success = (output = {}) => ({ result: { status: "success", output, evidence: ["fixture"], artifacts: [{ title: "kept", content: "record" }] } });
const tool = (id, name = "agent_transcript_analyze") => ({ id, title: id, type: "tool", tool: name, arguments: {} });
const graph = (nodes) => ({ name: "审核恢复测试", inputs: [], nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, when: "always" })), triggers: ["click"] });
async function fixture(t, execute) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wf-recovery-"));
  const db = new WorkflowLibrary(path.join(dir, "workflows.sqlite"));
  const runtime = new WorkflowRuntime(db, execute);
  t.after(async () => { await runtime.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  const start = async (definition) => { const w = db.save(definition); const r = runtime.start(w.id, {}, { workspace: dir }); await runtime.jobs.get(r.id); return db.get("runs", r.id); };
  const submit = (run, data = {}) => runtime.resume(run.id, { workspace: dir }, { token: run.pending?.token ?? runtime.recovery(run)?.token, note: "实际核对测试数据", confirmed: true, decision: "approve", ...data });
  return { dir, db, runtime, start, submit };
}

test("missing evidence pauses durably; validated supplement resumes only the analysis and retains artifacts", async (t) => {
  const calls = [];
  const f = await fixture(t, async ({ node }) => {
    calls.push(node.id);
    if (node.id === "analyze" && !node.arguments.userEvidence.length) return { result: { status: "needs_input", error: "请补充说话人标注" } };
    if (node.id === "analyze") { assert.equal(node.arguments.userEvidence[0].provenance, "user-confirmed"); assert.equal(node.arguments.userEvidence[0].attachments[0].content, "人工来源"); }
    return success();
  });
  const run = await f.start(graph([tool("written", "write_file"), tool("analyze"), tool("deliver", "write_file")]));
  assert.equal(run.status, "waiting_input"); assert.equal(f.runtime.canResume(run), false);
  assert.equal(run.nodeStates.written, "complete"); assert.equal(run.nodeStates.deliver, undefined);
  assert.throws(() => f.runtime.resume(run.id, { workspace: f.dir }), /先补充/);
  assert.throws(() => f.submit(run, { confirmed: false }), /明确确认/);
  assert.throws(() => f.submit(run, { token: "stale" }), /状态已变化/);
  assert.throws(() => f.submit(run, { files: [path.join(f.dir, "missing.txt")] }));
  const reopened = new WorkflowLibrary(path.join(f.dir, "workflows.sqlite"));
  assert.equal(reopened.get("runs", run.id).pending.token, run.pending.token); reopened.close();
  const file = path.join(f.dir, "proof.txt"); await writeFile(file, "人工来源");
  f.submit(run, { files: [file] });
  assert.throws(() => f.submit(run), /只有失败/);
  await f.runtime.jobs.get(run.id);
  const done = f.db.get("runs", run.id);
  assert.equal(done.status, "complete"); assert.deepEqual(calls, ["written", "analyze", "analyze", "deliver"]);
  assert.equal(done.records[1].status, "waiting_input");
  assert.equal(done.data.artifacts[0].content, "record");
  assert.equal(done.data.context.userEvidence.length, 1);
});

test("human approval never calls the model, rejects stale submission, and rejection stops downstream", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return success(); });
  const def = graph([{ id: "human", type: "approval", title: "人工验收", instructions: "检查真实来源" }, tool("later")]);
  const run = await f.start(def);
  assert.equal(calls, 0); assert.equal(run.pending.mode, "approval");
  f.submit(run, { decision: "reject", note: "请补充来源，当前证据不符" });
  assert.equal(f.runtime.recovery(f.db.get("runs", run.id)).kind, "blocked");
  assert.throws(() => f.submit(run)); assert.equal(calls, 0);
  const second = await f.start({ ...def, name: "通过验收" });
  f.submit(second); await f.runtime.jobs.get(second.id);
  const done = f.db.get("runs", second.id);
  assert.equal(done.status, "complete"); assert.equal(done.data.outputs.human.approved, true); assert.equal(calls, 1);
});

test("review success without approved, complete checks and concrete evidence never reaches delivery", async (t) => {
  for (const output of [{ approved: false, checks: [] }, { approved: true, checks: [] }, { approved: true, checks: [{ passed: false, evidence: "bad" }] }, { approved: true, checks: [{ passed: true, evidence: "" }] }]) {
    const calls = [];
    const f = await fixture(t, async ({ node }) => { calls.push(node.id); return success(output); });
    const run = await f.start(graph([{ id: "review", type: "review", title: "独立审核", instructions: "逐项核对来源和完整语义" }, tool("deliver", "write_file")]));
    assert.equal(run.status, "failed"); assert.deepEqual(calls, ["review"]); assert.equal(f.runtime.canResume(run), false);
  }
  assert.deepEqual(reviewResponseSchema("r").properties.output.required, ["approved", "checks"]);
});

test("legacy missing-speaker records offer evidence instead of blind retry; unknown failures stay blocked", () => {
  assert.equal(failureRecovery("请补充说话人确认后重试"), "needs_input");
  assert.equal(failureRecovery("没有合适匹配"), "blocked");
  assert.equal(failureRecovery("malformed JSON"), "retry");
});

test("new media plans preserve all requirements and include real speaker, review and delivery gates", () => {
  const requirements = "于谦片段插入主视频，只要 3 到 5 处，间隔 15 秒；不确定时暂停；独立审核";
  const plan = reviewedVideoCompositionPlan(requirements);
  const w = validateWorkflow({ ...graph(plan.nodes), inputs: undefined });
  assert.equal(w.inputs.length, 2);
  assert.equal(plan.nodes.find((n) => n.id === "speaker_evidence").type, "approval");
  assert.equal(plan.nodes.find((n) => n.id === "plan_review").type, "review");
  assert.equal(plan.nodes.at(-1).type, "approval");
  assert.match(plan.nodes.find((n) => n.id === "source_analyze").arguments.criteria, /3 到 5/);
  assert.match(plan.nodes.find((n) => n.id === "target_analyze").arguments.criteria, /间隔 15 秒/);
  assert.ok(plan.warnings.some((w) => w.includes("人工")));
  assert.ok(topologicalNodes(w).findIndex((n) => n.type === "review") < topologicalNodes(w).findIndex((n) => n.id === "compose"));
});

test("HTTP evidence requires token and challenge, enriches resume artifacts, and scopes input previews", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wf-evidence-api-"));
  const input = path.join(dir, "input.txt"); await writeFile(input, "registered input");
  const server = await startServer({ port: 0, dataDirectory: dir, workspace: path.join(dir, "workspace"), listCodexTools: async () => [], executeWorkflowNodeWithHarness: async () => success() });
  t.after(async () => { await server.workflowRuntime.close(); await new Promise((r) => server.server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const request = async (route, body, token = server.token) => {
    const response = await fetch(`${server.url}/api/workflow-library${route}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": token }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const w = server.workflowLibrary.save({ ...graph([tool("write", "test_write"), { id: "approval", title: "人工确认", type: "approval", instructions: "核验文件" }, tool("read")]), inputs: [{ key: "source", label: "来源", type: "file" }] });
  const started = await request(`/workflows/${w.id}/run`, { inputs: { source: input } });
  await server.workflowRuntime.jobs.get(started.body.run.id);
  const run = (await request(`/runs/${started.body.run.id}`)).body.run;
  assert.ok(run.artifacts[0].downloadUrl);
  const endpoint = `/runs/${run.id}/evidence`;
  const submission = { token: run.recovery.token, decision: "approve", confirmed: true, note: "核验通过" };
  assert.equal((await request(endpoint, submission, "expired")).body.code, "SESSION_TOKEN_EXPIRED");
  assert.equal((await request(endpoint, { ...submission, token: "stale" })).status, 400);
  const resumed = await request(endpoint, submission);
  assert.ok(resumed.body.run.artifacts[0].downloadUrl); assert.equal(resumed.status, 200);
  await server.workflowRuntime.jobs.get(run.id);
  assert.equal((await request(endpoint, submission)).status, 400);
  assert.equal(await fetch(`${server.url}/api/workflow-library/runs/${run.id}/inputs/source`).then((r) => r.text()), "registered input");
  assert.equal((await request(`/runs/${run.id}/inputs/unknown`)).status, 400);
});

test("valid independent review passes its verdict downstream without accepting global mutations", async (t) => {
  const calls = [];
  const f = await fixture(t, async ({ node }) => {
    calls.push(node.id);
    if (node.type === "review") { const result = success({ approved: true, checks: [{ criterion: "真实来源", passed: true, evidence: "已核对上游记录" }] }); result.result.statePatch = { globals: { forged: true }, context: { forged: true } }; return result; }
    assert.equal(node.arguments.verdict.approved, true);
    return success();
  });
  const run = await f.start(graph([{ id: "review", type: "review", title: "审核", instructions: "核对真实来源" }, { ...tool("deliver", "write_file"), arguments: { verdict: "{{outputs.review}}" } }]));
  assert.equal(run.status, "complete"); assert.deepEqual(calls, ["review", "deliver"]);
  assert.equal(run.data.globals.forged, undefined); assert.equal(run.data.context.forged, undefined);
  assert.equal(run.data.artifacts.filter((artifact) => artifact.title === "独立审核报告").length, 1);
});
