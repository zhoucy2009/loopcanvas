import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dependencyStepIds } from "./workflow-context.js";

export const SCHEMA_VERSION = 13;

const MAX_PROJECT_CHECKPOINTS = 40;

function normalizeCheckpoints(input) {
  const checkpoints = Array.isArray(input) ? input : [];
  const seenKeys = new Set();
  return checkpoints.filter((checkpoint) => {
    const reason = String(checkpoint?.reason ?? "").trim();
    if (/^回退到[“\"]/.test(reason)) return false;
    const key = String(checkpoint?.key ?? "").trim();
    if (key && seenKeys.has(key)) return false;
    if (key) seenKeys.add(key);
    return true;
  }).map((checkpoint) => ({
    ...checkpoint,
    reason: String(checkpoint?.reason ?? "未命名检查点"),
    stepId: checkpoint?.stepId || null,
    kind: ["decision", "execution", "manual"].includes(checkpoint?.kind) ? checkpoint.kind : "manual",
    key: String(checkpoint?.key ?? "").trim()
  })).slice(-MAX_PROJECT_CHECKPOINTS);
}

export const CAUTION_LEVELS = ["low", "medium", "high"];

export function normalizeCautionLevel(value, fallback = "medium") {
  return CAUTION_LEVELS.includes(value) ? value : fallback;
}

function inferredDirectionOptions(question) {
  const matches = [...String(question ?? "").matchAll(/(?:方向\s*)?([A-Z])\s*[（(]([^）)]+)[）)]/gi)];
  if (matches.length < 2) return [];
  return matches.slice(0, 5).map((match) => ({
    id: `direction-${match[1].toLowerCase()}`,
    label: `方向 ${match[1].toUpperCase()}`,
    description: match[2].trim()
  }));
}

function normalizeDirectionOptions(input, question = "") {
  const supplied = (Array.isArray(input) ? input : []).slice(0, 5).map((item, index) => {
    if (typeof item === "string") return { id: `direction-${index + 1}`, label: item.trim(), description: "" };
    return {
      id: String(item?.id ?? item?.value ?? `direction-${index + 1}`).trim(),
      label: String(item?.label ?? item?.title ?? item?.value ?? "").trim(),
      description: String(item?.description ?? item?.detail ?? "").trim()
    };
  }).filter((item) => item.id && item.label);
  const candidates = supplied.length >= 2 ? supplied : inferredDirectionOptions(question);
  const seen = new Set();
  return candidates.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

const subprocessBlueprints = {
  decision: [["确认边界", "核对目标、约束与本步骤的决策边界。"], ["比较方案", "只比较当前步骤的候选方案与取舍。"], ["记录决定", "保存选择依据和对后续步骤的影响。"]],
  build: [["读取当前状态", "只读取完成本步骤所需的文件与已确认上下文。"], ["实施局部改动", "在明确边界内完成可独立检查的改动。"], ["验证局部结果", "运行与本步骤直接相关的检查并保存证据。"]],
  integrate: [["确认集成边界", "定位输入、输出和受影响模块。"], ["完成集成", "连接已确认产物并保留既有行为。"], ["检查回归", "验证主流程与直接相关边界。"]],
  verify: [["准备验证", "确认验收条件、样本与验证方法。"], ["执行验证", "运行检查并记录成功与失败证据。"], ["归档结论", "明确阻断问题、偏差和下一步。"]],
  deliver: [["核对交付范围", "确认交付物、入口和运行条件。"], ["整理交付物", "生成可使用的完整交付包与说明。"], ["最终验收", "按原始要求逐项核查并记录结果。"]]
};

function defaultSubprocesses(step = {}) {
  const blueprint = subprocessBlueprints[step.kind] ?? subprocessBlueprints.build;
  return blueprint.map(([title, purpose]) => ({ id: randomUUID(), title, purpose }));
}

function normalizeSubprocesses(step, stepReady = false) {
  const input = Array.isArray(step.subprocesses) ? step.subprocesses : defaultSubprocesses(step);
  return input.map((item, index) => {
    const options = Array.isArray(item.options) ? item.options : [];
    const selectedOptionId = options.some((option) => option.id === item.selectedOptionId)
      ? item.selectedOptionId
      : options.find((option) => option.isRecommended)?.id ?? options[0]?.id ?? null;
    return {
      id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
      title: String(item.title ?? `子进程 ${index + 1}`),
      purpose: String(item.purpose ?? ""),
      options,
      selectedOptionId,
      status: ["locked", "ready", "running", "review", "approved", "error"].includes(item.status)
        ? item.status
        : step.status === "approved" ? "approved" : stepReady && index === 0 ? "ready" : "locked",
      revision: Number.isInteger(item.revision) && item.revision > 0 ? item.revision : 1,
      lastFeedback: item.lastFeedback ?? null,
      lastError: item.lastError ?? null,
      result: item.result ?? null,
      resultHistory: Array.isArray(item.resultHistory) ? item.resultHistory : [],
      contextSnapshot: item.contextSnapshot ?? null,
      debugRecords: Array.isArray(item.debugRecords) ? item.debugRecords : []
    };
  });
}

function activeSubprocess(step) {
  return step.subprocesses?.find((item) => ["review", "running"].includes(item.status))
    ?? step.subprocesses?.find((item) => item.id === step.selectedSubprocessId)
    ?? step.subprocesses?.find((item) => ["ready", "error"].includes(item.status))
    ?? null;
}

export function defaultState(defaultWorkspace) {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProjectId: null,
    settings: {
      agentRuntime: "dsh",
      dshPath: "",
      workspace: defaultWorkspace,
      model: "deepseek-v4-flash",
      reasoningEffort: "off",
      codexModel: "",
      codexReasoningEffort: "",
      smartRouting: false,
      cardPolicy: "high-risk-only",
      cautionLevel: "medium"
    },
    projects: [],
    archivedProjects: [],
    draftAttachments: [],
    pluginStates: {},
    dshPluginStates: {},
    explorationThreads: []
  };
}

export function analyzeDirectives(text) {
  return String(text ?? "").split(/[。；;\n]/).map((clause) => clause.trim()).filter(Boolean).flatMap((clause) => {
    let strength = null;
    if (/不要|禁止|不能/.test(clause)) strength = "forbidden";
    else if (/必须|需要|务必/.test(clause)) strength = "required";
    else if (/我想|我希望|采用|使用|方案/.test(clause)) strength = "preferred";
    return strength ? [{ id: randomUUID(), text: clause, strength, source: "用户原始需求" }] : [];
  });
}

export function deriveProjectWorkspace(defaultWorkspace, title, id) {
  const slug = String(title ?? "project").trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  return path.join(path.resolve(defaultWorkspace), `${slug}-${String(id).slice(0, 8)}`);
}

function humanDirectionDecisionResult(step) {
  return {
    summary: `用户已确认：${step.directionAnswer}`,
    actualChanges: [],
    evidence: [`用户在方向门控中明确选择“${step.directionAnswer}”`],
    deviation: "无",
    rollback: "重新打开该决策节点并选择其他方向。",
    verificationPassed: true,
    blockingIssues: [],
    artifact: null,
    assistantMessage: `方向已确认：${step.directionAnswer}`
  };
}

function normalizeProject(project, defaultWorkspace = "") {
  project.pinnedAt = typeof project.pinnedAt === "string" && project.pinnedAt ? project.pinnedAt : null;
  project.checkpoints = normalizeCheckpoints(project.checkpoints);
  project.attachments ??= [];
  project.directives ??= analyzeDirectives(project.goal);
  project.decisionLog ??= [];
  project.agents ??= [];
  project.isPaused ??= false;
  project.handoff ??= null;
  project.pendingAction ??= null;
  project.finalReview ??= null;
  project.agentRuns = Array.isArray(project.agentRuns) ? project.agentRuns : [];
  if (project.finalReview?.status === "running") project.finalReview = { ...project.finalReview, status: "failed", error: "最终审核在应用退出时中断，可重新触发。" };
  project.learningThreads ??= [];
  project.archivedLearningThreads ??= [];
  project.deletedLearningThreads ??= [];
  project.learningSources ??= [];
  project.learningMaterials = (Array.isArray(project.learningMaterials) ? project.learningMaterials : []).map((material) => {
    material.extractedContent = String(material.extractedContent ?? "").slice(0, 80_000);
    material.extractionStatus = ["success", "failed", "summary-only", "provided"].includes(material.extractionStatus)
      ? material.extractionStatus
      : material.extractedContent ? "provided" : "summary-only";
    material.extractionError = material.extractionStatus === "failed" ? String(material.extractionError ?? "来源读取失败。").slice(0, 500) : null;
    material.extractedAt = typeof material.extractedAt === "string" ? material.extractedAt : null;
    material.extractionAttemptedAt = typeof material.extractionAttemptedAt === "string" ? material.extractionAttemptedAt : null;
    material.extractionMetadata = material.extractionMetadata && typeof material.extractionMetadata === "object" ? material.extractionMetadata : null;
    return material;
  });
  project.learningShelf ??= { pinned: [], archived: [] };
  project.learningShelf.pinned = Array.isArray(project.learningShelf.pinned) ? project.learningShelf.pinned : [];
  project.learningShelf.archived = Array.isArray(project.learningShelf.archived) ? project.learningShelf.archived : [];
  project.explorationThreads ??= [];
  project.executionReferences ??= [];
  project.artifactStepId ??= null;
  project.artifactSubprocessId ??= null;
  project.primaryArtifact ??= project.artifact ? {
    title: project.artifact.title ?? "主交付物",
    kind: project.artifact.kind ?? "text",
    filename: project.artifact.filename ?? "artifact.txt",
    entrypoint: project.artifact.entrypoint ?? project.artifact.filename ?? null,
    acceptanceCriteria: []
  } : null;
  project.executionMode = ["adaptive", "adaptive-single", "adaptive-graph", "continuous", "stepwise"].includes(project.executionMode)
    ? project.executionMode
    : project.steps?.some((step) => Array.isArray(step.subprocesses) && step.subprocesses.length) ? "stepwise" : "continuous";
  project.executionRun ??= null;
  project.parallelPreference = ["ask", "sequential", "parallel"].includes(project.parallelPreference) ? project.parallelPreference : "ask";
  project.selectedStepId ??= project.steps?.[0]?.id ?? null;
  project.workspace ??= defaultWorkspace ? deriveProjectWorkspace(defaultWorkspace, project.title ?? "project", project.id) : null;
  project.steps ??= [];
  const adaptive = project.executionMode.startsWith("adaptive");
  let completedLegacyDirectionDecision = false;
  for (const step of project.steps) {
    step.revision ??= 1;
    step.lastFeedback ??= null;
    step.riskLevel ??= "L1";
    step.impactAnalysis ??= null;
    step.conversation ??= [];
    step.debugRecords = Array.isArray(step.debugRecords) ? step.debugRecords : [];
    step.routing = step.routing && typeof step.routing === "object" ? step.routing : null;
    step.agentReview = step.agentReview && typeof step.agentReview === "object" ? step.agentReview : null;
    step.cautionLevel = normalizeCautionLevel(step.cautionLevel, null);
    step.requiresUserDirection = Boolean(step.requiresUserDirection);
    step.directionQuestion = String(step.directionQuestion ?? "").trim();
    step.directionOptions = normalizeDirectionOptions(step.directionOptions, step.directionQuestion);
    step.selectedDirectionOptionId = step.directionOptions.some((option) => option.id === step.selectedDirectionOptionId) ? step.selectedDirectionOptionId : null;
    step.directionSupplement = String(step.directionSupplement ?? "").trim().slice(0, 4_000);
    step.directionAnswer = String(step.directionAnswer ?? "").trim();
    if (adaptive && step.kind === "decision" && step.requiresUserDirection && step.directionAnswer && ["ready", "error"].includes(step.status) && dependenciesApproved(project, step)) {
      step.status = "approved";
      step.lastError = null;
      step.result = humanDirectionDecisionResult(step);
      completedLegacyDirectionDecision = true;
    }
    step.parallelSafe = Boolean(step.parallelSafe);
    step.writeScope = Array.isArray(step.writeScope) ? step.writeScope.map(String).filter(Boolean).slice(0, 40) : [];
    step.acceptanceCriteria = Array.isArray(step.acceptanceCriteria) ? step.acceptanceCriteria.map(String).filter(Boolean).slice(0, 12) : [];
    step.subprocesses = adaptive ? [] : normalizeSubprocesses(step, ["ready", "running", "review", "stale"].includes(step.status));
    step.selectedSubprocessId ??= activeSubprocess(step)?.id ?? step.subprocesses[0]?.id ?? null;
  }
  if (completedLegacyDirectionDecision && !project.steps.some((step) => step.status === "error")) {
    project.lastError = null;
    project.pendingAction = null;
    if (project.executionRun?.status === "failed") project.executionRun = { ...project.executionRun, status: "ready", error: null, awaitingStepIds: [] };
  }
  return project;
}

function migrateState(decoded, defaultWorkspace) {
  if (!Number.isInteger(decoded.schemaVersion) || decoded.schemaVersion < 1 || decoded.schemaVersion > SCHEMA_VERSION) {
    throw new Error("不支持的状态文件版本");
  }
  if (!Array.isArray(decoded.projects)) throw new Error("项目数据格式无效");
  decoded.schemaVersion = SCHEMA_VERSION;
  decoded.settings = { ...defaultState(defaultWorkspace).settings, ...(decoded.settings ?? {}) };
  decoded.archivedProjects ??= [];
  decoded.draftAttachments ??= [];
  decoded.pluginStates ??= {};
  decoded.dshPluginStates ??= {};
  decoded.explorationThreads ??= [];
  decoded.projects = decoded.projects.map((project) => normalizeProject(project, defaultWorkspace));
  decoded.archivedProjects = decoded.archivedProjects.map((project) => normalizeProject(project, defaultWorkspace));
  return decoded;
}

function restoreStateInPlace(target, snapshot) {
  if (Array.isArray(target) && Array.isArray(snapshot)) {
    const existing = new Map(target.filter((item) => item?.id).map((item) => [item.id, item]));
    target.splice(0, target.length, ...snapshot.map((item) => {
      const original = item?.id ? existing.get(item.id) : null;
      if (original) { restoreStateInPlace(original, item); return original; }
      return structuredClone(item);
    }));
    return;
  }
  for (const key of Object.keys(target)) if (!Object.hasOwn(snapshot, key)) delete target[key];
  for (const [key, value] of Object.entries(snapshot)) {
    if (value && typeof value === "object" && target[key] && typeof target[key] === "object" && Array.isArray(value) === Array.isArray(target[key])) restoreStateInPlace(target[key], value);
    else target[key] = structuredClone(value);
  }
}

export class StateStore {
  constructor(filePath, defaultWorkspace) {
    this.filePath = filePath;
    this.defaultWorkspace = defaultWorkspace;
    this.state = defaultState(defaultWorkspace);
    this.mutationQueue = Promise.resolve();
  }

  async load() {
    try {
      const decoded = JSON.parse(await readFile(this.filePath, "utf8"));
      const needsMigration = decoded.schemaVersion !== SCHEMA_VERSION;
      this.state = migrateState(decoded, this.defaultWorkspace);
      const recoveredInterruptedRun = this.state.projects.some((project) => recoverInterruptedAdaptiveExecution(project));
      if (needsMigration || recoveredInterruptedRun) await this.save();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const recovery = `${this.filePath}.unreadable-${Date.now()}`;
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await rename(this.filePath, recovery).catch(() => {});
      }
      this.state = defaultState(this.defaultWorkspace);
      await this.save();
    }
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  mutate(mutator) {
    const transaction = this.mutationQueue.then(async () => {
      const before = this.snapshot();
      try {
        const result = await mutator(this.state);
        this.state.stateRevision = Number(before.stateRevision ?? 0) + 1;
        await this.save();
        return result;
      } catch (error) {
        restoreStateInPlace(this.state, before);
        throw error;
      }
    });
    this.mutationQueue = transaction.catch(() => {});
    return transaction;
  }

  project(projectId) {
    return this.state.projects.find((project) => project.id === projectId) ?? null;
  }

  async createProject({ title, goal, attachmentIds = [], draft = false }) {
    const normalizedGoal = String(goal ?? "").trim();
    if (!normalizedGoal && !draft) throw new Error("请先输入要完成的目标。");
    const now = new Date().toISOString();
    const projectTitle = String(title ?? "").trim() || normalizedGoal.slice(0, 28);
    const projectId = randomUUID();
    const project = {
      id: projectId,
      title: projectTitle,
      workspace: deriveProjectWorkspace(this.defaultWorkspace, projectTitle, projectId),
      goal: normalizedGoal,
      phase: "intake",
      createdAt: now,
      updatedAt: now,
      steps: [],
      context: normalizedGoal ? [{ id: randomUUID(), at: now, kind: "user", content: normalizedGoal }] : [],
      decisionLog: normalizedGoal ? [{ id: randomUUID(), at: now, stepId: null, kind: "system", title: "收到用户需求", detail: "由 Harness 判断一步直达或真实执行图，并立即开始。" }] : [],
      agents: [],
      attachments: [],
      directives: analyzeDirectives(normalizedGoal),
      checkpoints: [],
      selectedStepId: null,
      isPaused: false,
      handoff: null,
      pendingAction: null,
      finalReview: null,
      agentRuns: [],
      pinnedAt: null,
      learningThreads: [],
      archivedLearningThreads: [],
      deletedLearningThreads: [],
      learningSources: [],
      learningMaterials: [],
      learningShelf: { pinned: [], archived: [] },
      explorationThreads: [],
      executionReferences: [],
      executionMode: "adaptive",
      executionRun: null,
      parallelPreference: "ask",
      primaryArtifact: null,
      artifact: null,
      lastError: null
    };
    await mkdir(project.workspace, { recursive: true });
    await this.mutate((state) => {
      const selected = new Set(Array.isArray(attachmentIds) ? attachmentIds : []);
      project.attachments = state.draftAttachments.filter((item) => selected.has(item.id));
      state.draftAttachments = state.draftAttachments.filter((item) => !selected.has(item.id));
      state.projects.unshift(project);
      state.activeProjectId = project.id;
    });
    return structuredClone(project);
  }

  async renameProject(projectId, title) {
    const normalized = String(title ?? "").trim();
    if (!normalized) throw new Error("项目标题不能为空。");
    await this.mutate((state) => {
      const project = this.project(projectId);
      if (!project) throw new Error("项目不存在。");
      project.title = normalized;
      project.updatedAt = new Date().toISOString();
    });
    return structuredClone(this.project(projectId));
  }

  async updateProjectWorkspace(projectId, workspace) {
    const trimmed = String(workspace ?? "").trim();
    await this.mutate((state) => {
      const project = this.project(projectId);
      if (!project) throw new Error("项目不存在。");
      project.workspace = trimmed || deriveProjectWorkspace(this.defaultWorkspace, project.title, project.id);
      project.updatedAt = new Date().toISOString();
    });
    return structuredClone(this.project(projectId));
  }

  async setActiveProject(projectId) {
    if (!this.project(projectId)) throw new Error("项目不存在。");
    await this.mutate((state) => { state.activeProjectId = projectId; });
  }

  async setProjectPinned(projectId, pinned) {
    await this.mutate(() => {
      const project = this.project(projectId);
      if (!project) throw new Error("项目不存在。");
      const now = new Date().toISOString();
      project.pinnedAt = pinned ? now : null;
      project.updatedAt = now;
    });
    return structuredClone(this.project(projectId));
  }

  async updateSettings(input) {
    const allowedRuntimes = new Set(["dsh", "codex"]);
    const allowedModels = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);
    const allowedEfforts = new Set(["off", "high", "max"]);
    await this.mutate((state) => {
      if (allowedRuntimes.has(input.agentRuntime)) state.settings.agentRuntime = input.agentRuntime;
      state.settings.dshPath = String(input.dshPath ?? "").trim();
      state.settings.workspace = String(input.workspace ?? "").trim() || this.defaultWorkspace;
      if (allowedModels.has(input.model)) state.settings.model = input.model;
      if (allowedEfforts.has(input.reasoningEffort)) state.settings.reasoningEffort = input.reasoningEffort;
      if (CAUTION_LEVELS.includes(input.cautionLevel)) state.settings.cautionLevel = input.cautionLevel;
      const codexModel = String(input.codexModel ?? state.settings.codexModel ?? "").trim();
      const codexReasoningEffort = String(input.codexReasoningEffort ?? state.settings.codexReasoningEffort ?? "").trim();
      if (typeof input.smartRouting === "boolean") state.settings.smartRouting = input.smartRouting;
      if (!codexModel || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(codexModel)) state.settings.codexModel = codexModel;
      if (!codexReasoningEffort || /^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(codexReasoningEffort)) state.settings.codexReasoningEffort = codexReasoningEffort;
    });
    return structuredClone(this.state.settings);
  }

  async archiveProject(projectId) {
    await this.mutate((state) => {
      const index = state.projects.findIndex((project) => project.id === projectId);
      if (index < 0) throw new Error("项目不存在。");
      const [project] = state.projects.splice(index, 1);
      project.pinnedAt = null;
      project.archivedAt = new Date().toISOString();
      state.archivedProjects.push(project);
      if (state.activeProjectId === projectId) state.activeProjectId = state.projects.find((item) => item.pinnedAt)?.id ?? state.projects[0]?.id ?? null;
    });
  }

  async restoreArchivedProject(projectId = null) {
    let restored = null;
    await this.mutate((state) => {
      const index = projectId == null
        ? state.archivedProjects.length - 1
        : state.archivedProjects.findIndex((project) => project.id === projectId);
      if (index < 0) throw new Error("没有可恢复的归档项目。");
      [restored] = state.archivedProjects.splice(index, 1);
      delete restored.archivedAt;
      restored.pinnedAt = null;
      state.projects.unshift(restored);
      state.activeProjectId = restored.id;
    });
    return structuredClone(restored);
  }

  async restoreLatestArchivedProject() {
    return this.restoreArchivedProject();
  }

  async createCheckpoint(projectId, reason = "手动检查点", { stepId = null, kind = "manual", key = "" } = {}) {
    await this.mutate(() => {
      const project = this.project(projectId);
      if (!project) throw new Error("项目不存在。");
      const checkpointKey = String(key ?? "").trim();
      if (checkpointKey && project.checkpoints.some((checkpoint) => checkpoint.key === checkpointKey)) return;
      project.checkpoints.push({
        id: randomUUID(),
        at: new Date().toISOString(),
        reason,
        stepId: stepId || null,
        kind: ["decision", "execution"].includes(kind) ? kind : "manual",
        key: checkpointKey,
        snapshot: projectSnapshot(project)
      });
      if (project.checkpoints.length > MAX_PROJECT_CHECKPOINTS) project.checkpoints.splice(0, project.checkpoints.length - MAX_PROJECT_CHECKPOINTS);
    });
  }

  async restoreCheckpoint(projectId, checkpointId = null) {
    await this.mutate((state) => {
      const index = state.projects.findIndex((project) => project.id === projectId);
      if (index < 0) throw new Error("项目不存在。");
      const project = state.projects[index];
      const checkpoint = checkpointId
        ? project.checkpoints.find((item) => item.id === checkpointId)
        : project.checkpoints.at(-1);
      if (!checkpoint) throw new Error("没有可恢复的检查点。");
      const checkpoints = [...project.checkpoints];
      const restored = normalizeProject({ ...structuredClone(checkpoint.snapshot), checkpoints }, this.defaultWorkspace);
      restored.isPaused = true;
      restored.pendingAction = null;
      if (restored.executionRun?.status === "running") restored.executionRun = { ...restored.executionRun, status: "ready", error: null };
      for (const step of restored.steps.filter((item) => item.status === "running")) step.status = "ready";
      state.projects[index] = restored;
    });
  }

  async restoreLatestCheckpoint(projectId) {
    return this.restoreCheckpoint(projectId);
  }
}

