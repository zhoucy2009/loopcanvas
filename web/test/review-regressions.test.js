import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { executeWithHarness, finalReviewWithHarness, planWithHarness, reviewStepWithHarness, normalizeExecutionResponse } from "../src/harness.js";
import { applyAdaptiveRoute, returnVerificationToRepair } from "../src/store.js";
import { startServer } from "../src/server.js";

test("实际请求构造：执行、步骤审核和最终审核继承同一交付契约", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-handoff-"));
  try {
    const codexPath = path.join(directory, "fake-codex");
    await writeFile(codexPath, `#!${process.execPath}
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line); if(message.id==null)return;
  if(message.method==='thread/start')return send({id:message.id,result:{thread:{id:'fixture'}}});
  if(message.method==='model/list')return send({id:message.id,result:{data:['gpt-5.6-sol','gpt-5.6-luna','gpt-5.6-terra'].map(model=>({model,supportedReasoningEfforts:['low','high','xhigh'].map(reasoningEffort=>({reasoningEffort}))}))}});
  send({id:message.id,result:{}});
  if(message.method!=='turn/start')return;
  const r=JSON.parse(message.params.input[0].text.split('\\n').at(-1));
  let response={requestID:r.id,status:'success'};
  if(r.kind==='route_project')Object.assign(response,{executionShape:'graph',primaryArtifact:{title:'slides',kind:'html',filename:'slides.html',acceptanceCriteria:['8页']},steps:[{id:'build',title:'制作',kind:'build',dependencies:[]}]});
  else if(r.kind.startsWith('review_'))Object.assign(response,{verdict:'pass',summary:'已独立复查',verifiedEvidence:['磁盘核验'],acceptanceResults:(r.acceptanceCriteria||[]).map(criterion=>({criterion,passed:true,evidence:'已核验'}))});
  else response.result={summary:'完成当前节点',evidence:['已核验'],verificationPassed:true,blockingIssues:[],artifact:{kind:'html',filename:'slides.html',content:'<main>8页</main>',previewViewport:{width:1600,height:900}}};
  send({method:'item/completed',params:{item:{type:'agentMessage',phase:'final',text:JSON.stringify(response)}}});
  send({method:'turn/completed',params:{turn:{status:'completed'}}});
});
`);
    await chmod(codexPath, 0o755);
    const project = { id: "handoff", workspace: directory, goal: "8页中文演示", directives: [{ text: "必须16:9" }], primaryArtifact: { kind: "html", filename: "slides.html", acceptanceCriteria: ["8页"] }, context: [{ kind: "decision", stepId: "choose", content: "只交本地PPTX" }], steps: [
      { id: "choose", kind: "decision", status: "approved", dependencies: [], directionAnswer: "只交本地PPTX", result: { summary: "用户确认" } },
      { id: "build", kind: "build", status: "approved", dependencies: ["choose"], result: { summary: "8页已制作", evidence: ["8张预览"] } },
      { id: "verify", title: "核验", kind: "verify", status: "ready", dependencies: ["build"] }
    ] };
    const settings = { workspace: directory, codexPath, agentRuntime: "codex", smartRouting: true };
    const planned = await planWithHarness(project, settings);
    assert.doesNotMatch(planned.request.modelPolicy, /选择 single|禁止启动 Chrome/);
    const executed = await executeWithHarness(project, project.steps[2], settings);
    const reviewed = await reviewStepWithHarness({ project, step: project.steps[2], result: executed.result }, settings);
    const judged = await finalReviewWithHarness(project, settings);
    for (const { request } of [executed, reviewed, judged]) {
      assert.equal(request.primaryArtifact.filename, "slides.html");
      assert.equal(request.confirmedDirections[0].answer, "只交本地PPTX");
      assert.match(request.sharedContext, /只交本地PPTX/);
      assert.deepEqual(request.immutableRequirements.directives, project.directives);
    }
    assert.doesNotMatch(executed.request.modelPolicy, /选择 single|本次不得修改项目文件/);
    assert.deepEqual(executed.result.artifact.previewViewport, { width: 1600, height: 900 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("验证返修只回到传递依赖中的生产节点，不能误选无关分支", () => {
  const project = { id: "repair", context: [], decisionLog: [], agents: [], checkpoints: [], executionMode: "adaptive-graph", phase: "workspace", steps: [] };
  applyAdaptiveRoute(project, { executionShape: "graph", primaryArtifact: { kind: "html", filename: "index.html" }, steps: [
    { id: "build", kind: "build", dependencies: [] }, { id: "analyze", kind: "analyze", dependencies: ["build"] },
    { id: "other", kind: "build", dependencies: [] }, { id: "verify", kind: "verify", dependencies: ["analyze"] }
  ] });
  project.steps.forEach(step => step.status = step.id === "verify" ? "error" : "approved");
  project.steps[3].result = { verificationPassed: false, blockingIssues: ["文字溢出"] };
  returnVerificationToRepair(project, "verify");
  assert.equal(project.selectedStepId, "build");
  assert.equal(project.steps[2].status, "approved");
  assert.match(project.steps[0].lastFeedback, /文字溢出/);
});

test("并行节点失败等待同批结束，保存成功兄弟且释放锁后可只重试失败节点", { timeout: 8000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-parallel-failure-"));
  let releaseSlow, slowStarted;
  const started = new Promise(resolve => { slowStarted = resolve; });
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const calls = [];
  const runtime = await startServer({ port: 0, dataDirectory: directory, workspace: path.join(directory, "workspace"), executeWithHarness: async (_project, step) => {
    calls.push(step.id);
    if (step.id === "fail") throw new Error("可恢复的失败");
    slowStarted(); await slow;
    return { request: { id: step.id }, rawOutput: "{}", result: { summary: "独立节点已完成", evidence: ["核验完成"], verificationPassed: true, blockingIssues: [], artifact: null } };
  } });
  try {
    const project = runtime.store.project((await runtime.store.createProject({ goal: "并行测试" })).id);
    await runtime.store.mutate(() => applyAdaptiveRoute(project, { executionShape: "graph", primaryArtifact: { kind: "html", filename: "index.html" }, steps: [
      { id: "fail", title: "失败节点", kind: "build", dependencies: [], parallelSafe: true, writeScope: ["a.txt"] },
      { id: "slow", title: "成功节点", kind: "build", dependencies: [], parallelSafe: true, writeScope: ["b.txt"] },
      { id: "deliver", kind: "deliver", dependencies: ["fail", "slow"], writeScope: ["index.html"] }
    ] }));
    const { token } = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": token };
    let completed = false;
    const run = fetch(`${runtime.url}/api/projects/${project.id}/run`, { method: "POST", headers, body: '{"mode":"parallel"}' }).then(response => { completed = true; return response; });
    await Promise.race([started, run.then(async response => { throw new Error(`未启动并行节点：${await response.text()}`); })]);
    const live = await (await fetch(`${runtime.url}/api/projects/${project.id}/runtime`)).json();
    assert.equal(live.runtime.active, true); assert.equal(completed, false);
    releaseSlow(); assert.equal((await run).status, 400);
    assert.equal(project.steps.find(step => step.id === "slow").status, "approved");
    assert.equal(project.steps.find(step => step.id === "fail").status, "error");
    await fetch(`${runtime.url}/api/projects/${project.id}/run`, { method: "POST", headers, body: '{"mode":"sequential","stepId":"fail"}' });
    assert.deepEqual(calls, ["fail", "slow", "fail"]);
  } finally { releaseSlow(); await new Promise(resolve => runtime.server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test("失败回复缺少 error 仍展示摘要；无证据的 failure 不能伪装为可验收结果", () => {
  assert.throws(() => normalizeExecutionResponse({ status: "failure", assistantMessage: "权限不足" }, "x"), /权限不足/);
  assert.throws(() => normalizeExecutionResponse({ status: "failure", result: { verificationPassed: false, blockingIssues: ["工具不可用"] } }, "x", "", { stepKind: "verify" }), /工具不可用/);
});

for (const verdict of ["pass", "repair"]) test(`执行后审核连接失败保留产物，只重试审核不会再执行（${verdict}）`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-review-retry-"));
  let executions = 0, reviews = 0;
  const artifact = { title: "页面", kind: "html", filename: "index.html", content: "<main>已生成</main>" };
  const result = { summary: "已生成页面", evidence: ["磁盘核验"], verificationPassed: true, blockingIssues: [], artifact };
  const runtime = await startServer({ port: 0, dataDirectory: directory, workspace: path.join(directory, "workspace"),
    executeWithHarness: async () => {
      executions++;
      const error = new Error("独立审核连接中断");
      error.completedExecution = { result, request: { id: "executed", kind: "execute_step" }, rawOutput: JSON.stringify(result), reviewPending: true };
      throw error;
    },
    reviewStepWithHarness: async () => { reviews++; return { verdict, summary: verdict === "pass" ? "复核通过" : "修正排版", findings: [{ repairInstruction: "修正排版" }], verifiedEvidence: ["重新核验文件"], reviewedRevision: 1 }; }
  });
  try {
    const project = runtime.store.project((await runtime.store.createProject({ goal: "交付页面" })).id);
    await runtime.store.mutate(() => applyAdaptiveRoute(project, { executionShape: "graph", primaryArtifact: { kind: "html", filename: "index.html" }, steps: [{ id: "build", title: "制作", kind: "build", dependencies: [] }] }));
    const { token } = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": token };
    const run = await fetch(`${runtime.url}/api/projects/${project.id}/run`, { method: "POST", headers, body: '{"mode":"sequential"}' });
    assert.equal(run.status, 400);
    assert.equal(project.steps[0].reviewPending, true);
    assert.equal(project.steps[0].result.artifact.filename, "index.html");
    const review = await fetch(`${runtime.url}/api/projects/${project.id}/steps/build/agent-review`, { method: "POST", headers, body: "{}" });
    assert.equal(review.status, 200);
    assert.equal((await review.json()).state.projects.find(item => item.id === project.id).busy, false);
    assert.equal(project.steps[0].status, verdict === "pass" ? "approved" : "ready"); assert.equal(project.steps[0].reviewPending, false);
    if (verdict === "pass") assert.equal(project.artifact.filename, "index.html");
    else { assert.equal(project.steps[0].result, null); assert.match(project.steps[0].lastFeedback, /修正排版/); }
    assert.equal(project.lastError, null);
    assert.equal(executions, 1); assert.equal(reviews, 1);
  } finally { await new Promise(resolve => runtime.server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});
