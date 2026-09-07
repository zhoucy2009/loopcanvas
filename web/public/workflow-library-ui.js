import { nodeTypes, validateWorkflow, topologicalNodes } from "./workflow-model.js";
import { speakerGroups } from "./speaker-model.js";
import { inputTypes, inputAccept, workflowInputs, referencedInputs, mergeInputs, bindNodeInput } from "./workflow-inputs.js";
const esc = (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const labels = { running: "运行中", waiting_input: "等待人工补充", complete: "已完成", failed: "失败", cancelled: "已停止", interrupted: "已中断", skipped: "已跳过" };
const uid = () => crypto.randomUUID();
const option = (value, label, current) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
const field = (name, label, value = "", multiline = false) => `<label>${label}${multiline ? `<textarea data-field="${name}" rows="4">${esc(value)}</textarea>` : `<input data-field="${name}" value="${esc(value)}">`}</label>`;
const legacyTranscriptionNode = (node) => {
  const detail = JSON.stringify(node?.arguments ?? {});
  return node?.type === "tool" && /\{\{\s*globals\.inputVideoPath\s*\}\}/.test(detail) && /(ffprobe|ffmpeg|whisper|loopcanvas-readonly-mode-)/i.test(detail);
};

const rekeyOutputReferences = (value, ids) => {
  if (typeof value === "string") return value.replace(/(\{\{\s*outputs\.)([\w-]+)(?=[.\s}])/g, (_, prefix, id) => `${prefix}${ids.get(id) ?? id}`);
  if (Array.isArray(value)) return value.map((item) => rekeyOutputReferences(item, ids));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rekeyOutputReferences(item, ids)]));
  return value;
};

export function copyGraphSelection(workflow, selectedIds) {
  const selected = new Set(selectedIds);
  return {
    format: "loopcanvas/workflow-nodes-v1",
    inputs: workflowInputs(workflow).filter((input) => workflow.nodes.some((node) => selected.has(node.id) && node.type === "skill") || referencedInputs(workflow.nodes.filter((node) => selected.has(node.id))).includes(input.key)),
    nodes: structuredClone(workflow.nodes.filter((node) => selected.has(node.id))),
    edges: structuredClone(workflow.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)))
  };
}

export function pasteGraphSelection(payload, idFactory = uid, offset = 32) {
  if (payload?.format !== "loopcanvas/workflow-nodes-v1" || !Array.isArray(payload.nodes) || !payload.nodes.length || !Array.isArray(payload.edges)) throw new Error("剪贴板中没有可粘贴的工作流节点。");
  const ids = new Map(payload.nodes.map((node) => [node.id, idFactory()]));
  return {
    inputs: payload.inputs || [],
    nodes: payload.nodes.map((node) => ({ ...rekeyOutputReferences(structuredClone(node), ids), id: ids.get(node.id), x: Math.min(19800, (node.x || 0) + offset), y: Math.min(19800, (node.y || 0) + offset) })),
    edges: payload.edges.map((edge) => ({ ...edge, from: ids.get(edge.from), to: ids.get(edge.to) }))
  };
}

