import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowLibraryUI } from "../public/workflow-library-ui.js";

const workflow = () => ({ id: "template", name: "整理资料", revision: 1, inputs: [{ key: "input1", label: "资料", type: "file" }], inputDefaults: { input1: "/template/default.txt" }, nodes: [{ id: "read", title: "读取", type: "tool", tool: "read", arguments: { path: "{{input.input1}}" } }], edges: [], triggers: ["click", "drag", "prompt"] });
function fixture(t, api = async () => ({})) {
  const views = [];
  const ui = new WorkflowLibraryUI({ api, toast() {}, open(view) { views.push(view); } });
  ui.root = { isConnected: false, querySelector() { return null; } };
  ui.catalog = { workflows: [workflow()], skills: [], runs: [] };
  t.after(() => clearInterval(ui.timer));
  return { ui, views };
}

test("new workflow always opens a fresh editable draft after a dirty unsaved draft", (t) => {
  const { ui } = fixture(t);
  ui.newDraft(); ui.draft.name = "旧草稿"; ui.draft._dirty = true; ui.draft.nodes.push(workflow().nodes[0]);
  ui.prompt = "旧规划"; ui.inputValues = { input1: "/old.txt" }; ui.run = { id: "old-run" };
  ui.newDraft();
  assert.equal(ui.draft.name, "新工作流"); assert.deepEqual(ui.draft.nodes, []); assert.deepEqual(ui.draft.inputs, []);
  assert.deepEqual(ui.inputValues, {}); assert.equal(ui.prompt, ""); assert.equal(ui.run, null);
});

test("drag and click prepare distinct requests and never dispatch tools or reuse the last request inputs", async (t) => {
  const calls = [];
  const { ui, views } = fixture(t, async (route) => { calls.push(route); return {}; });
  ui.select(workflow()); ui.inputValues.input1 = "/previous-run/file.txt"; ui.goal = "旧需求"; ui.run = { id: "last-run" };
  await ui.prepareRun("template", "drag");
  const first = ui.executionId;
  assert.equal(ui.view, "execution"); assert.equal(ui.pendingTrigger, "drag"); assert.equal(ui.run, null); assert.equal(ui.goal, "");
  assert.deepEqual(ui.inputValues, { input1: "/template/default.txt" });
  ui.inputValues.input1 = "/current/file.txt"; ui.goal = "第一次需求";
  await ui.prepareRun("template", "click");
  assert.notEqual(ui.executionId, first); assert.equal(ui.goal, ""); assert.equal(ui.inputValues.input1, "/template/default.txt");
  assert.deepEqual(calls, []); assert.deepEqual(views, ["execution", "execution"]);
});

test("a prepared request dispatches once, records its own inputs, and requires a new request for another run", async (t) => {
  let runCount = 0, body;
  const saved = { id: "run1", workflowId: "template", workflow: workflow(), status: "complete", data: { input: {} }, artifacts: [], records: [], nodeStates: {} };
  const { ui } = fixture(t, async (route, options) => {
    if (route.endsWith("/preflight")) return { ok: true, checks: [] };
    if (route.endsWith("/run")) { runCount++; body = JSON.parse(options.body); return { run: saved }; }
    if (route.endsWith("/runs/run1")) return { run: saved };
    return { workflows: [workflow()], skills: [], runs: [saved] };
  });
  await ui.prepareRun("template", "click"); ui.inputValues.input1 = "/this/run.txt"; ui.goal = "本次独立需求";
  await Promise.all([ui.start("template"), ui.start("template")]);
  assert.equal(runCount, 1); assert.equal(body.goal, "本次独立需求"); assert.equal(body.inputs.input1, "/this/run.txt");
  await assert.rejects(ui.start("template"), /新需求/);
  await ui.prepareRun("template"); assert.equal(ui.run, null); assert.equal(ui.goal, "");
});

test("prompt preparation opens the execution form even when the server could use default inputs", async (t) => {
  const calls = [];
  const { ui } = fixture(t, async (route, options) => {
    calls.push({ route, body: JSON.parse(options.body) });
    return { matched: true, prepared: true, workflowId: "template", goal: "这次做摘要" };
  });
  assert.equal(await ui.triggerPrompt("用整理资料工作流完成这次做摘要"), true);
  assert.equal(calls[0].body.prepareOnly, true); assert.equal(ui.goal, "这次做摘要"); assert.equal(ui.view, "execution"); assert.equal(ui.pendingTrigger, "prompt"); assert.equal(ui.run, null);
});

test("slow background tool discovery does not replace an opened run", async (t) => {
  let completeTools;
  const { ui } = fixture(t, async (route) => route.endsWith("/tools") ? new Promise((resolve) => { completeTools = resolve; }) : { workflows: [workflow()], skills: [], runs: [] });
  let renders = 0; ui.render = () => renders++;
  const loading = ui.load();
  await new Promise(setImmediate);
  ui.view = "execution"; ui.run = { id: "opened" };
  const before = renders;
  completeTools({ tools: [] }); await loading;
  assert.equal(renders, before); assert.equal(ui.run.id, "opened");
});

test("an empty rebuilt run panel renders history even when there is no selected run", (t) => {
  const { ui } = fixture(t);
  const panel = { childElementCount: 0, dataset: {}, innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
  ui.root.querySelector = () => panel;
  ui.runFingerprint = JSON.stringify([null, ui.catalog.runs]);
  ui.renderRun();
  assert.match(panel.innerHTML, /历史运行/);
});