function projectSnapshot(project) {
  const snapshot = structuredClone(project);
  snapshot.checkpoints = [];
  snapshot.handoff = null;
  return snapshot;
}

export function appendContext(project, kind, content, stepId = null, author = "系统") {
  project.context ??= [];
  const entry = { id: randomUUID(), at: new Date().toISOString(), kind, stepId, author, content };
  project.context.push(entry);
  return entry;
}

export function appendLog(project, kind, title, detail, stepId = null) {
  project.decisionLog ??= [];
  project.decisionLog.push({ id: randomUUID(), at: new Date().toISOString(), kind, stepId, title, detail });
}

export function applyPlan(project, steps, assistantMessage = "", primaryArtifact = null) {
  const now = new Date().toISOString();
  project.steps = steps.map((step, index) => ({
    ...step,
    status: index === 0 || step.dependencies.length === 0 ? "ready" : "locked",
    selectedOptionId: (step.options ?? []).find((option) => option.isRecommended)?.id ?? step.options?.[0]?.id ?? null,
    result: null,
    revision: 1,
    lastFeedback: null,
    riskLevel: step.riskLevel ?? "L1",
    impactAnalysis: step.impactAnalysis ?? null,
    conversation: [],
    debugRecords: [],
    subprocesses: normalizeSubprocesses(step, index === 0 || step.dependencies.length === 0)
  }));
  for (const step of project.steps) step.selectedSubprocessId = activeSubprocess(step)?.id ?? step.subprocesses[0]?.id ?? null;
  project.selectedStepId = project.steps.find((step) => step.status === "ready")?.id ?? project.steps[0]?.id ?? null;
  if (primaryArtifact) {
    project.primaryArtifact = { ...primaryArtifact, projectRoot: project.workspace };
    project.executionMode = "continuous";
    project.executionRun = null;
  }
  project.agents = [{ id: randomUUID(), name: "端到端规划对话", focus: "生成完整计划", status: "complete", progress: 1, notes: [assistantMessage || "计划已生成"] }];
  project.phase = "workspace";
  project.updatedAt = now;
  project.lastError = null;
  appendContext(project, "plan", assistantMessage || `已生成 ${steps.length} 个执行步骤。`, null, "DeepSeek Harness");
  appendLog(project, "system", "成果路线已导入", `共 ${steps.length} 个里程碑；主交付物：${project.primaryArtifact?.filename ?? "待确定"}。`);
}

