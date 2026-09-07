import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, statSync, accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";
import { hasTwoVideoIntent, isVideoComposition } from "../public/workflow-media-model.js";
import { validateWorkflow, topologicalNodes, conditionMatches, resolveData } from "../public/workflow-model.js";
import { workflowInputs, validateInputReferences, referencedInputs } from "../public/workflow-inputs.js";
import { checkWorkflowInputs, requireWorkflowInputs } from "./workflow-inputs.js";
import { isReadonlyNode, failureRecovery } from "./workflow-response.js";
import { speakerGroups, mappedSpeakerAnnotations, annotateTranscript } from "../public/speaker-model.js";
const now = () => new Date().toISOString();
const parse = (row) => row ? JSON.parse(row.body) : null;

export class WorkflowLibrary {
  constructor(file) {
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS globals (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      PRAGMA user_version=1;`);
    for (const run of this.all("runs")) if (run.status === "running" || run.status === "stopping") {
      run.status = "interrupted"; run.error = "服务在执行中退出；请检查已产生的外部效果后重新运行。"; run.finishedAt = now();
      for (const record of run.records ?? []) if (record.status === "running") { record.status = "interrupted"; record.error = run.error; }
      for (const id of Object.keys(run.nodeStates ?? {})) if (run.nodeStates[id] === "running") run.nodeStates[id] = "interrupted";
      this.put("runs", run);
    }
    for (const run of this.all("runs")) if (run.speakerJob?.status === "running") { run.speakerJob.status = "interrupted"; run.speakerJob.error = "服务重启中断了声音分组，可重新分组；原运行未继续。"; this.put("runs", run); }
  }
  all(table) { return this.db.prepare(`SELECT body FROM ${table} ORDER BY rowid DESC`).all().map(parse); }
  get(table, id) { return parse(this.db.prepare(`SELECT body FROM ${table} WHERE id = ?`).get(id)); }
  put(table, item) { this.db.prepare(`INSERT INTO ${table} (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(item.id, JSON.stringify(item)); return item; }
  transaction(fn) { this.db.exec("BEGIN IMMEDIATE"); try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  catalog() { return { workflows: this.all("workflows").filter((w) => !w.deletedAt).map((w) => ({ ...w, inputs: workflowInputs({ ...w, nodes: this.expandedNodes(w) }) })), skills: this.all("skills").filter((s) => !s.deletedAt), runs: this.all("runs").map(({ workflow, data, records, skills, ...r }) => r).slice(0, 100) }; }
  expandedNodes(w) { return [...w.nodes, ...w.nodes.filter((n) => n.type === "skill").flatMap((n) => this.get("skills", n.skillId)?.nodes || [])]; }
  workflow(id) { const w = this.get("workflows", id); if (!w || w.deletedAt) throw new Error("工作流不存在。"); return w; }
  save(input) {
    const expanded = { ...input, nodes: this.expandedNodes(input) };
    const w = validateWorkflow({ ...input, inputs: validateInputReferences(expanded) });
    return this.transaction(() => {
      const old = w.id ? this.workflow(w.id) : null;
      if (old && w.revision !== old.revision) throw new Error("工作流已在其他窗口修改，请重新载入后再编辑。");
      const editable = (item) => JSON.stringify([item.name, item.description ?? "", item.nodes, item.edges, item.triggers, item.variables ?? {}, item.inputs, item.inputDefaults, item.planning]);
      if (old && editable(old) === editable(w)) return old;
      if (this.catalog().workflows.some((item) => item.id !== w.id && item.name === w.name)) throw new Error("工作流名称已存在。");
      for (const n of w.nodes) if (n.type === "skill") { const skill = this.get("skills", n.skillId); if (!skill || skill.deletedAt) throw new Error("Skill 不存在或已撤销。"); }
      return this.put("workflows", { ...w, id: old?.id ?? randomUUID(), schemaVersion: 1, revision: (old?.revision ?? 0) + 1, ownerId: null, createdAt: old?.createdAt ?? now(), updatedAt: now(), undo: old?.undo ?? null });
    });
  }
  duplicate(id) {
    const source = this.workflow(id);
    const names = new Set(this.catalog().workflows.map((workflow) => workflow.name));
    const base = `${source.name} 副本`;
    let name = base;
    for (let index = 2; names.has(name); index++) name = `${base} ${index}`;
    return this.save({
      name,
      description: source.description ?? "",
      planning: structuredClone(source.planning),
      triggers: structuredClone(source.triggers),
      variables: structuredClone(source.variables ?? {}),
      inputs: workflowInputs({ ...source, nodes: this.expandedNodes(source) }),
      nodes: structuredClone(source.nodes),
      edges: structuredClone(source.edges)
    });
  }
  remove(id, revision) {
    return this.transaction(() => {
      const workflow = this.workflow(id);
      if (revision !== workflow.revision) throw new Error("工作流版本已变化，请重新载入后再删除。");
      return this.put("workflows", { ...workflow, revision: workflow.revision + 1, updatedAt: now(), deletedAt: now(), undo: null });
    });
  }
  pack(id, revision, nodeIds, name) {
    return this.transaction(() => {
      const w = this.workflow(id);
      if (revision !== w.revision) throw new Error("工作流版本已变化，请重新载入。");
      const ids = new Set(nodeIds);
      const selected = topologicalNodes(w).filter((n) => ids.has(n.id));
      if (selected.length < 2 || selected.length !== ids.size || selected.some((n) => n.type !== "tool")) throw new Error("请选择至少两个连续的工具调用节点。");
      for (let i = 0; i < selected.length; i++) {
        const n = selected[i];
        if (i > 0 && (w.edges.filter((e) => e.to === n.id).length !== 1 || !w.edges.some((e) => e.from === selected[i - 1].id && e.to === n.id))) throw new Error("只能将无分支的连续工具调用合成为 Skill。");
        if (i < selected.length - 1 && w.edges.filter((e) => e.from === n.id).length !== 1) throw new Error("选区包含分支，无法合成。");
      }
      if (!String(name ?? "").trim()) throw new Error("请输入 Skill 名称。");
      const skill = { id: randomUUID(), name: String(name).trim().slice(0, 100), revision: 1, createdAt: now(), nodes: selected, description: selected.map((n) => n.title).join(" → ") };
      skill.inputs = workflowInputs(w).filter((input) => referencedInputs(selected).includes(input.key));
      skill.detail = `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n按以下顺序调用当前环境可用的工具，保留每一步输出和状态。工具不可用时报告失败。\n\n${selected.map((n, i) => `${i + 1}. ${n.title}\n\n\`\`\`json\n${JSON.stringify({ tool: n.tool, arguments: n.arguments, instructions: n.instructions }, null, 2)}\n\`\`\``).join("\n\n")}`;
      skill.detail += `\n\n必需输入（运行前检查每个文件或文件夹的可访问路径）：\n\n\`\`\`json\n${JSON.stringify(skill.inputs, null, 2)}\n\`\`\`\n`;
      const replacement = { id: randomUUID(), type: "skill", title: skill.name, skillId: skill.id, x: selected[0].x, y: selected[0].y };
      const next = { ...w, nodes: w.nodes.filter((n) => !ids.has(n.id)).concat(replacement), edges: w.edges.filter((e) => !(ids.has(e.from) && ids.has(e.to))).map((e) => ({ ...e, from: ids.has(e.from) ? replacement.id : e.from, to: ids.has(e.to) ? replacement.id : e.to })), revision: w.revision + 1, updatedAt: now(), undo: { skillId: skill.id, before: { ...w, undo: null } } };
      validateWorkflow(next); this.put("skills", skill); this.put("workflows", next);
      return next;
    });
  }
  undoPack(id, revision) {
    return this.transaction(() => {
      const w = this.workflow(id);
      if (!w.undo || revision !== w.revision || w.revision !== w.undo.before.revision + 1) throw new Error("合成后已有编辑，不能覆盖后续修改；请先恢复原版本。");
      if (this.catalog().workflows.some((item) => item.id !== id && item.nodes.some((n) => n.skillId === w.undo.skillId))) throw new Error("该 Skill 已被其他工作流引用，无法撤销。");
      const skill = this.get("skills", w.undo.skillId); skill.deletedAt = now(); this.put("skills", skill);
      return this.put("workflows", { ...w.undo.before, revision: w.revision + 1, updatedAt: now(), undo: null });
    });
  }
  close() { this.db.close(); }
}

export class WorkflowRuntime {
  constructor(library, execute) { this.library = library; this.execute = execute; this.controllers = new Map(); this.jobs = new Map(); }
  inputValues(w, body = {}) { return { goal: String(body.goal ?? ""), ...(w.inputDefaults || {}), ...(body.sourceVideo ? { sourceVideo: body.sourceVideo } : {}), ...(body.targetVideo ? { targetVideo: body.targetVideo } : {}), ...(body.inputs || {}) }; }
  preflight(workflowId, body = {}) {
    const w = this.library.workflow(workflowId);
    return checkWorkflowInputs({ ...w, nodes: this.library.expandedNodes(w) }, this.inputValues(w, body));
  }
  start(workflowId, body, settings) {
    const { goal = "", trigger = "click" } = body;
    const w = this.library.workflow(workflowId);
    if (!w.triggers.includes(trigger)) throw new Error("这个触发器尚未启用。");
    if ([...this.controllers.values()].some((v) => v.workflowId === workflowId)) throw new Error("该工作流正在运行，请等待结束后重试。");
    const skills = Object.fromEntries(w.nodes.filter((n) => n.type === "skill").map((n) => {
      const s = this.library.get("skills", n.skillId); if (!s || s.deletedAt) throw new Error("Skill 不可用。"); return [s.id, s];
    }));
    const nodes = [...w.nodes, ...Object.values(skills).flatMap((skill) => skill.nodes || [])];
    const graph = { ...w, nodes };
    if (w.inputs === undefined && hasTwoVideoIntent(graph) && !isVideoComposition(graph)) throw new Error("旧版双视频任务缺少真正的合成节点，请重新规划输入和步骤后运行。");
    const inputs = { goal: String(goal), ...requireWorkflowInputs(graph, this.inputValues(w, body)) };
    if (isVideoComposition(graph)) {
      for (const node of nodes.filter((node) => node.tool === "local_media_compose")) {
        if (![node.arguments.sourcePath, node.arguments.targetPath].every((value) => /^\{\{\s*input\.[\w-]+\s*\}\}$/.test(value))) continue;
        const source = resolveData(node.arguments.sourcePath, { input: inputs });
        const target = resolveData(node.arguments.targetPath, { input: inputs });
        if (source === target) throw new Error("素材视频和主视频必须是两个不同文件。");
      }
    }
    const run = { id: randomUUID(), workflowId, workflowRevision: w.revision, name: w.name, workspace: settings.workspace, goal: String(goal).trim(), trigger, status: "running", createdAt: now(), workflow: w, skills, records: [], data: { globals: this.library.get("globals", workflowId)?.values ?? w.variables ?? {}, context: {}, messages: [{ role: "user", text: String(goal) }], outputs: {}, artifacts: [], input: inputs }, nodeStates: {} };
    this.library.put("runs", run);
    const controller = new AbortController(); this.controllers.set(run.id, { controller, workflowId });
    const job = this.run(run, settings, controller.signal).finally(() => { this.controllers.delete(run.id); this.jobs.delete(run.id); });
    this.jobs.set(run.id, job);
    return structuredClone(run);
  }
  stop(id) {
    const active = this.controllers.get(id); if (active) { active.controller.abort(); return; }
    const run = this.library.get("runs", id);
    if (run?.status !== "waiting_input") throw new Error("运行已结束。");
    run.status = "cancelled"; run.nodeStates[run.pending.nodeId] = "cancelled"; delete run.pending; run.finishedAt = now(); this.library.put("runs", run);
  }
  recovery(run) {
    const busy = this.controllers.get(run?.id)?.kind === "speakers";
    if (!run || (this.isWorkflowRunning(run.workflowId) && !busy)) return null;
    if (run.status === "waiting_input" && run.pending) return { kind: "needs_input", ...run.pending, busy };
    if (run.status !== "failed") return null;
    if (run.rejectedAt) return { kind: "blocked", reason: "人工审核已拒绝，请修正后新建需求。" };
    const failed = run.workflow.nodes.filter((node) => run.nodeStates[node.id] === "failed");
    if (failed.length !== 1 || !isReadonlyNode(failed[0])) return { kind: "blocked", reason: "请检查已产生的外部效果并修正工作流，再新建需求。" };
    const record = run.records.findLast((item) => item.nodeId === failed[0].id);
    const kind = failureRecovery(run.error, record?.response?.result);
    return { kind, nodeId: failed[0].id, token: record?.id || run.finishedAt, reason: run.error, mode: "evidence", busy };
  }
  diarize(id, body, settings) {
    const run = this.library.get("runs", id), recovery = this.recovery(run);
    if (recovery?.kind !== "needs_input" || recovery.busy || body.token !== recovery.token) throw new Error("本次运行未等待补证或分组正在进行，请刷新状态。");
    const input = run.workflow.inputs.find((input) => input.key === body.inputKey && ["video", "audio", "file"].includes(input.type));
    if (!input) throw new Error("请选择本次运行的音频或视频输入。");
    requireWorkflowInputs(run.workflow, run.data.input);
    const node = { id: `speakers-${randomUUID()}`, type: "tool", tool: "local_speaker_diarize", title: `自动声音分组 · ${input.label}`, arguments: { inputPath: run.data.input[input.key], numSpeakers: body.numSpeakers ?? -1, threshold: body.threshold ?? 0.9 } };
    const record = { id: randomUUID(), nodeId: node.id, title: node.title, status: "running", startedAt: now(), events: [] };
    run.records.push(record); run.speakerJob = { status: "running", inputKey: input.key, startedAt: now() }; this.library.put("runs", run);
    const controller = new AbortController(); this.controllers.set(id, { controller, workflowId: run.workflowId, kind: "speakers" });
    const job = (async () => {
      try {
        const outcome = await this.execute({ run: structuredClone(run), node }, { ...settings, workspace: run.workspace }, controller.signal, (event) => { record.events.push(event); this.library.put("runs", run); });
        controller.signal.throwIfAborted();
        if (outcome.result?.status !== "success" || outcome.result.output?.provenance !== "automatic-voice-clustering") throw new Error(outcome.result?.error || "声音分组失败。");
        record.response = outcome; record.status = "complete";
        run.data.context.speakerDiarizations ??= {}; run.data.context.speakerDiarizations[input.key] = { ...outcome.result.output, id: node.id };
        run.data.artifacts.push(...(outcome.result.artifacts ?? []).map((artifact) => ({ ...artifact, nodeId: node.id })));
        run.speakerJob.status = "complete";
      } catch (error) { record.status = controller.signal.aborted ? "cancelled" : "failed"; record.error = error.message; run.speakerJob.status = record.status; run.speakerJob.error = controller.signal.aborted ? "声音分组已停止，原运行仍等待补证。" : error.message; }
      finally { record.finishedAt = now(); this.library.put("runs", run); this.controllers.delete(id); this.jobs.delete(id); }
    })();
    this.jobs.set(id, job); return structuredClone(run);
  }
  canResume(run) {
    return this.recovery(run)?.kind === "retry";
  }
  resume(id, settings, submission) {
    const run = this.library.get("runs", id);
    const recovery = this.recovery(run);
    if (recovery?.busy) throw new Error("请等待声音分组结束，再试听确认后提交。");
    if (!this.canResume(run) && !(submission && recovery?.kind === "needs_input")) throw new Error("只有失败的只读分析步骤可以继续；缺证据须先补充，其他工具请检查实际执行结果后新建运行。");
    requireWorkflowInputs({ ...run.workflow, nodes: [...run.workflow.nodes, ...Object.values(run.skills).flatMap((skill) => skill.nodes || [])] }, run.data.input);
    if (submission) {
      if (recovery.kind !== "needs_input" || submission.token !== recovery.token) throw new Error("此确认已处理或状态已变化，请刷新运行记录。");
      const note = String(submission.note ?? "").trim();
      if (!note || note.length > 20000 || submission.confirmed !== true) throw new Error("请填写核验依据，并明确确认这是你实际检查的结果。");
      if (!["approve", "reject"].includes(submission.decision)) throw new Error("请选择通过或拒绝。");
      const files = submission.files ?? [];
      if (!Array.isArray(files) || files.length > 10) throw new Error("最多补充 10 个证据文件。");
      const attachments = files.map((file) => {
        if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("证据文件需要可访问的绝对路径。");
        const info = statSync(file); accessSync(file, constants.R_OK);
        if (!info.isFile()) throw new Error("证据路径必须是文件。");
        return { path: file, size: info.size, ...(info.size <= 256000 && /\.(txt|json|csv|srt|vtt|md)$/i.test(file) ? { content: readFileSync(file, "utf8") } : {}) };
      });
      const annotations = submission.annotations ?? [];
      if (!Array.isArray(annotations) || annotations.length > 500) throw new Error("片段标注数量无效。");
      for (const a of annotations) if (!Object.hasOwn(run.data.input, a.inputKey) || !Number.isFinite(a.startSeconds) || !Number.isFinite(a.endSeconds) || a.startSeconds < 0 || a.endSeconds <= a.startSeconds || !String(a.speaker ?? "").trim()) throw new Error("片段标注需要已上传的输入、有效起止秒数和说话人。");
      const groups = speakerGroups(run);
      if (submission.decision === "approve") for (const [key, groupId] of Object.entries(submission.speakerGroupVersions ?? {})) if (groups[key]?.id !== groupId) throw new Error("声音分组已重新生成，请试听当前分组后再提交。");
      const mapping = submission.speakerMappings ?? {};
      for (const key of Object.keys(mapping)) {
        const group = groups[key], info = statSync(run.data.input[key]);
        if (!group || info.size !== group.sourceSize || info.mtimeMs !== group.sourceMtimeMs) throw new Error("素材已变化，请重新运行声音分组。");
        if (submission.speakerGroupVersions?.[key] !== group.id) throw new Error("请确认当前声音分组版本。");
      }
      const expanded = submission.decision === "approve" ? mappedSpeakerAnnotations(groups, mapping) : [];
      const evidence = { id: randomUUID(), nodeId: recovery.nodeId, at: now(), provenance: "user-confirmed", note, decision: submission.decision, attachments, annotations: [...expanded, ...annotations.map(({ inputKey, startSeconds, endSeconds, speaker }) => ({ inputKey, startSeconds, endSeconds, speaker, provenance: "user-segment-correction" }))], speakerMappings: mapping, speakerGroupVersions: submission.speakerGroupVersions ?? {}, input: structuredClone(run.data.input) };
      run.data.context.userEvidence ??= []; run.data.context.userEvidence.push(evidence);
      run.data.artifacts.push({ title: "人工核验记录", content: JSON.stringify(evidence, null, 2), nodeId: recovery.nodeId });
      run.records.push({ id: evidence.id, nodeId: recovery.nodeId, title: "人工核验", status: submission.decision === "approve" ? "complete" : "failed", startedAt: evidence.at, finishedAt: evidence.at, response: evidence });
      if (submission.decision === "reject") {
        run.rejectedAt = now(); run.status = "failed"; run.error = `人工审核未通过：${note}`; run.nodeStates[recovery.nodeId] = "failed"; delete run.pending; run.finishedAt = now(); this.library.put("runs", run); return structuredClone(run);
      }
      if (recovery.mode === "approval") { run.nodeStates[recovery.nodeId] = "complete"; run.data.outputs[recovery.nodeId] = { approved: true, ...evidence }; }
    }
    run.attempts ??= [];
    run.attempts.push({ error: run.error, finishedAt: run.finishedAt, resumedAt: now() });
    run.status = "running"; delete run.error; delete run.finishedAt; delete run.pending;
    this.library.put("runs", run);
    const controller = new AbortController(); this.controllers.set(id, { controller, workflowId: run.workflowId });
    const job = this.run(run, { ...settings, workspace: run.workspace }, controller.signal, true).finally(() => { this.controllers.delete(id); this.jobs.delete(id); });
    this.jobs.set(id, job);
    return structuredClone(run);
  }
  isWorkflowRunning(workflowId) { return [...this.controllers.values()].some((active) => active.workflowId === workflowId); }
  async run(run, settings, signal, resuming = false) {
    const save = () => this.library.put("runs", run);
    try {
      for (const node of topologicalNodes(run.workflow)) {
        signal.throwIfAborted();
        if (resuming && ["complete", "skipped"].includes(run.nodeStates[node.id])) continue;
        const incoming = run.workflow.edges.filter((e) => e.to === node.id);
        const enabled = !incoming.length || incoming.some((e) => run.nodeStates[e.from] === "complete" && (e.when === "always" || String(run.data.outputs[e.from]) === e.when));
        if (!enabled) { run.nodeStates[node.id] = "skipped"; save(); continue; }
        run.nodeStates[node.id] = "running"; save();
        if (node.type === "approval") {
          resolveData(node.arguments ?? {}, run.data);
          run.pending = { nodeId: node.id, token: randomUUID(), reason: node.instructions, mode: "approval" };
          run.status = "waiting_input"; run.nodeStates[node.id] = "waiting_input"; return;
        }
        if (node.type === "condition") run.data.outputs[node.id] = conditionMatches(node.condition, run.data);
        else {
          const parts = node.type === "skill" ? run.skills[node.skillId].nodes : [node];
          for (const part of parts) {
            signal.throwIfAborted();
            requireWorkflowInputs({ ...run.workflow, nodes: [...run.workflow.nodes, ...Object.values(run.skills).flatMap((skill) => skill.nodes || [])] }, run.data.input);
            const record = { id: randomUUID(), nodeId: node.id, partId: part.id, title: part.title, startedAt: now(), status: "running", events: [] };
            run.records.push(record); save();
            const resolved = { ...part, arguments: resolveData(part.arguments ?? {}, run.data) };
            if (isReadonlyNode(part)) resolved.arguments.userEvidence = structuredClone(run.data.context.userEvidence ?? []);
            if (part.tool === "agent_transcript_analyze" && resolved.arguments.transcript?.segments) {
              const sourceId = String(part.arguments?.transcript ?? "").match(/^\{\{\s*outputs\.([\w-]+)\s*\}\}$/)?.[1];
              const sourceNode = run.workflow.nodes.find((item) => item.id === sourceId);
              const mediaPath = resolved.arguments.transcript.inputPath || (sourceNode?.arguments?.inputPath ? resolveData(sourceNode.arguments.inputPath, run.data) : null);
              const key = Object.keys(run.data.input).find((key) => key !== "goal" && run.data.input[key] === mediaPath);
              if (key) resolved.arguments.transcript = annotateTranscript(resolved.arguments.transcript, key, run.data.context.userEvidence ?? []);
            }
            const outcome = await this.execute({ run: structuredClone(run), node: resolved }, settings, signal, (event) => { record.events.push(event); if (record.events.length > 200) record.events.shift(); save(); });
            signal.throwIfAborted();
            record.response = outcome; record.finishedAt = now();
            if (part.type === "review") {
              run.data.artifacts.push({ title: "独立审核报告", nodeId: node.id, content: JSON.stringify(outcome.result, null, 2) });
              save();
            }
            if (outcome.result?.status !== "success") {
              const reason = outcome.result?.error || "节点未返回成功结果。";
              if (isReadonlyNode(node) && failureRecovery(reason, outcome.result) === "needs_input") {
                run.status = "waiting_input"; run.error = reason; run.nodeStates[node.id] = "waiting_input"; record.status = "waiting_input";
                run.pending = { nodeId: node.id, token: randomUUID(), reason, mode: "evidence" }; return;
              }
              throw new Error(reason);
            }
            const result = outcome.result;
            if (part.type === "review" && (result.output?.approved !== true || !Array.isArray(result.output?.checks) || !result.output.checks.length || result.output.checks.some((check) => check.passed !== true || typeof check.criterion !== "string" || !check.criterion.trim() || typeof check.evidence !== "string" || !check.evidence.trim()))) throw new Error("独立审核未通过：每项标准都必须有通过结论和证据，不能继续下游步骤。");
            const statePatch = part.type === "review" ? {} : result.statePatch;
            for (const key of ["globals", "context"]) if (statePatch?.[key] !== undefined && (statePatch[key] === null || typeof statePatch[key] !== "object" || Array.isArray(statePatch[key]))) throw new Error(`Agent 的 ${key} 更新必须是对象。`);
            if (result.artifacts !== undefined && !Array.isArray(result.artifacts)) throw new Error("Agent 的中间产物必须是数组。");
            if (statePatch?.deleteGlobals !== undefined && (!Array.isArray(result.statePatch.deleteGlobals) || result.statePatch.deleteGlobals.some((key) => typeof key !== "string"))) throw new Error("删除变量列表必须是字符串数组。");
            const nextData = structuredClone(run.data);
            for (const key of ["globals", "context"]) nextData[key] = { ...nextData[key], ...(statePatch?.[key] ?? {}) };
            for (const key of statePatch?.deleteGlobals ?? []) delete nextData.globals[key];
            nextData.outputs[part.id] = result.output ?? null; nextData.outputs[node.id] = result.output ?? null;
            nextData.messages.push({ role: "assistant", nodeId: node.id, text: result.summary ?? "", at: now() });
            nextData.artifacts.push(...(part.type === "review" ? [] : result.artifacts ?? []).map((a) => ({ ...a, nodeId: node.id })));
            record.status = "complete"; run.data = nextData;
            this.library.transaction(() => { save(); this.library.put("globals", { id: run.workflowId, values: run.data.globals }); });
          }
        }
        run.nodeStates[node.id] = "complete"; save();
      }
      if (isVideoComposition({ nodes: [...run.workflow.nodes, ...Object.values(run.skills).flatMap((skill) => skill.nodes || [])] })) {
        const finished = Object.values(run.data.outputs).find((output) => output?.verified === true && output?.hasVideo === true && output?.insertedCount > 0);
        if (!finished || !statSync(finished.path, { throwIfNoEntry: false })?.size || !run.data.artifacts.some((artifact) => artifact.role === "final")) throw new Error("没有验收通过的完整成品视频，不能标记工作流完成。");
      }
      run.status = "complete";
    } catch (error) {
      run.status = signal.aborted ? "cancelled" : "failed"; run.error = signal.aborted ? "运行已停止；已完成步骤的数据与产物已保留。" : error.message;
      for (const id of Object.keys(run.nodeStates)) if (run.nodeStates[id] === "running") run.nodeStates[id] = run.status;
      for (const r of run.records) if (r.status === "running") { r.status = run.status; r.error = run.error; r.finishedAt = now(); }
    } finally { if (run.status === "waiting_input") { run.pausedAt = now(); delete run.finishedAt; } else run.finishedAt = now(); save(); }
  }
  async close() { for (const { controller } of this.controllers.values()) controller.abort(); await Promise.allSettled([...this.jobs.values()]); }
}
