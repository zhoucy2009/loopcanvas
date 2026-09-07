import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, chmod, symlink, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowLibrary, WorkflowRuntime } from "../src/workflow-library.js";
import { checkWorkflowInputs } from "../src/workflow-inputs.js";
import { bindNodeInput, mergeInputs, workflowInputs } from "../public/workflow-inputs.js";
import { validateWorkflow } from "../public/workflow-model.js";
import { copyGraphSelection, pasteGraphSelection } from "../public/workflow-library-ui.js";
import { startServer } from "../src/server.js";
const definitions = [{ key: "input1", label: "数据表", type: "file" }, { key: "input2", label: "参考文档", type: "file" }, { key: "input3", label: "素材目录", type: "directory" }];
const node = (id) => ({ id, type: "tool", title: id, tool: "test_tool", arguments: { data: "{{input.input1}}", reference: "{{input.input2}}", directory: "{{input.input3}}" } });
const graph = () => ({ name: "通用多输入", inputs: definitions, nodes: [node("first"), node("second")], edges: [{ from: "first", to: "second", when: "always" }], triggers: ["click", "drag", "prompt"] });
const success = { result: { status: "success", output: "ok" } };
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workflow-inputs-")));
  const values = { input1: path.join(root, "数据.csv"), input2: path.join(root, "文档.txt"), input3: path.join(root, "素材") };
  await writeFile(values.input1, "a,b\n1,2"); await writeFile(values.input2, "reference"); await mkdir(values.input3);
  const library = new WorkflowLibrary(path.join(root, "workflows.sqlite"));
  t.after(async () => { library.close(); await rm(root, { recursive: true, force: true }); });
  return { root, values, library };
}

test("declarations survive save, rename, copy, pack and undo; dangling references cannot be saved", async (t) => {
  const { library } = await fixture(t);
  const original = library.save(graph());
  const renamed = library.save({ ...original, inputs: original.inputs.map((input) => ({ ...input, label: input.label + "新版" })) });
  assert.equal(renamed.revision, 2);
  assert.equal(library.save(renamed).revision, 2);
  const packed = library.pack(renamed.id, renamed.revision, ["first", "second"], "多输入 Skill");
  assert.deepEqual(library.catalog().skills[0].inputs, renamed.inputs);
  assert.throws(() => library.save({ ...packed, inputs: [] }), /未声明/);
  const duplicate = library.duplicate(packed.id);
  assert.deepEqual(duplicate.inputs, renamed.inputs);
  library.remove(duplicate.id, duplicate.revision);
  assert.deepEqual(library.undoPack(packed.id, packed.revision).inputs, renamed.inputs);
  const selection = pasteGraphSelection(copyGraphSelection(renamed, ["first", "second"]));
  assert.deepEqual(selection.inputs, renamed.inputs);
  assert.throws(() => mergeInputs(definitions, [{ ...definitions[0], type: "video" }]), /冲突/);
  assert.throws(() => validateWorkflow({ ...graph(), inputs: [{ ...definitions[0], key: "constructor" }] }), /无效/);
  assert.throws(() => validateWorkflow({ ...graph(), inputs: [] }), /未声明/);
  assert.deepEqual(bindNodeInput({ arguments: { preserve: 1 } }, "options.source", "input2"), { preserve: 1, options: { source: "{{input.input2}}" } });
  assert.throws(() => bindNodeInput({}, "constructor.prototype", "input1"), /安全/);
});

test("preflight lists every missing or inaccessible input and enforces type, permissions and canonical paths", async (t) => {
  const { root, values } = await fixture(t);
  assert.equal(checkWorkflowInputs(graph(), {}).checks.filter((input) => !input.ok).length, 3);
  for (const bad of ["relative.csv", "https://example.com/file.csv", path.join(root, "missing"), values.input3]) {
    assert.equal(checkWorkflowInputs(graph(), { ...values, input1: bad }).checks[0].ok, false);
  }
  assert.equal(checkWorkflowInputs(graph(), { ...values, input3: values.input1 }).ok, false);
  await chmod(values.input2, 0);
  assert.equal(checkWorkflowInputs(graph(), values).checks[1].ok, false);
  await chmod(values.input2, 0o600);
  const alias = path.join(root, "alias.txt"); await symlink(values.input2, alias);
  assert.equal(checkWorkflowInputs(graph(), { ...values, input2: alias }).values.input2, values.input2);
  assert.equal(checkWorkflowInputs({ ...graph(), inputs: definitions.map((input, index) => index === 0 ? { ...input, type: "video" } : input) }, values).ok, false);
});