export function applyAdaptiveRoute(project, route) {
  const now = new Date().toISOString();
  const executionShape = route.executionShape === "single" ? "single" : "graph";
  project.steps = route.steps.map((step, index) => ({
    ...step,
    options: [],
    status: index === 0 || step.dependencies.length === 0 ? "ready" : "locked",
    selectedOptionId: null,
    result: null,
    revision: 1,
    lastFeedback: null,
    conversation: [],
    debugRecords: [],
    subprocesses: [],
    selectedSubprocessId: null,
    routing: null,
    agentReview: null,
    cautionLevel: normalizeCautionLevel(step.cautionLevel, null),
    requiresUserDirection: Boolean(step.requiresUserDirection),
    directionQuestion: String(step.directionQuestion ?? "").trim(),
    directionOptions: normalizeDirectionOptions(step.directionOptions, step.directionQuestion),
    selectedDirectionOptionId: null,
    directionSupplement: "",
    directionAnswer: String(step.directionAnswer ?? "").trim(),
    parallelSafe: Boolean(step.parallelSafe),
    writeScope: Array.isArray(step.writeScope) ? step.writeScope.map(String).filter(Boolean).slice(0, 40) : [],
    acceptanceCriteria: Array.isArray(step.acceptanceCriteria) ? step.acceptanceCriteria.map(String).filter(Boolean).slice(0, 12) : []
  }));
  project.primaryArtifact = { ...route.primaryArtifact, projectRoot: project.workspace };
  project.executionMode = executionShape === "single" ? "adaptive-single" : "adaptive-graph";
  project.executionRun = executionShape === "single"
    ? { status: "running", startedAt: now, completedAt: null, error: null }
    : { status: "ready", startedAt: null, completedAt: null, error: null };
  project.parallelPreference = "ask";
  project.finalReview = null;
  project.selectedStepId = project.steps[0]?.id ?? null;
  project.agents = [{ id: randomUUID(), name: executionShape === "single" ? "一步交付 Agent" : "自适应执行 Agent", focus: executionShape === "single" ? "判断并直接交付" : "判断真实执行节点与依赖", status: executionShape === "single" ? "running" : "complete", progress: executionShape === "single" ? 0.5 : 1, notes: [route.assistantMessage || "已判断任务执行形态"] }];
  project.phase = executionShape === "single" ? "running" : "workspace";
  project.updatedAt = now;
  project.lastError = null;
  appendContext(project, "route", route.assistantMessage || (executionShape === "single" ? "任务可一步完成。" : `Harness 给出 ${project.steps.length} 个真实执行节点。`), null, "Harness");
  appendLog(project, "system", executionShape === "single" ? "选择一步直达" : "生成自适应执行图", executionShape === "single" ? "同一次调用直接执行、验证并交付。" : `共 ${project.steps.length} 个节点；未生成步骤备选方案。`);
}

