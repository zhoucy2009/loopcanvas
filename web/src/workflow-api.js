import { scanCapabilities } from "./capabilities.js";
import { randomUUID } from "node:crypto";
import { importWorkflowMedia } from "./workflow-media.js";
import { artifactLinks, downloadArtifact, downloadWorkflowInput } from "./workflow-downloads.js";
import { hasTwoVideoIntent, isVideoComposition } from "../public/workflow-media-model.js";
import { matchWorkflowPrompt, validateWorkflow } from "../public/workflow-model.js";
import { workflowInputs, validateInputs, mergeInputs } from "../public/workflow-inputs.js";

function generatedNodeText(nodes) {
  return JSON.stringify(nodes);
}

function hasObjectKey(value, target) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasObjectKey(item, target));
  return Object.entries(value).some(([key, item]) => key === target || hasObjectKey(item, target));
}

function validateGeneratedNodes(nodes, tools) {
  const text = generatedNodeText(nodes);
  if (/\{\{\s*globals\./.test(text)) throw new Error("生成草稿引用了未初始化的全局变量；请使用 {{input.goal}} 接收本次任务。");
  if (/loopcanvas-readonly-mode-/i.test(text)) throw new Error("生成草稿包含会失效的临时工作目录，请重新生成。");
  for (const node of nodes) {
    if (["review", "approval", "condition", "output"].includes(node.type)) continue;
    if (hasObjectKey(node.arguments, "workdir")) throw new Error("生成草稿不能固定工作目录；运行时会分配可写目录。");
    const catalogTool = tools.find((tool) => tool.name === node.tool);
    if (!catalogTool) throw new Error(`工具“${node.tool}”不在当前同步目录中，请刷新工具后重新生成。`);
    if (!catalogTool.available) throw new Error(catalogTool.unavailableReason || `工具“${node.tool}”当前不可用。`);
  }
}

export function workflowAPI({ library, runtime, generate, dataDirectory, toolCatalog = async () => [], settings, readJSON, json }) {
  return async (request, response, url) => {
    if (!url.pathname.startsWith("/api/workflow-library")) return false;
    const route = url.pathname.slice("/api/workflow-library".length);
    const method = request.method;
    let payload, status = 200;
    try {
      const inputPreview = route.match(/^\/runs\/([\w-]+)\/inputs\/([\w-]+)$/);
      if (method === "GET" && inputPreview) { await downloadWorkflowInput(request, response, library.get("runs", inputPreview[1]), inputPreview[2]); return true; }
      const download = route.match(/^\/runs\/([\w-]+)\/artifacts\/(\d+)$/);
      if (method === "GET" && download) {
        await downloadArtifact(request, response, library.get("runs", download[1]), Number(download[2]), (await settings()).workspace); return true;
      }
      if (method === "GET" && !route) payload = library.catalog();
      else if (method === "POST" && route === "/media") payload = { media: await importWorkflowMedia(request, dataDirectory) };
      else if (method === "POST" && route === "/inputs/upload") payload = { file: await importWorkflowMedia(request, dataDirectory, true) };
      else if (method === "GET" && route === "/available-skills") payload = { skills: await scanCapabilities("skills", (await settings()).workspace) };
      else if (method === "GET" && route === "/tools") payload = { tools: await toolCatalog({ refresh: url.searchParams.get("refresh") === "1" }) };
      else if (method === "POST" && route === "/import-skill") {
        const body = await readJSON(request);
        const available = await scanCapabilities("skills", (await settings()).workspace);
        const source = available.find((s) => s.id === body.id);
        if (!source) throw new Error("本机 Skill 不存在，请刷新后重试。");
        const existing = library.catalog().skills.find((s) => s.sourcePath === source.path && s.detail === source.detail);
        const skill = existing ?? library.put("skills", { id: randomUUID(), name: source.name, description: "从本机 Skill 导入的快照", detail: source.detail, sourcePath: source.path, revision: 1, createdAt: new Date().toISOString(), nodes: [{ id: randomUUID(), type: "output", title: source.name, instructions: source.detail }] });
        payload = { skill };
      }
      else if (method === "POST" && route === "/save") payload = { workflow: library.save(await readJSON(request)) };
      else if (method === "POST" && route === "/generate") {
        const { prompt, inputs = [] } = await readJSON(request);
        validateInputs(inputs);
        if (!String(prompt ?? "").trim()) throw new Error("请描述要生成的工具调用。");
        const tools = await toolCatalog();
        const generated = await generate({ prompt: String(prompt).slice(0, 12000), tools, inputs }, await settings());
        const plannedInputs = mergeInputs(inputs, generated.inputs ?? workflowInputs({ nodes: generated.nodes }));
        validateGeneratedNodes(generated.nodes, tools);
        validateWorkflow({ name: "生成结果", inputs: plannedInputs, nodes: generated.nodes, edges: [], triggers: ["click"] });
        const ids = new Map(generated.nodes.map((n) => [n.id, randomUUID()]));
        const rekey = (value) => {
          if (typeof value === "string") return value.replace(/(\{\{\s*outputs\.)([\w-]+)(?=[.\s}])/g, (_, prefix, id) => `${prefix}${ids.get(id) ?? id}`);
          if (Array.isArray(value)) return value.map(rekey);
          if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,rekey(v)]));
          return value;
        };
        const nodes = generated.nodes.map((node, index) => {
          const catalogTool = tools.find((tool) => tool.name === node.tool);
          return { ...rekey(node), ...(catalogTool?.binding ? { toolBinding: structuredClone(catalogTool.binding), toolSource: catalogTool.source } : {}), id: ids.get(node.id), type: node.type || "tool", x: 40 + (index % 3) * 250, y: 40 + Math.floor(index / 3) * 140 };
        });
        validateWorkflow({ name: "工具草稿", inputs: plannedInputs, nodes, edges: [], triggers: ["click"] });
        payload = { inputs: plannedInputs, nodes, planning: { requirements: String(prompt), warnings: generated.warnings ?? [], capabilities: tools.map(({ name, available, unavailableReason }) => ({ name, available, unavailableReason })), checkedAt: new Date().toISOString() } };
      } else if (method === "POST" && route === "/trigger") {
        const body = await readJSON(request);
        const matched = matchWorkflowPrompt(body.prompt, library.catalog().workflows);
        if (!matched) payload = { matched: false };
        else if (body.prepareOnly) payload = { matched: true, prepared: true, workflowId: matched.workflowId, goal: matched.goal };
        else {
          const inputBody = { ...matched, inputs: body.inputs || {} };
          const preflight = runtime.preflight(matched.workflowId, inputBody);
          payload = preflight.ok ? { matched: true, run: runtime.start(matched.workflowId, inputBody, await settings()) } : { matched: true, needsInputs: true, workflowId: matched.workflowId, goal: matched.goal, preflight };
        }
      } else {
        const match = route.match(/^\/(workflows|runs|skills)\/([\w-]+)(?:\/(run|preflight|pack|undo|cancel|resume|evidence|diarize|export|duplicate|delete))?$/);
        if (!match) { json(response, 404, { error: "工作流接口不存在。" }); return true; }
        const [, type, id, action] = match;
        if (method === "GET" && type === "runs" && !action) { const run = library.get("runs", id); if (!run) throw new Error("运行记录不存在。"); payload = { run: { ...run, canResume: runtime.canResume(run), artifacts: artifactLinks(run), deliveryWarning: hasTwoVideoIntent(run.workflow) && !isVideoComposition(run.workflow) ? "旧版流程只执行了单视频分析和切片，没有接收第二个视频或合成完整成片；该记录不代表目标已完成。" : null } }; }
        else if (method === "GET" && type === "skills" && action === "export") { const skill = library.get("skills", id); if (!skill || skill.deletedAt) throw new Error("Skill 不存在。"); payload = { name: skill.name, content: skill.detail }; }
        else if (method === "POST" && type === "workflows" && action === "run") payload = { run: runtime.start(id, await readJSON(request), await settings()) };
        else if (method === "POST" && type === "workflows" && action === "preflight") payload = runtime.preflight(id, await readJSON(request));
        else if (method === "POST" && type === "workflows" && action === "duplicate") payload = { workflow: library.duplicate(id) };
        else if (method === "POST" && type === "workflows" && action === "delete") {
          if (runtime.isWorkflowRunning(id)) throw new Error("工作流正在运行，请停止后再删除。");
          const body = await readJSON(request);
          library.remove(id, body.revision);
          payload = { deleted: true };
        }
        else if (method === "POST" && type === "workflows" && action === "pack") { const body = await readJSON(request); payload = { workflow: library.pack(id, body.revision, body.nodeIds, body.name) }; }
        else if (method === "POST" && type === "workflows" && action === "undo") { const body = await readJSON(request); payload = { workflow: library.undoPack(id, body.revision) }; }
        else if (method === "POST" && type === "runs" && action === "cancel") { runtime.stop(id); payload = { stopping: true }; }
        else if (method === "POST" && type === "runs" && action === "resume") payload = { run: runtime.resume(id, await settings()) };
        else if (method === "POST" && type === "runs" && action === "evidence") payload = { run: runtime.resume(id, await settings(), await readJSON(request)) };
        else if (method === "POST" && type === "runs" && action === "diarize") payload = { run: runtime.diarize(id, await readJSON(request), await settings()) };
        else { json(response, 404, { error: "工作流接口不存在。" }); return true; }
      }
      if (payload?.run) payload.run = { ...payload.run, canResume: runtime.canResume(payload.run), recovery: runtime.recovery(payload.run), artifacts: artifactLinks(payload.run) };
      json(response, status, payload);
    } catch (error) { json(response, 400, { error: error.message }); }
    return true;
  };
}