test("all triggers block before records or tool calls; changed paths stop downstream tools including packed skills", async (t) => {
  const { root, values, library } = await fixture(t);
  let workflow = library.save(graph());
  let calls = 0;
  const runtime = new WorkflowRuntime(library, async ({ node, run }) => {
    calls++;
    assert.equal(node.arguments.reference, values.input2);
    assert.equal(run.data.input.input3, values.input3);
    await rm(values.input2);
    return success;
  });
  for (const trigger of ["click", "drag", "prompt"]) assert.throws(() => runtime.start(workflow.id, { inputs: { input1: values.input1 }, trigger }, { workspace: root }), /参考文档.*素材目录/);
  assert.equal(library.catalog().runs.length, 0); assert.equal(calls, 0);
  workflow = library.pack(workflow.id, workflow.revision, ["first", "second"], "需检查的 Skill");
  const run = runtime.start(workflow.id, { inputs: values }, { workspace: root });
  await runtime.jobs.get(run.id);
  const saved = library.get("runs", run.id);
  assert.equal(saved.status, "failed"); assert.equal(calls, 1); assert.match(saved.error, /参考文档.*不存在/);
  assert.equal(saved.records[0].status, "complete");
});

test("legacy file inputs are inferred without confusing task text with a path", () => {
  const media = { name: "旧媒体", nodes: [{ id: "old", title: "old", type: "tool", tool: "local_media_transcribe", arguments: { inputPath: "{{input.goal}}" } }], edges: [], triggers: ["click"] };
  assert.equal(workflowInputs(media)[0].key, "goal");
  assert.equal(validateWorkflow(media).inputs[0].type, "file");
  assert.throws(() => validateWorkflow({ ...media, inputs: [] }), /任务说明/);
  assert.deepEqual(workflowInputs({ nodes: [{ arguments: { prompt: "{{input.goal}}" } }] }), []);
});

test("generic upload, generated declarations, preflight and prompt handoff use the same API contract", async (t) => {
  const { root, values } = await fixture(t);
  let received;
  const server = await startServer({ port: 0, dataDirectory: path.join(root, "api"), workspace: root, listCodexTools: async () => [{ name: "test_tool", available: true }], generateWorkflowNodesWithHarness: async (input) => { received = input; return { inputs: definitions, nodes: [node("generated")] }; }, executeWorkflowNodeWithHarness: async () => success });
  t.after(async () => { await new Promise((resolve) => server.server.close(resolve)); });
  const request = async (route, body) => {
    const response = await fetch(server.url + "/api/workflow-library" + route, { method: "POST", headers: { "Content-Type": "application/json", "X-LoopCanvas-Token": server.token }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const generated = await request("/generate", { prompt: "比较输入1和输入2，使用输入3的参考素材", inputs: definitions });
  assert.equal(generated.status, 200); assert.deepEqual(received.inputs, definitions); assert.deepEqual(generated.inputs, definitions);
  const { workflow } = await request("/save", graph());
  const upload = await fetch(server.url + "/api/workflow-library/inputs/upload", { method: "POST", headers: { "X-LoopCanvas-Token": server.token, "X-Workflow-Filename": encodeURIComponent("数据.csv") }, body: "name,value\na,1" });
  assert.equal(upload.status, 200);
  const { file } = await upload.json(); assert.equal(await readFile(file.path, "utf8"), "name,value\na,1");
  const needs = await request("/trigger", { prompt: `用${workflow.name}工作流完成比较` });
  assert.equal(needs.needsInputs, true); assert.equal(needs.preflight.checks.length, 3); assert.equal(server.workflowLibrary.catalog().runs.length, 0);
  const checked = await request(`/workflows/${workflow.id}/preflight`, { inputs: { ...values, input1: file.path } });
  assert.equal(checked.ok, true);
  const started = await request("/trigger", { prompt: `用${workflow.name}工作流完成比较`, inputs: { ...values, input1: file.path } });
  await server.workflowRuntime.jobs.get(started.run.id);
  assert.equal(server.workflowLibrary.get("runs", started.run.id).status, "complete");
  assert.equal(server.workflowLibrary.get("runs", started.run.id).data.input.input1, file.path);
});