export function setStepCaution(project, stepId, cautionLevel) {
  const step = project.steps.find((item) => item.id === stepId);
  if (!step) throw new Error("步骤不存在。");
  step.cautionLevel = cautionLevel === "inherit" ? null : normalizeCautionLevel(cautionLevel, null);
  project.updatedAt = new Date().toISOString();
  appendLog(project, "decision", "更新节点谨慎等级", `${step.title}：${step.cautionLevel ?? "继承全局"}`, step.id);
}

export function answerStepDirection(project, stepId, selection, supplemental = "") {
  const step = project.steps.find((item) => item.id === stepId);
  if (!step) throw new Error("步骤不存在。");
  if (!step.requiresUserDirection || !step.directionQuestion) throw new Error("这个节点不需要方向确认。");
  const payload = selection && typeof selection === "object" ? selection : { answer: selection, supplemental };
  const options = normalizeDirectionOptions(step.directionOptions, step.directionQuestion);
  const supplement = String(payload.supplemental ?? "").trim().slice(0, 4_000);
  if (options.length) {
    const option = options.find((item) => item.id === String(payload.optionId ?? ""));
    if (!option) throw new Error("请先选择一个执行方向。");
    step.directionOptions = options;
    step.selectedDirectionOptionId = option.id;
    step.directionSupplement = supplement;
    step.directionAnswer = `${option.label}${option.description ? `：${option.description}` : ""}${supplement ? `；额外补充：${supplement}` : ""}`.slice(0, 8_000);
  } else {
    const normalized = String(payload.answer ?? "").trim();
    if (!normalized) throw new Error("请明确回复方向后再继续。");
    step.selectedDirectionOptionId = null;
    step.directionSupplement = supplement;
    step.directionAnswer = normalized.slice(0, 8_000);
  }
  if (step.kind === "decision" && dependenciesApproved(project, step)) {
    step.status = "approved";
    step.lastError = null;
    step.result = humanDirectionDecisionResult(step);
  } else {
    step.status = dependenciesApproved(project, step) ? "ready" : "locked";
  }
  project.updatedAt = new Date().toISOString();
  appendContext(project, "decision", `${step.title}：${step.directionAnswer}`, step.id, "用户");
  appendLog(project, "decision", "用户确认目标方向", step.directionAnswer, step.id);
}