export class WorkflowLibraryUI {
  constructor({ api, toast, open }) {
    Object.assign(this, { api, toast, open });
    this.catalog = { workflows: [], skills: [], runs: [] }; this.tools = []; this.drafts = new Map(); this.selected = new Set(); this.draft = null; this.run = null; this.loading = false; this.pending = false; this.generatorError = ""; this.nodeClipboard = null; this.deleteArmed = null;
    this.inputSessions = new Map(); this.inputValues = {}; this.inputNames = {}; this.view = "library";
    this.timer = setInterval(() => { if (this.root?.isConnected && this.run && (this.run.status === "running" || Date.now() - (this.lastRunPoll || 0) > 5000)) this.refreshRun().catch((e) => this.message(e.message, true)); }, 1400);
  }
  async request(route, body) { return this.api(`/api/workflow-library${route}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }); }
  mount(container) {
    if (this.root?.isConnected && this.root.parentElement === container) return;
    container.innerHTML = '<section id="workflow-library" class="wf-library" aria-label="自定义工作流"></section>';
    this.root = container.firstElementChild;
    this.root.addEventListener("click", (e) => this.click(e));
    this.root.addEventListener("input", (e) => this.input(e));
    this.root.addEventListener("change", (e) => this.change(e));
    this.root.addEventListener("pointerdown", (e) => this.pointerDown(e));
    this.root.addEventListener("dragstart", (e) => { const item = e.target.closest("[data-wf-drag]"); if (item && item.draggable) { e.dataTransfer.setData("application/x-loopcanvas-workflow", item.dataset.wfDrag); e.dataTransfer.effectAllowed = "copy"; document.querySelectorAll('[data-app-mode="workflow"], [data-wf-drop]').forEach((target) => target.classList.add("wf-drop-target")); } });
    this.root.addEventListener("dragend", () => document.querySelectorAll(".wf-drop-target").forEach((target) => target.classList.remove("wf-drop-target")));
    this.root.addEventListener("dragover", (e) => { if (e.target.closest("[data-wf-drop]") && [...e.dataTransfer.types].some((type) => ["Files", "application/x-loopcanvas-workflow"].includes(type))) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    this.root.addEventListener("drop", (e) => {
      if (!e.target.closest("[data-wf-drop]")) return;
      e.preventDefault(); e.stopPropagation();
      const id = e.dataTransfer.getData("application/x-loopcanvas-workflow");
      if (id) this.prepareRun(id, "drag").catch((error) => this.message(error.message, true));
      else if (e.dataTransfer.files.length) this.importMedia(e.dataTransfer.files[0], e.target.closest("[data-wf-input-drop]")?.dataset.wfInputDrop);
    });
    this.root.addEventListener("keydown", (e) => this.keydown(e));
    this.render();
    this.load().catch((e) => this.message(e.message, true));
  }
  async load() {
    this.loading = true; this.render();
    try { await Promise.all([this.request("").then((catalog) => { this.catalog = catalog; this.render(); }), this.request("/tools").then(({ tools }) => { this.tools = tools; })]); }
    finally {
      this.loading = false;
      // Tool discovery may finish after the user has opened a run or begun
      // editing. Do not replace that surface when background discovery ends.
      if (this.draft && this.view === "library" && !this.root?.querySelector(".wf-editor")?.contains(globalThis.document?.activeElement)) this.renderEditor();
      const status = this.root?.querySelector("[data-wf-status]");
      if (status?.textContent === "正在读取本机工作流库…") status.textContent = "本机保存 · 状态与中间产物由 Agent 管理";
    }
  }
  message(text, error = false) { const el = this.root?.querySelector("[data-wf-status]"); if (el) { el.textContent = text; el.classList.toggle("error", error); } this.toast(text, error); }
  select(w, { fresh = false } = {}) {
    if (!w) throw new Error("工作流已不存在，请刷新工作流库。");
    if (this.draft) { this.drafts.set(this.draft.id || "new", this.draft); this.inputSessions.set(this.draft.id || "new", { values: this.inputValues, names: this.inputNames, goal: this.goal }); }
    this.draft = !fresh && this.drafts.get(w.id || "new")?._dirty ? this.drafts.get(w.id || "new") : structuredClone(w);
    this.draft.nodes ??= []; this.draft.edges ??= []; this.draft.triggers ??= ["click", "drag", "prompt"];
    this.draft.inputs = workflowInputs(this.draft);
    const session = fresh ? null : this.inputSessions.get(w.id || "new");
    this.inputValues = { ...(w.inputDefaults || {}), ...(session?.values || {}) }; this.inputNames = { ...(session?.names || {}) }; this.goal = session?.goal || "";
    this.pendingTrigger = null; this.preflight = null; this.inputError = ""; this.dirty = Boolean(this.draft._dirty); this.generatorError = ""; this.deleteArmed = null; this.selected.clear(); this.render();
  }
  showLibrary() { this.view = "library"; this.open("library"); this.render(); }
  newDraft() { this.view = "library"; this.prompt = ""; this.run = null; this.select({ id: "", name: "新工作流", description: "", inputs: [], triggers: ["click", "drag", "prompt"], variables: {}, nodes: [], edges: [] }, { fresh: true }); this.root?.querySelector('[data-wf-name]')?.focus(); }
  async prepareRun(id, trigger = "click", goal = "") {
    if (this.preparing || this.uploading || this.starting) return;
    this.preparing = true;
    try {
      let workflow = id === "draft" || this.draft?.id === id ? this.draft : this.catalog.workflows.find((item) => item.id === id);
      if (!workflow) { this.catalog = await this.request(""); workflow = this.catalog.workflows.find((item) => item.id === id); }
      if (!workflow) throw new Error("找不到该工作流，请刷新工作流库。");
      if (!workflow.triggers.includes(trigger)) throw new Error("这个触发器尚未启用。");
      if (workflow === this.draft && (!workflow.id || this.dirty)) workflow = await this.save();
      this.select(workflow, { fresh: true });
      this.pendingTrigger = trigger; this.goal = goal; this.run = null; this.executionId = uid(); this.view = "execution";
      this.open("execution"); this.render();
      this.root?.querySelector('[data-wf-execution]')?.scrollIntoView({ block: "start" });
      this.root?.querySelector('[data-wf-goal]')?.focus();
      this.message("已创建本次新需求，请提供输入并开始执行");
    } finally { this.preparing = false; }
  }
  getNode() { return this.draft?.nodes.find((n) => this.selected.has(n.id)); }
  removeSelected() {
    if (!this.selected.size) throw new Error("请先选择要删除的节点。");
    this.draft.nodes = this.draft.nodes.filter((node) => !this.selected.has(node.id));
    this.draft.edges = this.draft.edges.filter((edge) => !this.selected.has(edge.from) && !this.selected.has(edge.to));
    this.selected.clear(); this.mark(); this.renderEditor();
  }
  copySelected(cut = false) {
    this.applyFields();
    const payload = copyGraphSelection(this.draft, this.selected);
    if (!payload.nodes.length) throw new Error("请先选择要复制的节点。");
    this.nodeClipboard = payload;
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).catch(() => {});
    if (cut) this.removeSelected();
    this.message(cut ? `已剪切 ${payload.nodes.length} 个节点` : `已复制 ${payload.nodes.length} 个节点`);
  }
  async pasteSelected() {
    let payload = this.nodeClipboard;
    if (!payload && navigator.clipboard?.readText) {
      try { payload = JSON.parse(await navigator.clipboard.readText()); } catch {}
    }
    const pasted = pasteGraphSelection(payload);
    this.draft.inputs = mergeInputs(this.draft.inputs, pasted.inputs);
    this.draft.nodes.push(...pasted.nodes); this.draft.edges.push(...pasted.edges);
    this.nodeClipboard = payload; this.selected = new Set(pasted.nodes.map((node) => node.id)); this.mark(); this.renderEditor(); this.message(`已粘贴 ${pasted.nodes.length} 个节点`);
  }
  mark() { this.dirty = true; if (this.draft) this.draft._dirty = true; const status = this.root.querySelector("[data-wf-status]"); if (status) status.textContent = "有未保存的修改"; }
  input(e) {
    if (e.target.dataset.wfSpeakerName) {
      const draft = this.evidenceDraft(); draft.speakerMappings ??= {}; draft.speakerMappings[e.target.dataset.inputKey] ??= {};
      draft.speakerMappings[e.target.dataset.inputKey][e.target.dataset.wfSpeakerName] = e.target.value;
    }
    if (e.target.dataset.wfDiarize) this.evidenceDraft()[e.target.dataset.wfDiarize] = e.target.value;
    if (e.target.dataset.wfEvidence) this.evidenceDraft()[e.target.dataset.wfEvidence] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    if (e.target.dataset.wfAnnotation) this.evidenceDraft().annotations[Number(e.target.dataset.row)][e.target.dataset.wfAnnotation] = e.target.value;
    if (e.target.dataset.wfParam) {
      const node = this.getNode(); node._fields ??= {};
      try { const args = JSON.parse(node._fields.arguments ?? JSON.stringify(node.arguments ?? {})); args[e.target.dataset.wfParam] = e.target.type === "number" ? Number(e.target.value) : e.target.value; node._fields.arguments = JSON.stringify(args, null, 2); const raw = this.root.querySelector('[data-field="arguments"]'); if (raw) raw.value = node._fields.arguments; this.mark(); }
      catch { this.message("请先修正高级参数中的 JSON", true); }
    }
    if (e.target.dataset.wfName !== undefined) { this.draft.name = e.target.value; this.mark(); }
    if (e.target.dataset.wfGoal !== undefined) { this.goal = e.target.value; this.media = null; this.inputError = ""; }
    if (e.target.dataset.wfInputValue) { this.inputValues[e.target.dataset.wfInputValue] = e.target.value; delete this.inputNames[e.target.dataset.wfInputValue]; this.inputError = ""; this.preflight = null; const state = e.target.closest("[data-wf-input-drop]")?.querySelector("[data-input-state]"); if (state) { state.textContent = "路径已修改，待检查"; state.classList.remove("error"); } }
    if (e.target.dataset.wfInputLabel) { this.draft.inputs.find((input) => input.key === e.target.dataset.wfInputLabel).label = e.target.value; this.preflight = null; this.mark(); }
    if (e.target.dataset.wfPrompt !== undefined) this.prompt = e.target.value;
    if (e.target.dataset.wfSkillName !== undefined) this.skillName = e.target.value;
    if (e.target.dataset.field !== undefined) {
      const node = this.getNode(); if (node) { node._fields ??= {}; node._fields[e.target.dataset.field] = e.target.value; this.mark(); }
    }
    if (e.target.dataset.wfVariables !== undefined) { this.draft._variables = e.target.value; this.mark(); }
  }
  change(e) {
    if (e.target.dataset.wfEvidenceFile !== undefined) { if (e.target.files[0]) this.uploadEvidence(e.target.files[0]); return; }
    if (e.target.dataset.wfDiarize || e.target.dataset.wfSpeakerName || e.target.dataset.wfEvidence || e.target.dataset.wfAnnotation) this.input(e);

    if (e.target.dataset.wfInputType) { this.draft.inputs.find((input) => input.key === e.target.dataset.wfInputType).type = e.target.value; this.preflight = null; this.mark(); this.renderExecution(); }
    if (e.target.dataset.wfMedia !== undefined) { if (e.target.files[0]) this.importMedia(e.target.files[0], e.target.dataset.wfMedia); return; }
    if (e.target.dataset.wfTrigger) { const set = new Set(this.draft.triggers); e.target.checked ? set.add(e.target.dataset.wfTrigger) : set.delete(e.target.dataset.wfTrigger); this.draft.triggers = [...set]; this.mark(); }
    if (e.target.dataset.wfSelect) { e.target.checked ? this.selected.add(e.target.dataset.wfSelect) : this.selected.delete(e.target.dataset.wfSelect); const id = e.target.dataset.wfSelect; this.renderEditor(); this.root.querySelector(`[data-wf-select="${id}"]`)?.focus(); }
    if (e.target.dataset.field !== undefined) this.input(e);
  }
  applyFields() {
    if (!this.draft) return;
    for (const node of this.draft.nodes) {
      const f = node._fields; if (!f) continue;
      for (const key of ["title", "tool", "instructions", "skillId"]) if (f[key] !== undefined) node[key] = f[key];
      if (f.skillId !== undefined) this.draft.inputs = mergeInputs(this.draft.inputs, this.catalog.skills.find((skill) => skill.id === f.skillId)?.inputs || []);
      if (f.arguments !== undefined) { try { node.arguments = JSON.parse(f.arguments); } catch { throw new Error(`${node.title} 的工具参数不是有效 JSON。`); } }
      if (node.type === "condition") {
        node.condition = { ...node.condition, path: f.path ?? node.condition.path, operator: f.operator ?? node.condition.operator };
        if (f.value !== undefined) { try { node.condition.value = JSON.parse(f.value); } catch { node.condition.value = f.value; } }
      }
      delete node._fields;
    }
    if (this.draft._variables !== undefined) { try { this.draft.variables = JSON.parse(this.draft._variables); } catch { throw new Error("初始变量不是有效 JSON。"); } delete this.draft._variables; }
  }
  async save() {
    this.applyFields(); validateWorkflow(this.draft);
    const clean = structuredClone(this.draft); delete clean._dirty;
    const { workflow } = await this.request("/save", clean);
    this.draft = workflow; this.drafts.set(workflow.id, workflow); this.dirty = false;
    this.catalog = await this.request(""); this.render(); this.message("已保存到本机工作流数据库"); return workflow;
  }
  async showRun(run) { this.run = run; this.view = "execution"; this.open("execution"); this.render(); await this.refreshRun(); }
  async triggerPrompt(prompt) {
    if (!/用[\s\S]+工作流\s*完成/.test(prompt)) return false;
    const result = await this.request("/trigger", { prompt, prepareOnly: true });
    if (result.prepared) { await this.prepareRun(result.workflowId, "prompt", result.goal); return true; }
    if (result.needsInputs) {
      this.catalog = await this.request(""); await this.prepareRun(result.workflowId, "prompt", result.goal);
      this.goal = result.goal; this.preflight = result.preflight; this.pendingTrigger = "prompt"; this.inputError = "请补齐并检查所有输入，之后点击开始执行。"; this.renderExecution(); return true;
    }
    if (result.matched) { await this.showRun(result.run); return true; }
    return false;
  }
  async importMedia(file, slot = "") {
    if (this.uploading || this.pending) return;
    const definitions = this.draft?.inputs || [];
    if (!slot && definitions.length === 1) slot = definitions[0].key;
    const definition = definitions.find((input) => input.key === slot);
    if (!definition || definition.type === "directory") { this.inputError = "请先在规划中添加文件输入，再把文件导入对应的输入框；文件夹请填写完整路径。"; this.renderExecution(); return; }
    const workflowId = this.draft.id;
    this.uploading = true; this.inputError = ""; this.renderExecution();
    try {
      if (file.size > 2 * 1024 ** 3) throw new Error("媒体文件超过 2 GiB，请改用本机完整路径。");
      const { file: imported } = await this.api("/api/workflow-library/inputs/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Workflow-Filename": encodeURIComponent(file.name) }, body: file });
      if (this.draft.id !== workflowId) throw new Error("工作流已切换，请回到原工作流重新选择输入。");
      this.inputValues[slot] = imported.path; this.inputNames[slot] = imported.name; this.preflight = null;
      this.message(`已导入 ${imported.name}，运行前会检查全部输入路径`);
    } catch (error) { this.inputError = error.message; this.message(error.message, true); }
    finally { this.uploading = false; this.renderExecution(); }
  }
  async start(id, trigger = "click") {
    if (this.view !== "execution") return this.prepareRun(id, trigger);
    if (this.run) throw new Error("此需求已有运行记录，请点击“再次执行 · 新需求”创建下一次运行。");
    if (this.uploading) throw new Error("正在导入媒体，请等待导入完成。");
    if (this.starting) return;
    let current = id === "draft" || this.draft?.id === id;
    let workflow = current ? this.draft : this.catalog.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error("请先选择工作流。");
    if (!workflow.triggers.includes(trigger)) throw new Error("这个触发器尚未启用。");
    if (!current) { this.open(); this.select(workflow); workflow = this.draft; current = true; }
    this.starting = true; this.inputError = ""; this.renderExecution();
    try {
      if (current && (!workflow.id || this.dirty)) workflow = await this.save();
      const body = { goal: this.goal || "", inputs: this.inputValues, trigger };
      this.preflight = await this.request(`/workflows/${workflow.id}/preflight`, body);
      if (!this.preflight.ok) { this.pendingTrigger = trigger; this.inputError = "输入检查未通过，请修正下方标注的路径后重试。"; this.open("execution"); this.renderExecution(); this.root.querySelector('[aria-invalid="true"]')?.focus(); return; }
      const { run } = await this.request(`/workflows/${workflow.id}/run`, body);
      this.pendingTrigger = null;
      await this.showRun(run); this.catalog = await this.request("");
      this.root.querySelector("[data-wf-run-panel]")?.scrollIntoView({ block: "start" });
    } catch (error) { this.inputError = error.message; throw error; } finally { this.starting = false; this.renderExecution(); if (this.preflight?.ok === false) this.root.querySelector('[aria-invalid="true"]')?.focus(); }
  }
  async refreshRun() {
    if (!this.run || this.polling) return;
    this.polling = true;
    this.lastRunPoll = Date.now();
    try { const id = this.run.id; const { run } = await this.request(`/runs/${id}`); if (this.run?.id === id) { const changed = this.run.status !== run.status; const grouped = this.run.speakerJob?.status === "running" && run.speakerJob?.status !== "running"; this.run = run; if (changed) this.catalog = await this.request(""); this.renderRun(); if (grouped) this.message(run.speakerJob.status === "complete" ? "声音分组已完成，请试听并填写姓名" : run.speakerJob.error || "声音分组已停止", run.speakerJob.status === "failed"); } }
    finally { this.polling = false; }
  }
  async click(e) {
    const button = e.target.closest("button"); if (!button || this.pending) return;
    const action = button.dataset.wfAction;
    if (!action && !button.dataset.wfOpen && !button.dataset.wfNode && !button.dataset.wfRun && !button.dataset.wfEdge && !button.dataset.wfHistory) return;
    try {
      if (button.dataset.wfOpen) { this.select(this.catalog.workflows.find((w) => w.id === button.dataset.wfOpen)); return; }
      if (button.dataset.wfNode) { this.selected = new Set([button.dataset.wfNode]); this.renderEditor(); return; }
      if (button.dataset.wfEdge) { this.draft.edges.splice(Number(button.dataset.wfEdge), 1); this.mark(); this.renderEditor(); return; }
      if (action === "add-annotation") { this.evidenceDraft().annotations.push({ inputKey: this.run.workflow.inputs?.[0]?.key || "", startSeconds: "", endSeconds: "", speaker: "" }); this.renderRun(true); return; }
      if (action === "remove-annotation") { this.evidenceDraft().annotations.splice(Number(button.dataset.row), 1); this.renderRun(true); return; }
      if (action === "layout") {
        this.applyFields(); topologicalNodes(this.draft).forEach((node, i) => { node.x = 35 + (i % 3) * 250; node.y = 35 + Math.floor(i / 3) * 150; });
        this.mark(); this.renderEditor(); this.message("已按箭头依赖顺序整理布局"); return;
      }
      if (action === "bind-output") {
        this.applyFields();
        const source = this.root.querySelector('[data-wf-bind-output]').value;
        const parameter = this.root.querySelector('[data-wf-output-parameter]').value.trim();
        if (!/^[a-zA-Z][\w]*$/.test(parameter) || ["constructor", "prototype"].includes(parameter)) throw new Error("请填写参数名称，例如 transcript、sourceCandidates 或 insertions。");
        const node = this.getNode(); node.arguments ??= {}; node.arguments[parameter] = `{{outputs.${source}}}`;
        this.mark(); this.renderEditor(); this.message("已绑定上游输出"); return;
      }
      if (action === "new") { this.newDraft(); return; }
      if (action === "library") { this.showLibrary(); return; }
      if (action === "prepare-run") { await this.prepareRun(this.draft?.id || "draft", this.pendingTrigger || "click"); return; }
      if (action === "add-input") {
        if (this.draft.inputs.length >= 32) throw new Error("工作流最多声明 32 个输入。");
        let index = 1; while (this.draft.inputs.some((input) => input.key === `input${index}`)) index++;
        this.draft.inputs.push({ key: `input${index}`, label: `输入 ${index}`, type: "file" }); this.preflight = null; this.mark(); this.renderEditor(); return;
      }
      if (action === "remove-input") {
        this.applyFields();
        const nodes = [...this.draft.nodes, ...this.draft.nodes.filter((node) => node.type === "skill").flatMap((node) => this.catalog.skills.find((skill) => skill.id === node.skillId)?.nodes || [])];
        if (referencedInputs(nodes).includes(button.dataset.inputKey)) throw new Error("该输入仍被节点或 Skill 引用，请先修改引用再删除。");
        this.draft.inputs = this.draft.inputs.filter((input) => input.key !== button.dataset.inputKey); delete this.inputValues[button.dataset.inputKey]; delete this.inputNames[button.dataset.inputKey]; this.preflight = null; this.mark(); this.renderEditor(); return;
      }
      if (action === "bind-input") {
        const parameter = this.root.querySelector('[data-wf-bind-parameter]').value;
        const key = this.root.querySelector('[data-wf-bind-input]').value;
        this.applyFields(); this.getNode().arguments = bindNodeInput(this.getNode(), parameter, key); this.mark(); this.renderEditor(); this.message("已绑定输入，运行时使用经过检查的真实路径"); return;
      }
      if (action === "check-inputs") {
        if (this.dirty || !this.draft.id) await this.save();
        this.preflight = await this.request(`/workflows/${this.draft.id}/preflight`, { goal: this.goal || "", inputs: this.inputValues });
        this.inputError = this.preflight.ok ? "" : "输入检查未通过，请修正标注的路径。"; this.renderExecution(); this.message(this.preflight.ok ? "全部输入路径当前可访问；启动时会再次检查" : this.inputError, !this.preflight.ok); return;
      }
      if (action === "copy-nodes") { this.copySelected(); return; }
      if (action === "cut-nodes") { this.copySelected(true); return; }
      if (action === "paste-nodes") { await this.pasteSelected(); return; }
      if (action === "delete-nodes") { this.removeSelected(); this.message("已删除选中节点"); return; }
      if (action === "delete-arm") { this.deleteArmed = this.draft.id; this.renderEditor(); return; }
      if (action === "delete-cancel") { this.deleteArmed = null; this.renderEditor(); return; }
      if (action === "add-transcriber") {
        const tool = this.tools.find((item) => item.name === "local_media_transcribe");
        if (!tool?.available) throw new Error(tool?.unavailableReason || "本机媒体转写工具当前不可用。");
        const legacy = this.draft.nodes.filter(legacyTranscriptionNode);
        let input = this.draft.inputs.find((input) => ["file", "video", "audio"].includes(input.type));
        if (!input) { let index = 1; while (this.draft.inputs.some((input) => input.key === `input${index}`)) index++; input = { key: `input${index}`, label: `输入 ${index}（媒体）`, type: "file" }; this.draft.inputs.push(input); }
        const base = { type: "tool", title: "本机转写媒体", tool: "local_media_transcribe", arguments: { inputPath: `{{input.${input.key}}}`, language: "zh-CN", outputName: "transcript.txt" }, instructions: "使用本机 Speech 模型转写；保留文本和带时间信息的片段。" };
        if (legacy.length) {
          for (const node of legacy) Object.assign(node, structuredClone(base));
          this.selected = new Set(legacy.map((node) => node.id)); this.mark(); this.render(); this.message(`已替换 ${legacy.length} 个旧转写节点，请检查后保存`); return;
        }
        const n = { id: uid(), ...base, x: 35 + (this.draft.nodes.length % 3) * 250, y: 35 + Math.floor(this.draft.nodes.length / 3) * 150 };
        this.draft.nodes.push(n); this.selected = new Set([n.id]); this.mark(); this.render(); return;
      }
      if (action === "add") {
        const type = this.root.querySelector("[data-wf-type]").value;
        const n = { id: uid(), type, title: nodeTypes[type], x: 35 + (this.draft.nodes.length % 3) * 250, y: 35 + Math.floor(this.draft.nodes.length / 3) * 150, instructions: "" };
        if (type === "tool") Object.assign(n, { tool: "", arguments: {} });
        if (type === "condition") n.condition = { path: "globals.ready", operator: "equals", value: true };
        if (type === "skill") { n.skillId = this.catalog.skills[0]?.id ?? ""; this.draft.inputs = mergeInputs(this.draft.inputs, this.catalog.skills[0]?.inputs || []); }
        this.draft.nodes.push(n); this.selected = new Set([n.id]); this.mark(); this.renderEditor(); return;
      }
      if (action === "remove") { this.removeSelected(); return; }
      if (action === "apply") { this.applyFields(); this.mark(); this.renderEditor(); return; }
      if (action === "connect") {
        const from = this.root.querySelector("[data-wf-from]").value, to = this.root.querySelector("[data-wf-to]").value;
        const when = this.root.querySelector("[data-wf-when]").value;
        const edges = [...this.draft.edges, { from, to, when }];
        // Validate graph without requiring unfinished tool fields to be complete.
        if (!from || !to || from === to || this.draft.edges.some((e) => e.from === from && e.to === to)) throw new Error("请选择不同的起点与终点，避免重复箭头。");
        topologicalNodes({ ...this.draft, edges });
        this.connection = { from, to, when }; this.draft.edges = edges; this.mark(); this.renderEditor(); return;
      }
      this.pending = true; button.disabled = true; this.root.setAttribute("aria-busy", "true");
      const status = this.root.querySelector("[data-wf-status]");
      if (status) status.textContent = action === "generate" ? "Agent 正在生成工具调用草稿…" : "正在处理…";
      if (action === "scan-skills") { this.availableSkills = (await this.request("/available-skills")).skills; this.renderEditor(); this.message(this.availableSkills.length ? "请选择要导入的本机 Skill" : "未发现本机 Skill"); }
      if (action === "import-skill") {
        const sourceId = this.root.querySelector("[data-wf-import]").value;
        const { skill } = await this.request("/import-skill", { id: sourceId });
        this.catalog = await this.request("");
        const n = this.getNode(); n.skillId = skill.id; n.title = skill.name; delete n._fields;
        this.mark(); this.renderEditor(); this.message("已将本机 Skill 快照保存到工作流 Skill 库");
      }
      if (action === "save") await this.save();
      if (action === "duplicate-workflow") {
        if (this.dirty) throw new Error("请先保存或重新载入当前修改，再复制工作流。");
        const { workflow } = await this.request(`/workflows/${this.draft.id}/duplicate`, {});
        this.catalog = await this.request(""); this.select(workflow); this.message(`已创建工作流“${workflow.name}”`);
      }
      if (action === "delete-workflow") {
        if (this.deleteArmed !== this.draft.id) throw new Error("请先确认要删除的工作流。");
        const id = this.draft.id;
        await this.request(`/workflows/${id}/delete`, { revision: this.draft.revision });
        this.drafts.delete(id); this.draft = null; this.selected.clear(); this.deleteArmed = null; this.catalog = await this.request(""); this.render(); this.message("工作流已删除，历史运行记录仍保留");
      }
      if (action === "reload") { if (this.draft?.id) { this.drafts.delete(this.draft.id); const catalog = await this.request(""); this.catalog = catalog; this.draft = structuredClone(catalog.workflows.find((w) => w.id === this.draft.id)); this.selected.clear(); this.dirty = false; } this.render(); }
      if (action === "generate") {
        this.generatorError = "";
        this.applyFields();
        const { nodes, inputs, planning } = await this.request("/generate", { prompt: this.prompt, inputs: this.draft.inputs });
        this.draft.inputs = mergeInputs(this.draft.inputs, inputs); this.draft.planning = planning;
        const offset = this.draft.nodes.length;
        nodes.forEach((n, i) => { n.x = 35 + ((offset + i) % 3) * 250; n.y = 35 + Math.floor((offset + i) / 3) * 150; });
        this.draft.nodes.push(...nodes);
        const chain = nodes;
        for (let i = 1; i < chain.length; i++) if (!this.draft.edges.some((edge) => edge.from === chain[i - 1].id && edge.to === chain[i].id)) this.draft.edges.push({ from: chain[i - 1].id, to: chain[i].id, when: "always" });
        this.selected = new Set(nodes.map((n) => n.id)); this.mark(); this.renderEditor(); this.message("已生成输入与工具调用草稿，请检查每个输入的用途和节点绑定后保存");
      }
      if (action === "refresh-tools") { this.tools = (await this.request("/tools?refresh=1")).tools; this.renderEditor(); this.message(`已同步 ${this.tools.filter((tool) => tool.available).length} 个可用工具`); }
      if (action === "pack") {
        if (!this.skillName?.trim()) throw new Error("请先输入 Skill 名称。");
        const ids = [...this.selected];
        await this.save();
        const { workflow } = await this.request(`/workflows/${this.draft.id}/pack`, { revision: this.draft.revision, nodeIds: ids, name: this.skillName });
        this.draft = workflow; this.selected.clear(); this.catalog = await this.request(""); this.render(); this.message("已合成并保存 Skill，可以撤销");
      }
      if (action === "undo") { if (this.dirty) throw new Error("有未保存的修改，请先重新载入再撤销合成。"); const { workflow } = await this.request(`/workflows/${this.draft.id}/undo`, { revision: this.draft.revision }); this.draft = workflow; this.catalog = await this.request(""); this.render(); this.message("已撤销 Skill 合成并恢复工具节点"); }
      if (action === "run") await this.start(this.draft?.id || "draft", this.pendingTrigger || "click");
      if (button.dataset.wfRun) await this.prepareRun(button.dataset.wfRun);
      if (button.dataset.wfHistory) { const { run } = await this.request(`/runs/${button.dataset.wfHistory}`); this.select(run.workflow, { fresh: true }); this.inputValues = { ...run.data.input }; this.goal = run.goal; await this.showRun(run); }
      if (action === "cancel") { await this.request(`/runs/${this.run.id}/cancel`, {}); this.message("正在停止 Agent 调用"); }
      if (action === "diarize") {
        const draft = this.evidenceDraft();
        const { run } = await this.request(`/runs/${this.run.id}/diarize`, { token: this.run.recovery.token, inputKey: draft.diarizeInput || this.run.workflow.inputs.find((input) => ["file", "audio", "video"].includes(input.type))?.key, numSpeakers: Number(draft.numSpeakers || -1), threshold: Number(draft.threshold || 0.9) });
        this.run = run; this.renderRun(true); this.message("正在本机按声音分组；完成后试听并填写姓名");
      }
      if (action === "submit-evidence" || action === "reject-evidence") {
        if (this.evidenceUploading) throw new Error("证据文件正在上传，请稍候。");
        const draft = this.evidenceDraft();
        if (!draft.note.trim() || !draft.confirmed) throw new Error("请填写实际核验依据，并勾选确认。");
        const annotations = draft.annotations.map((a) => ({ ...a, startSeconds: a.startSeconds === "" ? null : Number(a.startSeconds), endSeconds: a.endSeconds === "" ? null : Number(a.endSeconds) }));
        const { run } = await this.request(`/runs/${this.run.id}/evidence`, { token: this.run.recovery.token, ...draft, annotations, files: draft.files.split("\n").map((v) => v.trim()).filter(Boolean), decision: action === "reject-evidence" ? "reject" : "approve" });
        this.run = run; this.catalog = await this.request(""); this.renderRun(true); this.message(action === "reject-evidence" ? "已记录拒绝，后续步骤不会执行" : "已保存补充记录，继续本次运行");
      }
      if (action === "resume") {
        button.disabled = true;
        try { const { run } = await this.request(`/runs/${this.run.id}/resume`, {}); this.run = run; this.catalog = await this.request(""); this.renderRun(); this.message("已保留完成步骤，正在继续分析"); }
        finally { button.disabled = false; }
      }
      if (action === "refresh") { this.catalog = await this.request(""); this.render(); }
      if (action === "export-skill") {
        const skill = this.catalog.skills.find((s) => s.id === this.getNode()?.skillId);
        if (!skill) throw new Error("请选择已保存的 Skill。");
        const blob = new Blob([skill.detail], { type: "text/markdown" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "SKILL.md"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) { if (action === "generate") { this.generatorError = error.message; this.renderEditor(); } this.message(error.message, true); }
    finally { this.pending = false; this.root?.setAttribute("aria-busy", "false"); if (button.isConnected) button.disabled = false; const status = this.root?.querySelector('[data-wf-status]'); if (status?.textContent === '正在处理…') status.textContent = this.inputError || (this.dirty ? '有未保存的修改' : '本机保存 · 状态与中间产物由 Agent 管理'); }
  }
  render() {
    if (!this.root?.isConnected) return;
    if (this.view === "execution") {
      this.root.innerHTML = `<header class="wf-heading"><div><h2>${this.run ? "工作流需求 · 运行记录" : "执行 · 新需求"}</h2><p>使用工作流：${esc(this.draft?.name)}。每次启动独立保存输入、日志和产物。</p></div><button class="secondary" data-wf-action="library">返回工作流库</button></header><p data-wf-status role="status" aria-live="polite">${this.run ? "此记录保留本次运行的实际输入与结果" : "填写本次需求，检查输入后再开始"}</p><div data-wf-execution></div><div data-wf-run-panel></div>`;
      this.renderExecution(); this.renderRun(); return;
    }
    this.root.innerHTML = `<header class="wf-heading"><div><h2>自定义工作流</h2><p>保存一次，通过点击、拖入执行或“用…工作流完成…”复用。</p></div><button data-wf-action="new">＋ 新建工作流</button></header>
      <p data-wf-status role="status" aria-live="polite">${this.loading ? "正在读取本机工作流库…" : "本机保存 · 状态与中间产物由 Agent 管理"}</p>
      <div data-wf-execution></div>
      <div class="wf-layout"><aside class="wf-shelf"><h3>工作流库 <button class="ghost compact" data-wf-action="refresh" aria-label="刷新工作流库">刷新</button></h3>${this.catalog.workflows.length ? this.catalog.workflows.map((w) => `<article draggable="${w.triggers.includes("drag")}" data-wf-drag="${esc(w.id)}"><button class="ghost" data-wf-open="${esc(w.id)}" aria-pressed="${this.draft?.id === w.id}">${esc(w.name)}</button><span>${w.nodes.length} 个节点 · v${w.revision}${w.triggers.includes("drag") ? " · 拖动执行" : ""}</span><button class="secondary compact" data-wf-run="${esc(w.id)}" ${w.triggers.includes("click") ? "" : "disabled"}>执行</button></article>`).join("") : '<p class="muted">还没有保存的工作流。新建后添加节点，用箭头连接。</p>'}
      <p class="small muted">拖动整张工作流卡片或编辑器的“拖动整个工作流”手柄到执行区。画布节点拖动用于调整布局。</p></aside><div class="wf-main"><div data-wf-editor></div><div data-wf-run-panel></div></div></div>`;
    this.renderEditor(); this.renderRun();
  }
  renderExecution() {
    const el = this.root?.querySelector("[data-wf-execution]"); if (!el) return;
    const disabled = this.uploading || this.starting || Boolean(this.run && this.view === "execution");
    const definitions = this.draft?.inputs || [];
    const inputField = ({ key, label, type }) => {
      const check = this.preflight?.checks.find((check) => check.key === key);
      return `<div class="wf-video-input" data-wf-input-drop="${esc(key)}"><strong>${esc(label)} · ${esc(inputTypes[type])}（必需）</strong>${type !== "directory" ? `<label>导入文件<input type="file" aria-label="选择${esc(label)}" data-wf-media="${esc(key)}" ${inputAccept[type] ? `accept="${esc(inputAccept[type])}"` : ""} ${disabled ? "disabled" : ""}></label>` : ""}<label>本机完整路径<input data-wf-input-value="${esc(key)}" aria-label="${esc(label)}完整路径" aria-invalid="${check?.ok === false}" aria-describedby="wf-input-state-${esc(key)}" value="${esc(this.inputValues?.[key])}" placeholder="${type === "directory" ? "填写文件夹的绝对路径" : "导入后自动填入，也可粘贴绝对路径"}" ${disabled ? "disabled" : ""}></label><span id="wf-input-state-${esc(key)}" data-input-state class="small ${check?.ok === false ? "error" : "muted"}">${esc(check ? check.ok ? "路径检查通过" : check.error : this.inputNames[key] || (this.inputValues[key] ? "已指定路径，待检查" : "尚未提供"))}</span></div>`;
    };
    el.innerHTML = `<section class="wf-execution" data-wf-drop aria-label="工作流执行区">
      <div class="wf-toolbar"><h3>${this.view === "execution" ? "本次需求输入" : "执行工作流"}${this.draft ? ` · ${esc(this.draft.name)}` : ""}</h3><button class="secondary" data-wf-action="check-inputs" ${disabled || !this.draft?.nodes.length ? "disabled" : ""}>检查输入路径</button>${this.run && this.view === "execution" ? '<button data-wf-action="prepare-run">再次执行 · 新需求</button>' : `<button data-wf-action="run" ${disabled || !this.draft?.nodes.length || !this.draft?.triggers.includes(this.pendingTrigger || "click") ? "disabled" : ""}>${this.starting ? "正在检查输入…" : this.view === "execution" ? "开始执行" : "创建执行需求"}</button>`}</div>
      <div class="wf-execution-inputs">${definitions.map(inputField).join("")}</div>
      <label class="wf-task-input">本次任务说明<input data-wf-goal value="${esc(this.goal)}" placeholder="填写本次处理要求；文件请放入各自的输入框" ${disabled ? "disabled" : ""}></label>
      <p class="small muted" role="status">${this.uploading ? "正在将文件导入本机，请稍候…" : definitions.length ? `共 ${definitions.length} 个必需输入。启动前和每个工具步骤前检查全部路径。文件可拖入对应输入框；单文件导入最多 2 GiB，更大文件可填写路径。` : "此工作流尚未声明文件输入。在下方规划中添加输入 1、输入 2 等，运行时逐项提供路径。"}</p>
      ${this.inputError ? `<p class="error" role="alert">${esc(this.inputError)}</p>` : ""}
    </section>`;
  }
  renderEditor() {
    this.renderExecution();
    const el = this.root?.querySelector("[data-wf-editor]"); if (!el) return;
    const w = this.draft;
    if (!w) { el.innerHTML = '<div class="wf-empty"><h3>把常用流程保存为工作流</h3><p>触发器 → 工具 / Skill 节点 → 条件箭头 → 集成与输出</p><button class="secondary" data-wf-action="new">创建工作流</button></div>'; return; }
    const n = this.getNode();
    const transcriber = this.tools.find((tool) => tool.name === "local_media_transcribe");
    const legacyTranscriberCount = w.nodes.filter(legacyTranscriptionNode).length;
    const transcriberStatus = transcriber?.available ? "可用 · 媒体留在本机" : transcriber?.unavailableReason || "正在检测本机转写能力…";
    const availableTools = this.tools.filter((tool) => tool.available);
    const codexTools = this.tools.filter((tool) => String(tool.source || "").startsWith("codex-"));
    const sourceLabel = (tool) => tool.source === "codex-mcp" ? `MCP · ${tool.namespace}` : tool.source === "codex-app" ? `App · ${tool.namespace}` : tool.source === "codex-core" ? "Codex 核心" : "LoopCanvas";
    const value = (key, fallback) => n?._fields?.[key] ?? fallback;
    const width = Math.max(800, ...w.nodes.map((n) => (n.x || 0) + 250)), height = Math.max(350, ...w.nodes.map((n) => (n.y || 0) + 140));
    el.innerHTML = `<section class="wf-editor"><div class="wf-toolbar"><label class="wf-name">工作流名称<input data-wf-name value="${esc(w.name)}" maxlength="100"></label><button data-wf-action="save">保存</button><button class="secondary" data-wf-action="run" ${w.triggers.includes("click") ? "" : "disabled"}>保存并执行</button>${w.triggers.includes("drag") ? `<span class="wf-drag-handle" draggable="true" data-wf-drag="${esc(w.id || "draft")}">⠿ 拖动整个工作流</span>` : ""}${w.id ? `<button class="ghost" data-wf-action="reload">重新载入</button><button class="ghost" data-wf-action="duplicate-workflow">复制工作流</button>${this.deleteArmed === w.id ? '<button class="danger" data-wf-action="delete-workflow">确认删除</button><button class="ghost" data-wf-action="delete-cancel">取消</button>' : '<button class="ghost" data-wf-action="delete-arm">删除工作流</button>'}` : ""}</div>
      <fieldset class="wf-triggers"><legend>触发器</legend>${[["click", "点击执行"], ["drag", "拖入执行"], ["prompt", "提示词触发"]].map(([v, l]) => `<label><input type="checkbox" data-wf-trigger="${v}" ${w.triggers.includes(v) ? "checked" : ""}>${l}</label>`).join("")}</fieldset>
      <section class="wf-input-plan" aria-label="规划工作流输入"><div class="wf-toolbar"><h3>规划输入</h3><button class="secondary compact" data-wf-action="add-input">＋ 添加输入</button></div><p class="small muted">先声明完成目标需要的所有文件或文件夹，再让节点选择引用。名称可修改，标识保持稳定；每个输入都是必需项。</p>${w.inputs.map((input) => `<div class="wf-input-definition"><label>输入名称<input data-wf-input-label="${esc(input.key)}" aria-label="${esc(input.key)} 输入名称" maxlength="100" value="${esc(input.label)}"></label><label>输入类型<select data-wf-input-type="${esc(input.key)}" aria-label="${esc(input.key)} 输入类型">${Object.entries(inputTypes).map(([key, label]) => option(key, label, input.type)).join("")}</select></label><code>{{input.${esc(input.key)}}}</code><button class="ghost compact" data-wf-action="remove-input" data-input-key="${esc(input.key)}" aria-label="删除输入 ${esc(input.key)}">删除输入</button></div>`).join("") || '<p class="muted">暂无输入。也可在描述中说明所需素材，让规划自动补充输入。</p>'}</section>
      <div class="wf-generate"><label>用自然语言生成工具调用<textarea data-wf-prompt rows="2" placeholder="例如：将本次任务中的视频路径转成文字">${esc(this.prompt)}</textarea></label><button class="secondary" data-wf-action="generate">生成节点</button></div>
      ${w.planning ? `<section class="wf-plan-check"><h3>规划检查</h3><p>已检查 ${w.planning.capabilities?.filter((tool) => tool.available).length ?? 0} 个可用工具；人工关卡需要提交实际核验依据。</p>${(w.planning.warnings || []).map((warning) => `<p>${esc(warning)}</p>`).join("")}<details><summary>查看原始要求</summary><p>${esc(w.planning.requirements)}</p></details></section>` : ""}
      <div class="wf-local-tool"><div><strong>本机视频 / 音频转写</strong><span>${esc(legacyTranscriberCount ? `发现 ${legacyTranscriberCount} 个使用失效变量或临时目录的旧节点` : transcriberStatus)}</span></div><button class="secondary compact" data-wf-action="add-transcriber" ${transcriber?.available ? "" : "disabled"}>${legacyTranscriberCount ? "替换旧转写节点" : "添加转写节点"}</button></div>${this.generatorError ? `<p class="wf-generate-error" role="alert">${esc(this.generatorError)}</p>` : ""}
      <div class="wf-tool-directory-heading"><span>已同步 ${availableTools.length} / ${this.tools.length} 个工具 · Codex ${codexTools.filter((tool) => tool.available).length} / ${codexTools.length}</span><button class="ghost compact" data-wf-action="refresh-tools">刷新工具</button></div><details class="wf-tool-directory"><summary>查看工具名称、来源与可用状态</summary><div class="wf-tool-list">${this.tools.map((tool) => `<article class="${tool.available ? "" : "unavailable"}"><strong>${esc(tool.title || tool.name)}</strong><code>${esc(tool.name)}</code><span>${esc(sourceLabel(tool))}${tool.available ? " · 可用" : ` · ${tool.unavailableReason || "不可用"}`}</span><p>${esc(tool.description)}</p></article>`).join("")}</div></details>
      <div class="wf-toolbar"><label>添加节点<select data-wf-type>${Object.entries(nodeTypes).map(([v,l]) => option(v,l,"tool")).join("")}</select></label><button class="secondary" data-wf-action="add">＋ 添加</button><span class="muted">拖动节点调整位置 · 在空白处框选 · 复选框可多选</span></div>
      <div class="wf-graph-scroll"><div class="wf-graph" tabindex="0" role="group" aria-label="工作流画布，空白处拖动框选，节点可用方向键移动">
      <svg class="wf-edges" width="${width}" height="${height}" aria-hidden="true"><defs><marker id="wf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z"/></marker></defs>${this.edgesSVG()}</svg>
      ${w.nodes.map((node) => `<article class="wf-node ${this.selected.has(node.id) ? "selected" : ""}" data-wf-position="${esc(node.id)}"><header data-wf-handle="${esc(node.id)}"><label><input type="checkbox" data-wf-select="${esc(node.id)}" aria-label="选择 ${esc(node.title)}" ${this.selected.has(node.id) ? "checked" : ""}>${nodeTypes[node.type]}</label><span aria-hidden="true">⠿</span></header><button class="ghost" data-wf-node="${esc(node.id)}">${esc(node.title)}</button><small>${esc(node.type === "tool" ? node.tool || "配置工具名称与参数" : node.type === "condition" ? node.condition.path : node.type === "skill" ? "可复用工具序列" : node.type === "review" ? "独立调用审核模型 · 不通过则停止" : node.type === "approval" ? "等待人工核验 · 提交依据后继续" : "交付与外部集成")}</small></article>`).join("")}<div class="wf-marquee" hidden></div></div></div>
      <div class="wf-connect"><label>起点<select data-wf-from>${w.nodes.map((n) => option(n.id,n.title,this.connection?.from)).join("")}</select></label><label>箭头条件<select data-wf-when>${option("always","完成后",this.connection?.when)}${option("true","条件：是",this.connection?.when)}${option("false","条件：否",this.connection?.when)}</select></label><label>终点<select data-wf-to>${w.nodes.map((n) => option(n.id,n.title,this.connection?.to || w.nodes[1]?.id)).join("")}</select></label><button class="secondary" data-wf-action="connect">连接 →</button><button class="ghost" data-wf-action="layout">按执行顺序整理</button></div>
      <div class="wf-edge-list">${w.edges.map((edge, i) => `<button class="ghost compact" data-wf-edge="${i}" title="点击删除这条箭头">${esc(w.nodes.find((n) => n.id === edge.from)?.title)} → ${esc(w.nodes.find((n) => n.id === edge.to)?.title)} · ${{always:"完成后",true:"是",false:"否"}[edge.when]} ×</button>`).join("")}</div>
      <div class="wf-selection"><strong>已选 ${this.selected.size} 个节点</strong><button class="ghost" data-wf-action="copy-nodes" aria-keyshortcuts="Meta+C Control+C" ${this.selected.size ? "" : "disabled"}>复制</button><button class="ghost" data-wf-action="cut-nodes" aria-keyshortcuts="Meta+X Control+X" ${this.selected.size ? "" : "disabled"}>剪切</button><button class="ghost" data-wf-action="paste-nodes" aria-keyshortcuts="Meta+V Control+V">粘贴</button><button class="ghost" data-wf-action="delete-nodes" aria-keyshortcuts="Delete Backspace" ${this.selected.size ? "" : "disabled"}>删除</button><input data-wf-skill-name value="${esc(this.skillName)}" placeholder="合成后的 Skill 名称" aria-label="Skill 名称"><button class="secondary" data-wf-action="pack" ${this.selected.size < 2 ? "disabled" : ""}>合成为 Skill</button><button class="ghost" data-wf-action="undo" ${w.undo && w.revision === w.undo.before.revision + 1 ? "" : "disabled"}>撤销合成</button></div>
      ${n ? `<section class="wf-inspector"><h3>节点设置 · ${esc(n.title)}</h3><p class="wf-node-reference">输出引用：<code>{{outputs.${esc(n.id)}}}</code></p>${field("title", "节点名称", value("title", n.title))}${n.type === "tool" ? field("tool", "工具名称", value("tool", n.tool)) + this.parameterFields(n) + `<details><summary>高级参数（JSON）</summary>${field("arguments", "调用参数（JSON）", value("arguments", JSON.stringify(n.arguments ?? {}, null, 2)), true)}</details>` : ""}
      ${n.type === "tool" && w.inputs.length ? `<div class="wf-input-binding"><label>选择工作流输入<select data-wf-bind-input>${w.inputs.map((input) => option(input.key, `${input.label}（${input.key}）`, "")).join("")}</select></label><label>写入节点参数<input data-wf-bind-parameter placeholder="例如 inputPath 或 options.source" value="inputPath"></label><button class="secondary" data-wf-action="bind-input">绑定输入</button><p class="small muted">绑定后参数引用该输入，运行时自动替换为已检查的路径。</p></div>` : ""}
      ${["tool", "review"].includes(n.type) ? this.outputBinding(n) : ""}
      ${n.type === "skill" ? `<label>已保存的 Skill<select data-field="skillId"><option value="">选择 Skill</option>${this.catalog.skills.map((s) => option(s.id,s.name,value("skillId",n.skillId))).join("")}</select></label><button class="ghost compact" data-wf-action="export-skill">导出 SKILL.md</button><button class="secondary" data-wf-action="scan-skills">查找本机 Skill</button>${this.availableSkills?.length ? `<label>本机 Skill<select data-wf-import>${this.availableSkills.map((s) => option(s.id,s.name,"")).join("")}</select></label><button class="secondary" data-wf-action="import-skill">导入并使用</button>` : ""}` : ""}
      ${n.type === "condition" ? `${field("path", "数据路径", value("path", n.condition.path))}<label>比较方式<select data-field="operator">${[["equals","等于"],["notEquals","不等于"],["exists","存在"],["contains","包含"]].map(([v,l]) => option(v,l,value("operator",n.condition.operator))).join("")}</select></label>${field("value", "比较值（JSON 或文本）", value("value", JSON.stringify(n.condition.value)))}` : field("instructions", n.type === "output" ? "集成与输出要求（目标工具、路径与交付格式）" : ["approval", "review"].includes(n.type) ? "验收要求与所需证据（逐项列明）" : "执行说明", value("instructions", n.instructions), true)}<button class="secondary" data-wf-action="apply">应用节点设置</button></section>` : ""}
      <details class="wf-data"><summary>状态与数据 · 由 Agent 自动管理</summary><p>globals 是同一工作流跨运行共享的变量；context、历史消息、节点输出、中间产物和模型调用记录按运行隔离。参数用 {{input.goal}}、{{globals.key}}、{{outputs.节点ID}} 引用。多条箭头汇入时等待上游结束，任一激活路径可继续。</p><label>首次运行的初始变量（JSON）<textarea data-wf-variables rows="4">${esc(w._variables ?? JSON.stringify(w.variables ?? {}, null, 2))}</textarea></label></details></section>`;
    this.applyGraphLayout();
  }
  applyGraphLayout() {
    const graph = this.root.querySelector(".wf-graph"); if (!graph || !this.draft) return;
    // The workbench CSP rejects inline style attributes. CSSOM assignments keep it intact.
    graph.style.width = `${Math.max(800, ...this.draft.nodes.map((n) => (n.x || 0) + 250))}px`;
    graph.style.height = `${Math.max(350, ...this.draft.nodes.map((n) => (n.y || 0) + 140))}px`;
    for (const n of this.draft.nodes) {
      const card = graph.querySelector(`[data-wf-position="${n.id}"]`);
      card.style.left = `${n.x || 0}px`; card.style.top = `${n.y || 0}px`;
    }
  }
  edgesSVG() {
    return this.draft.edges.map((e) => {
      const a = this.draft.nodes.find((n) => n.id === e.from), b = this.draft.nodes.find((n) => n.id === e.to); if (!a || !b) return "";
      const x1 = (a.x || 0) + 210, y1 = (a.y || 0) + 58, x2 = (b.x || 0) - 3, y2 = (b.y || 0) + 58;
      return `<path d="M${x1},${y1} C${x1+55},${y1} ${x2-55},${y2} ${x2},${y2}" marker-end="url(#wf-arrow)"/><text x="${(x1+x2)/2}" y="${(y1+y2)/2-8}">${e.when === "true" ? "是" : e.when === "false" ? "否" : ""}</text>`;
    }).join("");
  }
  pointerDown(e) {
    const handle = e.target.closest('[data-wf-drag][draggable="true"]');
    if (handle && e.button === 0 && !e.target.closest("button,input")) {
      e.preventDefault();
      const id = handle.dataset.wfDrag;
      const targets = [...document.querySelectorAll('[data-app-mode="workflow"], [data-wf-drop]')];
      targets.forEach((target) => target.classList.add("wf-drop-target"));
      const initial = { x: e.clientX, y: e.clientY };
      const finish = (event) => {
        window.removeEventListener("pointerup", finish, true); window.removeEventListener("pointercancel", finish, true);
        targets.forEach((target) => target.classList.remove("wf-drop-target"));
        if (event.type !== "pointerup" || Math.hypot(event.clientX - initial.x, event.clientY - initial.y) < 6) return;
        if (document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-app-mode="workflow"], [data-wf-drop]')) this.prepareRun(id, "drag").catch((error) => this.message(error.message, true));
      };
      window.addEventListener("pointerup", finish, true); window.addEventListener("pointercancel", finish, true); return;
    }
    const graph = e.target.closest(".wf-graph");
    if (!graph || e.button !== 0 || e.target.closest("input,button")) return;
    const id = e.target.closest("[data-wf-handle]")?.dataset.wfHandle;
    const node = this.draft.nodes.find((n) => n.id === id);
    if (!node && !e.target.matches(".wf-graph, .wf-edges")) return;
    e.preventDefault();
    const box = graph.getBoundingClientRect(), start = { x: e.clientX - box.left, y: e.clientY - box.top }, original = node ? { x: node.x || 0, y: node.y || 0 } : null;
    const marquee = graph.querySelector(".wf-marquee");
    const move = (event) => {
      const end = { x: event.clientX-box.left, y: event.clientY-box.top };
      if (node) {
        node.x = Math.max(0, Math.min(graph.clientWidth-215, original.x + end.x-start.x)); node.y = Math.max(0, Math.min(graph.clientHeight-115, original.y + end.y-start.y));
        const card = graph.querySelector(`[data-wf-position="${node.id}"]`); card.style.left = `${node.x}px`; card.style.top = `${node.y}px`;
        const svg = graph.querySelector("svg"); svg.innerHTML = svg.querySelector("defs").outerHTML + this.edgesSVG();
      } else {
        const left = Math.min(start.x,end.x), top = Math.min(start.y,end.y), width = Math.abs(end.x-start.x), height = Math.abs(end.y-start.y);
        marquee.hidden = false; Object.assign(marquee.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        this.selected = new Set(this.draft.nodes.filter((n) => (n.x||0) < left+width && (n.x||0)+210 > left && (n.y||0) < top+height && (n.y||0)+115 > top).map((n) => n.id));
        graph.querySelectorAll("[data-wf-position]").forEach((c) => c.classList.toggle("selected", this.selected.has(c.dataset.wfPosition)));
      }
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); if (node) this.mark(); this.renderEditor(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  }
  keydown(e) {
    if (e.target.closest("input,textarea,select,[contenteditable=true]")) return;
    const modifier = e.metaKey || e.ctrlKey;
    if (modifier && ["c", "x", "v"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      try {
        if (e.key.toLowerCase() === "c") this.copySelected();
        else if (e.key.toLowerCase() === "x") this.copySelected(true);
        else this.pasteSelected().catch((error) => this.message(error.message, true));
      } catch (error) { this.message(error.message, true); }
      return;
    }
    if (["Delete", "Backspace"].includes(e.key) && e.target.closest(".wf-graph") && this.selected.size) { e.preventDefault(); this.removeSelected(); this.message("已删除选中节点"); return; }
    if (!e.target.closest(".wf-graph")) return;
    const direction = { ArrowLeft: [-10,0], ArrowRight: [10,0], ArrowUp: [0,-10], ArrowDown: [0,10] }[e.key];
    const id = e.target.dataset.wfNode;
    if (id && direction) { e.preventDefault(); const n = this.draft.nodes.find((n) => n.id === id); n.x = Math.max(0,(n.x||0)+direction[0]); n.y = Math.max(0,(n.y||0)+direction[1]); this.mark(); this.renderEditor(); this.root.querySelector(`[data-wf-node="${id}"]`)?.focus(); }
  }
  parameterFields(node) {
    let args; try { args = JSON.parse(node._fields?.arguments ?? JSON.stringify(node.arguments || {})); } catch { return ""; }
    const names = { criteria: "筛选 / 匹配标准", maxCandidates: "最多候选数量", maxInsertions: "最多插入数量", numSpeakers: "说话人数（-1 为自动估计，1–32 为指定人数）", threshold: "分组阈值（越小分组越多）", contextSeconds: "保留前后秒数", keywordsPerCandidate: "每段关键词数量", inputPath: "输入路径", sourcePath: "素材路径", targetPath: "主视频路径" };
    return Object.entries(args).filter(([key, value]) => names[key] && ["string", "number"].includes(typeof value)).map(([key, value]) => `<label>${names[key]}${key === "criteria" ? `<textarea rows="5" data-wf-param="${key}">${esc(value)}</textarea>` : `<input data-wf-param="${key}" type="${typeof value === "number" ? "number" : "text"}" ${typeof value === "number" ? `min="${key === 'numSpeakers' ? -1 : 0}" step="any"` : ""} value="${esc(value)}">`}</label>`).join("");
  }
  outputBinding(node) {
    const ancestors = new Set();
    const visit = (id) => { for (const edge of this.draft.edges.filter((e) => e.to === id)) if (!ancestors.has(edge.from)) { ancestors.add(edge.from); visit(edge.from); } }; visit(node.id); ancestors.delete(node.id);
    const sources = this.draft.nodes.filter((n) => ancestors.has(n.id));
    const fields = (n) => n.tool === "agent_transcript_analyze" ? [["", "完整分析"], ["candidates", "候选片段"]] : n.tool === "agent_media_match" ? [["", "完整匹配"], ["insertions", "插入计划"]] : [["", "完整输出"]];
    return `<div class="wf-input-binding"><label>选择上游输出<select data-wf-bind-output>${sources.flatMap((n) => fields(n).map(([key, label]) => option(n.id + (key ? "." + key : ""), `${n.title} · ${label}`, ""))).join("")}</select></label><label>写入参数<input data-wf-output-parameter value="${node.tool === "agent_media_match" ? "sourceCandidates" : node.tool === "local_media_compose" ? "insertions" : "transcript"}"></label><button class="secondary" data-wf-action="bind-output" ${sources.length ? "" : "disabled"}>绑定上游输出</button><p class="muted">先用箭头连接前置节点，再选择它的输出，无需填写节点标识。</p></div>`;
  }
  evidenceDraft() {
    const key = `${this.run?.id}:${this.run?.recovery?.token}`;
    this.evidenceDrafts ??= new Map();
    if (!this.evidenceDrafts.has(key)) this.evidenceDrafts.set(key, { note: "", confirmed: false, files: "", annotations: [] });
    return this.evidenceDrafts.get(key);
  }
  async uploadEvidence(file) {
    if (this.evidenceUploading) return;
    const draft = this.evidenceDraft(); this.evidenceUploading = true;
    try {
      this.message("正在上传证据…");
      const { file: uploaded } = await this.api("/api/workflow-library/inputs/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Workflow-Filename": encodeURIComponent(file.name) }, body: file });
      draft.files = [draft.files, uploaded.path].filter(Boolean).join("\n"); this.message("证据已上传，提交时会再次检查路径");
    } catch (error) { this.message(error.message, true); }
    finally { this.evidenceUploading = false; this.renderRun(true); }
  }
  speakerForm(run) {
    const inputs = (run.workflow.inputs || []).filter((input) => ["file", "audio", "video"].includes(input.type));
    if (!inputs.length) return "";
    const groups = speakerGroups(run), draft = this.evidenceDraft(), busy = run.speakerJob?.status === "running";
    draft.speakerGroupVersions ??= {}; draft.speakerMappings ??= {};
    for (const [key, group] of Object.entries(groups)) if (draft.speakerGroupVersions[key] !== group.id) {
      draft.speakerGroupVersions[key] = group.id; draft.speakerMappings[key] = {};
    }
    return `<section class="wf-speaker-groups"><h3>自动区分说话人</h3><p>先按声音分组，再试听并填写姓名。支持多人；同一个人被分成多组时填写相同姓名即可合并。未知人物留空，个别错分用下方片段标注纠正。</p>
      <div class="wf-annotation"><label>分析哪个输入<select data-wf-diarize="diarizeInput">${inputs.map((input) => option(input.key, input.label, draft.diarizeInput || inputs[0].key)).join("")}</select></label><label>说话人数<select data-wf-diarize="numSpeakers">${option("-1", "自动估计", draft.numSpeakers || "-1")}${Array.from({length:32}, (_,i) => option(String(i+1), `${i+1} 人`, draft.numSpeakers)).join("")}</select></label></div>
      <details data-key="speaker-settings"><summary>分组调整</summary><label>阈值（越小分得越细）<input type="number" min="0.1" max="1.5" step="0.05" data-wf-diarize="threshold" value="${esc(draft.threshold || 0.9)}"></label><p>人数不对时可指定人数重新分组；重新分组后需要重新试听并确认姓名。</p></details>
      <button class="secondary" data-wf-action="diarize" ${busy ? "disabled" : ""}>${busy ? "正在按声音分组…" : "自动分组并生成试听"}</button><p class="muted">首次使用会下载开源组件和约 47 MB 模型；音视频留在本机。</p>
      ${run.speakerJob?.error ? `<p class="error" role="alert">${esc(run.speakerJob.error)}</p>` : ""}
      ${Object.entries(groups).map(([key, group]) => `<h4>${esc(inputs.find((input) => input.key === key)?.label || key)} · 分出 ${group.speakers.length} 组声音</h4><p>${group.overlapCount} 个重叠语音片段保留待确认。自动分组不是人物身份识别。</p>${group.speakers.map((speaker) => `<article class="wf-speaker"><strong>${esc(speaker.label)} · ${speaker.turnCount} 段 · ${speaker.durationSeconds} 秒</strong>${speaker.samples.map((sample) => {
        const artifact = run.artifacts?.find((artifact) => artifact.path === sample.path);
        return artifact ? `<label>试听 ${sample.startSeconds.toFixed(1)}–${sample.endSeconds.toFixed(1)} 秒<audio controls preload="none" src="${esc(artifact.downloadUrl)}?preview=1"></audio></label>` : "";
      }).join("") || '<p>没有足够清晰的独立片段可试听，请打开原始素材核验。</p>'}<label>${esc(speaker.label)} 对应姓名<input data-wf-speaker-name="${esc(speaker.id)}" data-input-key="${esc(key)}" value="${esc(draft.speakerMappings[key]?.[speaker.id] || "")}" placeholder="试听后填写，例如于谦；未知留空" ${busy ? "disabled" : ""}></label><details data-key="speaker-${esc(key)}-${esc(speaker.id)}"><summary>查看该组的所有时间范围</summary><p>${group.turns.filter((turn) => turn.speakerId === speaker.id).map((turn) => `${turn.startSeconds.toFixed(2)}–${turn.endSeconds.toFixed(2)} 秒${turn.overlap ? "（多人重叠，待确认）" : ""}`).join("；")}</p></details></article>`).join("")}`).join("")}</section>`;
  }
  recoveryForm(run) {
    const recovery = run.recovery;
    if (recovery?.kind !== "needs_input") return recovery?.kind === "blocked" ? `<p class="muted">恢复建议：${esc(recovery.reason)} 修正后新建需求。</p>` : "";
    const draft = this.evidenceDraft();
    const inputs = run.workflow.inputs || [];
    const transcripts = Object.entries(run.data.outputs).filter(([, output]) => Array.isArray(output?.segments));
    return `<section class="wf-evidence"><h3>${recovery.mode === "approval" ? "等待人工确认" : "补充证据后继续"}</h3><p>${esc(recovery.reason)}</p><p class="muted">补充只作用于本次运行。已完成步骤会保留；人工声明会标明来源，分析仍需检查是否充分。</p>
      ${inputs.map((input) => `<a href="/api/workflow-library/runs/${esc(run.id)}/inputs/${esc(input.key)}" target="_blank" rel="noopener">打开 ${esc(input.label)}</a>`).join(" · ")}
      <details data-key="transcripts"><summary>查看已有转写片段与时间</summary>${transcripts.map(([id, output]) => `<h4>${esc(run.workflow.nodes.find((n) => n.id === id)?.title || "转写")}</h4><ol>${output.segments.map((seg, i) => `<li>${i} · ${esc(Number(seg.startSeconds).toFixed(2))}–${esc((Number(seg.startSeconds) + Number(seg.durationSeconds)).toFixed(2))} 秒：${esc(seg.text)}</li>`).join("")}</ol>`).join("") || "暂无转写"}</details>
      ${this.speakerForm(run)}
      <label>核验依据与补充说明<textarea data-wf-evidence="note" rows="4" placeholder="写明实际检查了什么、依据是什么、确认了哪些范围">${esc(draft.note)}</textarea></label>
      <div class="wf-toolbar"><strong>片段 / 说话人标注（按需）</strong><button class="secondary compact" data-wf-action="add-annotation">添加片段标注</button></div>
      ${draft.annotations.map((a, i) => `<div class="wf-annotation"><label>输入<select data-wf-annotation="inputKey" data-row="${i}">${inputs.map((input) => option(input.key, input.label, a.inputKey)).join("")}</select></label>${[["startSeconds", "开始秒数"], ["endSeconds", "结束秒数"], ["speaker", "说话人"]].map(([key, label]) => `<label>${label}<input data-wf-annotation="${key}" data-row="${i}" type="${key === "speaker" ? "text" : "number"}" value="${esc(a[key])}" ${key === "speaker" ? "" : 'min="0" step="0.01"'}></label>`).join("")}<button class="ghost" data-wf-action="remove-annotation" data-row="${i}" aria-label="删除标注 ${i + 1}">删除</button></div>`).join("")}
      <label>上传证据文件<input type="file" data-wf-evidence-file ${this.evidenceUploading ? "disabled" : ""}></label><label>证据文件路径（每行一个，可选）<textarea data-wf-evidence="files" rows="2">${esc(draft.files)}</textarea></label>
      <label class="wf-confirm"><input type="checkbox" data-wf-evidence="confirmed" ${draft.confirmed ? "checked" : ""}>我已实际检查并确认上述记录准确</label><div class="wf-toolbar"><button data-wf-action="submit-evidence" ${this.evidenceUploading || run.recovery?.busy ? "disabled" : ""}>${recovery.mode === "approval" ? "确认通过并继续" : "提交证据并重新分析"}</button><button class="danger" data-wf-action="reject-evidence" ${run.recovery?.busy ? "disabled" : ""}>拒绝并停止</button></div></section>`;
  }
  renderRun(force = false) {
    const el = this.root?.querySelector("[data-wf-run-panel]"); if (!el) return;
    const run = this.run;
    const fingerprint = JSON.stringify([run, this.catalog.runs]);
    if (!force && el.childElementCount > 0 && el.dataset.runId === run?.id && (this.runFingerprint === fingerprint || el.querySelector(".wf-evidence")?.contains(globalThis.document?.activeElement))) return;
    this.runFingerprint = fingerprint;
    const artifacts = (run?.artifacts || []).filter((artifact, index, all) => !artifact.path || all.findIndex((other) => other.path === artifact.path) === index);
    const final = artifacts.filter((artifact) => artifact.role === "final");
    const expectsVideo = run?.deliveryWarning || run?.workflow.nodes.some((node) => node.tool === "local_media_compose");
    const downloads = run ? `<div class="wf-downloads"><h3>${final.length ? run.status === "complete" ? "已验收成品下载" : "待验收成品" : "运行产物下载"}</h3>${run.deliveryWarning ? `<p class="error" role="alert">${esc(run.deliveryWarning)}</p>` : ""}${final.map((artifact) => `<a href="${esc(artifact.downloadUrl)}?preview=1" target="_blank" rel="noopener">打开成片预览</a><a class="wf-final-download" href="${esc(artifact.downloadUrl)}" download>${artifact.mediaType === "video" ? "下载成品视频（MP4）" : `下载成品 · ${esc(artifact.title || artifact.path)}`}</a>`).join("")}${!final.length && expectsVideo ? '<p class="muted">当前没有完整成片。下方为实际登记的中间产物。</p>' : ""}<details ${!final.length ? "open" : ""} data-key="downloads"><summary>中间产物和其他文件（${artifacts.length - final.length}）</summary>${artifacts.filter((artifact) => artifact.role !== "final").map((artifact) => `<a href="${esc(artifact.downloadUrl)}" download>${artifact.mediaType === "video" ? "下载视频片段 · " : "下载 · "}${esc(artifact.title || artifact.path)}</a>`).join("") || '<p>尚无可下载产物</p>'}</details></div>` : "";
    // Preserve opened disclosures while polling and avoid replacing focused controls.
    const opened = new Set([...el.querySelectorAll("details[open]")].map((d) => d.dataset.key));
    const sameRun = el.dataset.runId === run?.id;
    el.innerHTML = `<section class="wf-run"><h3>运行记录 ${run ? `· ${esc(labels[run.status] ?? run.status)}` : ""}</h3>${run ? `<p>${esc(run.name)} · v${run.workflowRevision} · ${esc(run.goal)}</p>${["running", "waiting_input"].includes(run.status) || run.speakerJob?.status === "running" ? `<button class="danger compact" data-wf-action="cancel">${run.speakerJob?.status === "running" ? "停止声音分组" : "停止运行"}</button>` : ""}${run.error ? `<p class="error" role="alert">${esc(run.error)}</p>` : ""}${this.recoveryForm(run)}${run.canResume ? '<button class="secondary compact" data-wf-action="resume">重试只读分析</button><p class="muted">重新校验输入，保留已完成步骤和原始日志。</p>' : ""}<ol class="wf-run-nodes">${topologicalNodes(run.workflow).map((n) => `<li>${esc(n.title)} <span>${esc(labels[run.nodeStates[n.id]] ?? "等待")}</span></li>`).join("")}</ol><details data-key="data"><summary>变量、上下文、历史消息与产物</summary><pre>${esc(JSON.stringify(run.data,null,2))}</pre></details><details data-key="logs"><summary>工具执行日志与模型数据（${run.records.length} 条）</summary><pre>${esc(JSON.stringify(run.records,null,2))}</pre></details>` : '<p class="muted">执行后可查看每个节点的数据、工具调用和中间产物。</p>'}
      ${downloads}<details data-key="history"><summary>历史运行</summary>${this.catalog.runs.length ? this.catalog.runs.map((r) => `<button class="ghost" data-wf-history="${esc(r.id)}">${esc(r.name)} · ${esc(labels[r.status] ?? r.status)} · ${esc(new Date(r.createdAt).toLocaleString())}</button>`).join("") : '<p class="muted">暂无运行记录</p>'}</details></section>`;
    const downloadPanel = el.querySelector(".wf-downloads"); if (downloadPanel) el.querySelector(".wf-run > h3").after(downloadPanel);
    if (run?.deliveryWarning) el.querySelector(".wf-run > h3").textContent = "运行记录 · 步骤已结束，未生成成片";
    el.querySelectorAll("details").forEach((d) => { if (sameRun || d.dataset.key !== "downloads") d.open = opened.has(d.dataset.key); });
    el.dataset.runId = run?.id || "";
  }
}