export function readyAdaptiveSteps(project) {
  recomputeAvailability(project);
  return project.steps.filter((step) => ["ready", "error"].includes(step.status) && dependenciesApproved(project, step));
}

export function approveStep(project, stepId) {
  const step = project.steps.find((item) => item.id === stepId);
  if (!step || step.status !== "review") throw new Error("当前步骤不在待验收状态。");
  if (step.kind === "verify" && (step.result?.verificationPassed !== true || step.result?.blockingIssues?.length)) {
    throw new Error("验证步骤必须明确通过且没有阻断问题，才能验收。");
  }
  const subprocess = step.subprocesses?.find((item) => item.status === "review");
  if (subprocess) {
    subprocess.status = "approved";
    subprocess.lastError = null;
    step.result = subprocess.result;
    const next = step.subprocesses.find((item) => item.status !== "approved");
    if (next) {
      next.status = "ready";
      step.selectedSubprocessId = next.id;
      step.status = "ready";
      const now = new Date().toISOString();
      appendContext(project, "decision", `接受「${step.title} / ${subprocess.title}」第 ${subprocess.revision} 版结果。`, step.id, "用户");
      appendLog(project, "decision", "子进程已验收", `「${subprocess.title}」已锁定；下一子进程「${next.title}」已解锁。`, step.id);
      project.updatedAt = now;
      return;
    }
  }
  step.status = "approved";
  const now = new Date().toISOString();
  appendContext(project, "decision", `接受「${step.title}」第 ${step.revision} 版结果。`, step.id, "用户");
  appendLog(project, "decision", "用户接受结果", `第 ${step.revision} 版已锁定。`, step.id);
  recomputeAvailability(project);
  if (project.steps.length > 0 && project.steps.every((item) => item.status === "approved")) {
    project.phase = "complete";
  }
  project.updatedAt = now;
}

export function rejectStep(project, stepId, feedback, targetSubprocessId = null) {
  const step = project.steps.find((item) => item.id === stepId);
  if (!step || step.status !== "review") throw new Error("当前步骤不在待验收状态。");
  const normalized = String(feedback ?? "").trim();
  if (!normalized) throw new Error("请说明需要修改的地方。");
  const subprocess = targetSubprocessId
    ? step.subprocesses?.find((item) => item.id === targetSubprocessId && item.status === "review")
    : step.subprocesses?.find((item) => item.status === "review");
  if (targetSubprocessId && !subprocess) throw new Error("调试记录对应的子进程不在待验收状态。");
  if (subprocess) {
    if (subprocess.result) subprocess.resultHistory.push({ revision: subprocess.revision, result: subprocess.result, at: new Date().toISOString() });
    subprocess.status = "ready";
    subprocess.revision += 1;
    subprocess.lastFeedback = normalized;
    subprocess.result = null;
    subprocess.lastError = null;
    const position = step.subprocesses.indexOf(subprocess);
    for (const later of step.subprocesses.slice(position + 1)) if (later.status !== "approved") later.status = "locked";
    step.selectedSubprocessId = subprocess.id;
    step.status = "ready";
    step.result = null;
    markDescendantsStale(project, stepId);
    const now = new Date().toISOString();
    appendContext(project, "correction", `${step.title} / ${subprocess.title}：${normalized}`, step.id, "用户");
    appendLog(project, "revision", "子进程要求修改", `「${subprocess.title}」进入第 ${subprocess.revision} 版：${normalized}`, step.id);
    recomputeAvailability(project);
    project.updatedAt = now;
    return;
  }
  step.status = "ready";
  step.revision += 1;
  step.lastFeedback = normalized;
  step.result = null;
  markDescendantsStale(project, stepId);
  const now = new Date().toISOString();
  appendContext(project, "correction", `${step.title}：${normalized}`, step.id, "用户");
  appendLog(project, "revision", "用户要求修改", normalized, step.id);
  recomputeAvailability(project);
  project.updatedAt = now;
}

export function reopenForRepair(project, stepId, feedback = "", targetSubprocessId = null, findings = []) {
  const step = project.steps.find((item) => item.id === stepId);
  if (!step || (!["approved", "review"].includes(step.status) && !(step.status === "error" && step.reviewPending && step.result))) throw new Error("只有已通过或待审核步骤可以进入 Agent 返修。");
  const normalizedFindings = (Array.isArray(findings) ? findings : []).map((item) => ({
    severity: String(item?.severity ?? "major"),
    criterion: String(item?.criterion ?? "").trim(),
    evidence: String(item?.evidence ?? "").trim(),
    repairInstruction: String(item?.repairInstruction ?? item?.repair_instruction ?? "").trim()
  })).filter((item) => item.criterion || item.evidence || item.repairInstruction);
  step.revision += 1;
  step.status = "ready";
  step.result = null;
  step.agentReview = null;
  step.reviewPending = false;
  step.routing = null;
  step.lastError = null;
  step.lastFeedback = String(feedback).trim() || "用户重新打开已通过步骤。";
  step.repairFindings = normalizedFindings;
  const resetsDirection = step.kind === "decision" && step.requiresUserDirection;
  if (resetsDirection) {
    step.selectedDirectionOptionId = null;
    step.directionSupplement = "";
    step.directionAnswer = "";
  }
  const subprocess = targetSubprocessId
    ? step.subprocesses?.find((item) => item.id === targetSubprocessId && item.status === "approved")
    : [...(step.subprocesses ?? [])].reverse().find((item) => item.status === "approved");
  if (targetSubprocessId && !subprocess) throw new Error("调试记录对应的子进程尚未验收，不能重新打开。");
  if (subprocess) {
    subprocess.status = "ready";
    subprocess.revision += 1;
    subprocess.lastFeedback = step.lastFeedback;
    if (subprocess.result) subprocess.resultHistory.push({ revision: subprocess.revision - 1, result: subprocess.result, at: new Date().toISOString() });
    subprocess.result = null;
    step.selectedSubprocessId = subprocess.id;
  }
  if (project.executionMode?.startsWith("adaptive")) invalidateAdaptiveDescendants(project, stepId);
  else markDescendantsStale(project, stepId);
  if (project.executionMode?.startsWith("adaptive")) {
    project.artifact = null;
    project.artifactStepId = null;
    project.artifactSubprocessId = null;
    project.phase = "workspace";
    project.executionRun = { status: resetsDirection ? "awaiting_direction" : "ready", startedAt: null, completedAt: null, error: null, awaitingStepIds: resetsDirection ? [step.id] : [] };
    project.pendingAction = null;
    project.lastError = null;
  }
  appendContext(project, "correction", `重新打开「${step.title}」：${step.lastFeedback}`, step.id, "用户");
  appendLog(project, "revision", "重新打开已确认步骤", "受影响的下游已标记为需复核。", step.id);
  recomputeAvailability(project);
}

export function reopenStep(project, stepId, feedback = "", targetSubprocessId = null) {
  return reopenForRepair(project, stepId, feedback, targetSubprocessId);
}

export function rollbackStep(project, stepId) {
  const step = project.steps.find((item) => item.id === stepId);
  if (!step || step.status === "locked") throw new Error("当前步骤不能回退。");
  step.revision += 1;
  step.selectedOptionId = project.executionMode?.startsWith("adaptive") ? step.selectedOptionId : null;
  step.result = null;
  step.lastFeedback = project.executionMode?.startsWith("adaptive") ? "本节点执行状态已回退；工作目录文件需按结果中的回滚说明恢复。" : "本步骤已回退到未选择方案状态。";
  step.status = dependenciesApproved(project, step) ? "ready" : "locked";
  for (const [index, subprocess] of (step.subprocesses ?? []).entries()) {
    subprocess.status = step.status === "ready" && index === 0 ? "ready" : "locked";
    subprocess.selectedOptionId = null;
    subprocess.result = null;
    subprocess.lastError = null;
  }
  step.selectedSubprocessId = step.subprocesses?.[0]?.id ?? null;
  markDescendantsStale(project, stepId);
  if (project.executionMode?.startsWith("adaptive")) {
    for (const descendantId of downstreamIds(project, stepId)) {
      const descendant = project.steps.find((item) => item.id === descendantId);
      if (!descendant) continue;
      descendant.status = "locked";
      descendant.result = null;
      descendant.lastError = null;
    }
    project.artifact = null;
    project.artifactStepId = null;
    project.artifactSubprocessId = null;
    project.phase = "workspace";
    project.executionRun = { status: "ready", startedAt: null, completedAt: null, error: null, awaitingStepIds: [] };
    project.pendingAction = null;
    project.lastError = null;
  }
  appendContext(project, "correction", project.executionMode?.startsWith("adaptive") ? `回退「${step.title}」的执行状态；磁盘文件未自动恢复。` : `回退「${step.title}」到未选择方案状态。`, step.id, "用户");
  appendLog(project, "revision", project.executionMode?.startsWith("adaptive") ? "回退节点执行状态" : "回退当前步骤", project.executionMode?.startsWith("adaptive") ? "目标、节点依赖和决策历史仍然保留；文件需按结果中的回滚说明恢复。" : "目标、计划和决策历史仍然保留。", step.id);
  recomputeAvailability(project);
}

export function recoverInterruptedAdaptiveExecution(project) {
  if (!project?.executionMode?.startsWith("adaptive")) return false;
  const runningSteps = project.steps.filter((step) => step.status === "running");
  const executionWasRunning = project.executionRun?.status === "running";
  const pendingWasRunning = project.pendingAction?.status === "running";
  if (!runningSteps.length && !executionWasRunning && !pendingWasRunning) return false;
  for (const step of runningSteps) {
    step.status = dependenciesApproved(project, step) ? "ready" : "locked";
    step.lastError = null;
  }
  project.executionRun = { ...(project.executionRun ?? {}), status: "ready", completedAt: null, error: null, awaitingStepIds: [] };
  project.pendingAction = null;
  project.lastError = null;
  project.updatedAt = new Date().toISOString();
  appendLog(project, "system", "恢复中断的节点状态", "服务重新加载后未发现活动 Agent 调用；原执行中节点已恢复为待执行。", runningSteps[0]?.id ?? null);
  recomputeAvailability(project);
  return true;
}

export function moveStep(project, stepId, beforeStepId) {
  const source = project.steps.findIndex((step) => step.id === stepId);
  const target = beforeStepId == null ? project.steps.length : project.steps.findIndex((step) => step.id === beforeStepId);
  if (source < 0 || target < 0 || source === target) throw new Error("步骤移动目标无效。");
  const candidate = [...project.steps];
  const [item] = candidate.splice(source, 1);
  const insertion = beforeStepId == null ? candidate.length : (source < target ? target - 1 : target);
  candidate.splice(insertion, 0, item);
  const positions = new Map(candidate.map((step, index) => [step.id, index]));
  const valid = candidate.every((step) => step.dependencies.every((dependency) => (positions.get(dependency) ?? -1) < positions.get(step.id)));
  if (!valid) throw new Error("这次移动会破坏步骤依赖，顺序保持不变。");
  project.steps = candidate;
  appendLog(project, "system", "调整可互换步骤顺序", "新排列仍满足全部依赖。", stepId);
}

export function returnVerificationToRepair(project, stepId, feedback = "") {
  const verification = project.steps.find((step) => step.id === stepId);
  if (!verification || verification.kind !== "verify" || !["review", "error"].includes(verification.status)) throw new Error("当前步骤不是待验收或未通过的验证步骤。");
  const ancestors = dependencyStepIds(project, verification);
  const repair = [...project.steps].reverse().find((step) => ancestors.has(step.id) && ["build", "integrate", "deliver"].includes(step.kind) && step.status === "approved");
  if (!repair) throw new Error("没有找到可返回修复的上游产物步骤。");
  const issues = [...(verification.result?.blockingIssues ?? []), String(feedback).trim()].filter(Boolean).join("；");
  reopenStep(project, repair.id, `验证未通过：${issues || "请修复后重新验证"}`);
  project.lastError = null;
  project.pendingAction = null;
  if (project.executionRun) project.executionRun = { ...project.executionRun, status: "ready", error: null, completedAt: null };
  project.selectedStepId = repair.id;
}

export function recomputeAvailability(project) {
  for (const step of project.steps) {
    if (["running", "review", "approved"].includes(step.status)) continue;
    if (step.status === "stale") continue;
    step.status = dependenciesApproved(project, step) ? "ready" : "locked";
    if (step.status === "ready" && step.subprocesses?.length && !step.subprocesses.some((item) => ["ready", "review", "running", "error"].includes(item.status))) {
      const next = step.subprocesses.find((item) => item.status !== "approved");
      if (next) { next.status = "ready"; step.selectedSubprocessId = next.id; }
    }
  }
}

function dependenciesApproved(project, step) {
  return step.dependencies.every((dependencyId) => project.steps.some((item) => item.id === dependencyId && item.status === "approved"));
}

export function executionReadiness(project, stepId, subprocessId = null) {
  const step = project.steps.find((item) => item.id === stepId);
  if (!step) return { allowed: false, title: "无法执行", reasons: ["步骤不存在或计划已经更新。"], missingStepIds: [], missingSubprocessIds: [] };
  const subprocess = step.subprocesses?.length
    ? step.subprocesses.find((item) => item.id === subprocessId)
      ?? step.subprocesses.find((item) => item.id === step.selectedSubprocessId)
      ?? step.subprocesses[0]
    : null;
  const reasons = [];
  const missingSteps = (step.dependencies ?? []).map((dependencyId) => project.steps.find((item) => item.id === dependencyId))
    .filter((item) => !item || item.status !== "approved");
  const subprocessIndex = subprocess ? step.subprocesses.findIndex((item) => item.id === subprocess.id) : -1;
  const missingSubprocesses = subprocessIndex > 0
    ? step.subprocesses.slice(0, subprocessIndex).filter((item) => item.status !== "approved")
    : [];

  if (project.isPaused) reasons.push("任务已暂停，请先继续任务。");
  if (project.executionMode === "continuous" && project.primaryArtifact && !project.artifact) {
    reasons.push("连续项目尚未登记主交付物，请先完成或重新连续执行项目。");
  }
  const optionOwner = subprocess ?? step;
  const availableOptions = Array.isArray(optionOwner.options) ? optionOwner.options : [];
  const selectedOption = availableOptions.find((option) => option.id === optionOwner.selectedOptionId);
  const requiresPlanRefresh = Boolean(subprocess && availableOptions.length === 0);
  const adaptiveWithoutOptions = project.executionMode?.startsWith("adaptive") && !subprocess && availableOptions.length === 0;
  if (requiresPlanRefresh) reasons.push("这个子进程没有独立方案。它来自旧版计划结构；为避免误用其他子进程的方案，请返回需求输入并重新生成执行路线。");
  else if (!selectedOption && !adaptiveWithoutOptions) reasons.push(`请先为${subprocess ? "当前子进程" : "这个步骤"}选择一个方案。`);
  if (missingSteps.length) reasons.push(`缺少已验收的前置步骤：${missingSteps.map((item) => item?.title ?? "已删除步骤").join("、")}。`);
  if (missingSubprocesses.length) reasons.push(`现在执行会缺少本步骤的前序产物，结果质量可能不稳定。请先完成并验收：${missingSubprocesses.map((item) => item.title).join("、")}。`);
  if (subprocess) {
    if (subprocess.status === "running") reasons.push("这个子进程正在执行，请等待当前调用结束。");
    if (subprocess.status === "review") reasons.push("这个子进程正在等待验收；请先接受结果或提出修改意见。");
    if (subprocess.status === "approved") reasons.push("这个子进程已经验收；如需修改，请先重新打开对应大步骤。");
  } else {
    if (step.status === "running") reasons.push("这个步骤正在执行，请等待当前调用结束。");
    if (step.status === "review") reasons.push("这个步骤正在等待验收；请先接受结果或提出修改意见。");
    if (step.status === "approved") reasons.push("这个步骤已经验收；如需修改，请先重新打开它。");
  }
  const title = requiresPlanRefresh
    ? "需要刷新执行路线"
    : project.isPaused
      ? "任务已暂停"
      : [step.status, subprocess?.status].includes("running")
        ? "当前步骤正在执行"
        : [step.status, subprocess?.status].includes("review")
          ? "当前结果等待验收"
          : [step.status, subprocess?.status].includes("approved")
            ? "当前步骤已经验收"
            : missingSteps.length || missingSubprocesses.length
              ? "建议先完成前面的步骤"
              : !selectedOption && !adaptiveWithoutOptions
                ? "需要选择执行方案"
                : reasons.length
                  ? "暂时不能执行"
                  : "前置检查通过";
  return {
    allowed: reasons.length === 0,
    title,
    reasons,
    requiresPlanRefresh,
    stepId: step.id,
    subprocessId: subprocess?.id ?? null,
    missingStepIds: missingSteps.map((item) => item?.id).filter(Boolean),
    missingSubprocessIds: missingSubprocesses.map((item) => item.id)
  };
}

function downstreamIds(project, ancestorId) {
  const found = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of project.steps) {
      if (!found.has(step.id) && step.dependencies.some((dependency) => dependency === ancestorId || found.has(dependency))) {
        found.add(step.id); changed = true;
      }
    }
  }
  return found;
}

function markDescendantsStale(project, stepId) {
  for (const id of downstreamIds(project, stepId)) {
    const step = project.steps.find((item) => item.id === id);
    if (step && step.status === "approved") step.status = "stale";
    else if (step && !["running", "review"].includes(step.status)) step.status = "locked";
  }
}

function invalidateAdaptiveDescendants(project, stepId) {
  for (const id of downstreamIds(project, stepId)) {
    const step = project.steps.find((item) => item.id === id);
    if (!step) continue;
    step.status = "locked";
    step.result = null;
    step.agentReview = null;
    step.routing = null;
    step.repairFindings = [];
    step.lastError = null;
  }
}

export function generateHandoff(project) {
  const createdAt = new Date().toISOString();
  const stepLines = project.steps.map((step, index) => {
    const subprocesses = (step.subprocesses ?? []).map((item) => `   - [${item.status}] ${item.title}（rev ${item.revision}）`).join("\n");
    return `${index + 1}. [${step.status}] ${step.title}（${step.kind}，rev ${step.revision}）${subprocesses ? `\n${subprocesses}` : ""}`;
  }).join("\n");
  const artifact = project.artifact ? `\n最新产物：${project.artifact.title}\n目录：${project.artifact.projectRoot ?? "内联"}\n文件：${(project.artifact.files ?? []).join(", ") || project.artifact.filename}` : "\n尚无产物。";
  return {
    id: randomUUID(), createdAt,
    model: `# LoopCanvas Agent 交接\n\n目标：${project.goal}\n\n## 状态\n${stepLines}${artifact}\n\n## 共享上下文\n${project.context.map((item) => `- [${item.kind}] ${item.content}`).join("\n")}`,
    technical: `# LoopCanvas 技术交接\n\n生成时间：${createdAt}\n项目：${project.title}\n暂停：${project.isPaused ? "是" : "否"}\n\n## 步骤图\n${stepLines}${artifact}\n\n## 决策日志\n${project.decisionLog.map((item) => `- ${item.title}：${item.detail}`).join("\n")}`
  };
}
