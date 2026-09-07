import { WorkflowLibrary, WorkflowRuntime } from "./workflow-library.js";
import { normalizeCodexRoleModels, validateCodexRoleCatalog } from "../public/smart-routing-config.js";
import { workflowAPI } from "./workflow-api.js";
import { createWorkflowTools } from "./workflow-tools.js";
import { executeWorkflowNodeWithHarness, generateWorkflowNodesWithHarness } from "./harness.js";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeDirectives, answerStepDirection, appendContext, appendLog, approveStep, applyAdaptiveRoute, applyPlan, executionReadiness, generateHandoff, moveStep,
  readyAdaptiveSteps, recoverInterruptedAdaptiveExecution, rejectStep, reopenForRepair, reopenStep, returnVerificationToRepair, setStepCaution, StateStore
} from "./store.js";
import {
  executeProjectWithHarness, executeWithHarness, executionResultForServer, exploreWithHarness, installationStatus, learnWithHarness,
  finalReviewWithHarness, normalizeProjectExecutionResponse, planWithHarness, reviewStepWithHarness,
  listCodexModels, listCodexTools, probeHarness, probeLocalAgents, resolveProjectWorkspace, runProcess, summarizeRepositoryWithHarness,
  tracePreviewWithHarness
} from "./harness.js";
import {
  discardDraftAttachment, findAttachment, MAX_SINGLE_FILE_BYTES, readTextAttachment, stageAttachment
} from "./attachments.js";
import {
  ensureProjectDocuments, projectDocumentPaths, readAgentsDocument, readProjectDocuments, saveAgentsDocument,
  saveProjectDocument, scanCapabilities
} from "./capabilities.js";
import { isDeclaredCDNResource, resolveThreeModuleDependency, validateStepResult } from "./artifact-validator.js";
import { listDiagnostics, writeDiagnostic } from "./diagnostics.js";
import { listConversationRecords, readConversationRecord, writeConversationRecord as persistConversationRecord } from "./conversations.js";
import { buildDshPluginPatch, DSH_PLUGIN_RUNTIME_VERSION, listPlugins } from "./plugins.js";
import { buildRepositoryOverviewDocuments, findPreviewSourceCandidates, isSupportedSourceFile, listSourceFiles, parseGitHubRepositoryURL, readSourceDocument, readSourceFile, readSourceSelection } from "./source-browser.js";
import { extractPublicSource } from "./source-content.js";
import { applyDirectSourceEdit, applyDOMGeometryToSource, isDeclarativeGeometrySource, validateDirectSourceEdit } from "./geometry-edit.js";
import { RemoteManager, startRemoteServer as startRemoteListener } from "./remote.js";
import { createRuntimePreviewManager, isRuntimePreviewArtifact, runtimePreviewProjectId, runtimePreviewTracePath } from "./runtime-preview.js";
import { VoiceWakeBroker } from "./voice-wake.js";
import { AgentPresence } from "./agent-presence.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, "..", "public");
const defaultDataDirectory = process.env.LOOPCANVAS_DATA_DIR
  ? path.resolve(process.env.LOOPCANVAS_DATA_DIR)
  : path.join(os.homedir(), "Library", "Application Support", "LoopCanvasWeb");
const defaultWorkspace = process.env.LOOPCANVAS_WORKSPACE
  ? path.resolve(process.env.LOOPCANVAS_WORKSPACE)
  : path.join(os.homedir(), "Documents", "LoopCanvas", "Deliverables");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(body);
}

async function readJSON(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("请求内容超过 1 MB。 ");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function executionRetryContext(project, step) {
  const pending = project.pendingAction;
  if (pending?.type !== "execute" || pending.stepId !== step.id || pending.status !== "failed") return "";
  const error = String(pending.error ?? "").trim();
  if (!error) return "";
  return [
    `上次执行结果被系统校验拒绝：${error}`,
    "请针对该错误重新执行当前步骤；只报告实际已创建且可核查的文件。若无法创建，返回 failure，不要再次声明成功。"
  ].join("\n");
}

const MAX_EXECUTION_VALIDATION_ATTEMPTS = 3;

function automaticExecutionRepairContext(error, completedAttempt) {
  const nextAttempt = completedAttempt + 1;
  return [
    `系统正在同一次执行动作内进行自动纠错（下一次为 ${nextAttempt}/${MAX_EXECUTION_VALIDATION_ATTEMPTS}）。`,
    `上一结果被客观校验拒绝：${error.message}`,
    "先检查当前工作目录和上一结果声明的每个真实路径，再修复缺失内容或纠正错误声明；不要只改返回 JSON 来绕过校验。",
    "返回 success 前必须逐项重新读取或访问 artifact.projectRoot + artifact.filename、artifact.files 及本地资源引用，确认它们真实存在且与本步骤一致。",
    "若无法在本次完成并验证，返回 failure 和真实阻断原因，不得再次声明成功。"
  ].join("\n");
}

async function readBuffer(request, maximum = MAX_SINGLE_FILE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new Error("上传内容超过允许大小。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function projectOrThrow(store, projectId) {
  const project = store.project(projectId);
  if (!project) throw new Error("项目不存在。");
  return project;
}

function publicState(store, busyProjects) {
  const state = store.snapshot();
  for (const project of state.projects) project.busy = busyProjects.has(project.id);
  return state;
}

function completedStepPercent(step) {
  const subprocesses = step?.subprocesses ?? [];
  if (!subprocesses.length) return step?.status === "review" || step?.status === "approved" ? 100 : null;
  const complete = subprocesses.filter((item) => ["review", "approved"].includes(item.status)).length;
  return complete ? Math.round((complete / subprocesses.length) * 100) : null;
}

async function validateContinuousExecution(project, executed) {
  const deliveryStep = project.steps.at(-1);
  await validateStepResult(deliveryStep, executed.result, { requireArtifact: true });
  if (executed.result.verificationPassed !== true || executed.result.blockingIssues?.length) {
    throw new Error("主交付物最终验证未通过或仍有阻断问题。");
  }
  const checkpointById = new Map(executed.checkpoints.map((checkpoint) => [checkpoint.stepId, checkpoint]));
  for (const step of project.steps) {
    const checkpoint = checkpointById.get(step.id);
    if (!checkpoint) throw new Error(`缺少里程碑“${step.title}”的检查点。`);
    if (step.kind === "verify" && checkpoint.verificationPassed !== true) throw new Error(`验证里程碑“${step.title}”没有明确通过。`);
    if (!checkpoint.evidence.length) throw new Error(`里程碑“${step.title}”缺少客观证据。`);
  }
}

function commitContinuousExecution(project, executed, { recovered = false } = {}) {
  const now = new Date().toISOString();
  const checkpointById = new Map(executed.checkpoints.map((checkpoint) => [checkpoint.stepId, checkpoint]));
  const finalStep = project.steps.at(-1);
  for (const step of project.steps) {
    const checkpoint = checkpointById.get(step.id);
    const isFinal = step.id === finalStep.id;
    step.status = isFinal ? "review" : "approved";
    step.result = isFinal ? executed.result : {
      selectedOptionId: step.selectedOptionId,
      summary: checkpoint.summary,
      actualChanges: checkpoint.actualChanges,
      evidence: checkpoint.evidence,
      deviation: "无",
      rollback: executed.result.rollback,
      verificationPassed: checkpoint.verificationPassed,
      blockingIssues: [],
      requiresPreview: false,
      previewReason: "",
      artifact: null,
      assistantMessage: checkpoint.summary
    };
    step.conversation.push({ id: randomUUID(), role: "assistant", text: checkpoint.summary, subprocessId: null });
    appendContext(project, "result", checkpoint.summary, step.id, recovered ? "恢复的连续项目结果" : "连续项目 Agent");
    appendLog(project, "execution", recovered ? "恢复里程碑检查点" : "里程碑检查点", `${step.title}：${checkpoint.summary}`, step.id);
  }
  project.artifact = executed.result.artifact;
  project.artifactStepId = finalStep.id;
  project.artifactSubprocessId = null;
  project.phase = "workspace";
  project.executionRun = { status: "completed", startedAt: project.executionRun?.startedAt ?? now, completedAt: now, error: null };
  project.pendingAction = null;
  project.lastError = null;
  project.updatedAt = now;
  project.context.push({ id: randomUUID(), at: now, kind: "result", content: executed.result.assistantMessage, stepId: finalStep.id, subprocessId: null });
  project.agents.push({ id: randomUUID(), name: recovered ? "已恢复的连续项目结果" : "连续项目 Agent", focus: `端到端维护 ${project.primaryArtifact.filename}`, status: "complete", progress: 1, notes: [executed.result.assistantMessage], stepId: finalStep.id, subprocessId: null });
  appendLog(project, "execution", recovered ? "已恢复并验证生成结果" : "连续构建完成", executed.result.summary, finalStep.id);
}

async function recoverPrimaryArtifact(primaryArtifact, workspace, result) {
  if (result?.artifact || !primaryArtifact?.filename) return result;
  const root = path.resolve(workspace);
  const entry = path.resolve(root, primaryArtifact.filename);
  const relative = path.relative(root, entry);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("主交付物恢复路径超出项目目录。");
  try { await stat(entry); } catch { return result; }
  result.artifact = {
    title: primaryArtifact.title ?? "主交付物",
    kind: primaryArtifact.kind ?? "text",
    content: "",
    filename: primaryArtifact.filename,
    projectRoot: root,
    files: [],
    entrypoint: primaryArtifact.entrypoint ?? primaryArtifact.filename,
    dependencies: [],
    runCommands: [],
    testCommands: [],
    testResults: []
  };
  result.evidence = [...(result.evidence ?? []), `系统从锁定入口恢复产物元数据：${primaryArtifact.filename}`];
  return result;
}

function assertPrimaryArtifactMatches(project, result) {
  if (!result?.artifact || !project.primaryArtifact) return;
  if (result.artifact.filename !== project.primaryArtifact.filename || result.artifact.kind !== project.primaryArtifact.kind) {
    throw new Error(`节点返回的 ${result.artifact.filename}（${result.artifact.kind}）与锁定主交付物 ${project.primaryArtifact.filename}（${project.primaryArtifact.kind}）不一致。`);
  }
}

function isPrimaryArtifact(project, artifact) {
  return Boolean(artifact && (!project.primaryArtifact
    || (artifact.filename === project.primaryArtifact.filename && artifact.kind === project.primaryArtifact.kind)));
}

async function validateAdaptiveNodeResult(project, step, result) {
  // Every artifact still receives file, evidence and resource-safety validation.
  await validateStepResult(step, result, { requireArtifact: false });
  if (result.verificationPassed === false || result.blockingIssues?.length) throw new Error(adaptiveResultFailureMessage(step, result));
  // Intermediate documents belong to their node, not the locked final deliverable.
  // A node claiming the primary filename must still use the correct artifact kind.
  if (step.kind === "deliver" || result.artifact?.filename === project.primaryArtifact?.filename) {
    assertPrimaryArtifactMatches(project, result);
  }
}

function commitAdaptiveSingle(project, route) {
  const now = new Date().toISOString();
  const step = project.steps[0];
  step.status = "approved";
  step.result = route.execution;
  step.conversation.push({ id: randomUUID(), role: "assistant", text: route.assistantMessage, subprocessId: null });
  project.artifact = route.execution.artifact;
  project.artifactStepId = step.id;
  project.artifactSubprocessId = null;
  project.phase = "complete";
  project.executionRun = { status: "completed", startedAt: project.executionRun?.startedAt ?? now, completedAt: now, error: null };
  project.pendingAction = null;
  project.lastError = null;
  project.updatedAt = now;
  project.agents = [{ id: randomUUID(), name: "一步交付 Agent", focus: `直接交付 ${project.primaryArtifact.filename}`, status: "complete", progress: 1, notes: [route.assistantMessage], stepId: step.id, subprocessId: null }];
  appendContext(project, "result", route.execution.summary, step.id, "一步交付 Agent");
  appendLog(project, "execution", "一步完成并交付", route.execution.summary, step.id);
}

function commitAdaptiveStep(project, stepId, executed) {
  const step = project.steps.find((item) => item.id === stepId);
  if (!step) throw new Error("执行节点已不存在。");
  const now = new Date().toISOString();
  const review = executed.agentReview ?? null;
  step.routing = executed.route ? {
    role: executed.route.role,
    model: executed.route.model,
    effort: executed.route.effort,
    available: executed.route.available,
    reason: executed.route.selection || executed.route.fallbackReason || "",
    executorLabel: executed.route.available === false
      ? `${executed.route.requestedModel ?? "Codex 智能路由"} 不可用 · 当前 ${executed.route.model}`
      : `${executed.route.model || "当前模型"} · ${executed.route.effort || "默认"}`
  } : step.routing ?? null;
  step.agentReview = review ? {
    verdict: review.verdict,
    summary: review.summary,
    findings: review.findings ?? [],
    verifiedEvidence: review.verifiedEvidence ?? [],
    reviewedRevision: review.reviewedRevision,
    route: review.route ?? null,
    at: now
  } : step.agentReview ?? null;
  step.result = executed.result;
  step.reviewPending = false;
  step.lastError = null;
  step.conversation.push({ id: randomUUID(), role: "assistant", text: executed.result.assistantMessage, subprocessId: null });
  if (isPrimaryArtifact(project, executed.result.artifact)) {
    project.artifact = executed.result.artifact;
    project.artifactStepId = step.id;
    project.artifactSubprocessId = null;
  }
  appendContext(project, "result", executed.result.summary, step.id, "自适应节点 Agent");
  if (review && review.verdict !== "pass") {
    step.status = "ready";
    step.revision = (step.revision ?? 1) + 1;
    step.repairFindings = review.findings ?? [];
    step.lastFeedback = [review.summary, ...(review.findings ?? []).map((item) => item.repairInstruction).filter(Boolean)].join("；").slice(0, 8_000);
    project.artifact = null;
    project.artifactStepId = null;
    project.artifactSubprocessId = null;
    project.executionRun = { ...(project.executionRun ?? {}), status: "ready", completedAt: null, error: null, awaitingStepIds: [] };
    project.pendingAction = null;
    appendLog(project, "review", `${review.route?.available === false ? "当前审核 Agent（不可用回退）" : "审核 Agent"} 退回`, `${step.title}：${review.summary}`, step.id);
    project.updatedAt = now;
    return false;
  }
  step.status = "approved";
  appendLog(project, "review", review ? "审核 Agent 通过" : "节点已完成（兼容模式）", `${step.title}：${review?.summary ?? executed.result.summary}`, step.id);
  project.updatedAt = now;
  return true;
}

function routeLabel(route, fallback = "当前 Agent") {
  if (!route) return fallback;
  const model = route.actualModel || route.model || route.requestedModel || fallback;
  const effort = route.actualEffort || route.effort || route.requestedEffort || "默认";
  return route.available === false ? `${route.requestedModel || "智能路由"} 不可用 · 当前 ${model} · ${effort}` : `${model} · ${effort}`;
}

function repairFeedbackForStep(step) {
  const parts = [step?.lastFeedback, ...(step?.repairFindings ?? []).map((item) => item?.repairInstruction)]
    .map((item) => String(item ?? "").trim()).filter(Boolean);
  return [...new Set(parts)].join("；").slice(0, 8_000);
}

function minimalRepairStepIds(project, stepIds = []) {
  const candidates = new Set(stepIds.filter((id) => project.steps.some((step) => step.id === id)));
  const hasCandidateAncestor = (step) => {
    const pending = [...(step?.dependencies ?? [])];
    const seen = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      if (candidates.has(id)) return true;
      const dependency = project.steps.find((item) => item.id === id);
      pending.push(...(dependency?.dependencies ?? []));
    }
    return false;
  };
  return [...candidates].filter((id) => !hasCandidateAncestor(project.steps.find((step) => step.id === id)));
}

function adaptiveResultFailureMessage(step, result) {
  const issues = (result?.blockingIssues ?? []).map((item) => String(item).trim()).filter(Boolean).slice(0, 4);
  const reason = issues.length
    ? issues.join("；")
    : result?.verificationPassed === false ? "Agent 明确标记 verificationPassed=false。" : "Agent 没有明确确认验证通过。";
  return `节点“${step.title}”验证未通过：${reason}`;
}

function pathsOverlap(left, right) {
  const a = String(left).replace(/^\.\//, "").replace(/\/$/, "");
  const b = String(right).replace(/^\.\//, "").replace(/\/$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function canRunParallel(steps) {
  if (steps.length < 2 || steps.some((step) => !step.parallelSafe)) return false;
  for (let index = 0; index < steps.length; index += 1) {
    for (let other = index + 1; other < steps.length; other += 1) {
      if ((steps[index].writeScope ?? []).some((left) => (steps[other].writeScope ?? []).some((right) => pathsOverlap(left, right)))) return false;
    }
  }
  return true;
}

function mergeMetrics(previous, incoming) {
  if (!incoming) return previous ?? null;
  if (incoming.cumulativeMode !== "delta") return { ...previous, ...incoming };
  const additive = ["cumulativeTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens"];
  const merged = { ...previous, ...incoming, cumulativeMode: "absolute" };
  for (const key of additive) merged[key] = Number(previous?.[key] ?? 0) + Number(incoming[key] ?? 0);
  const prompt = Number(merged.uncachedInputTokens ?? 0) + Number(merged.cachedInputTokens ?? 0);
  merged.cacheHitRate = prompt > 0 ? Number(merged.cachedInputTokens ?? 0) / prompt : null;
  return merged;
}

function normalizeTransferReference(input = {}) {
  const title = String(input.title ?? "").trim().slice(0, 240);
  const summary = String(input.summary ?? input.content ?? "").trim().slice(0, 40_000);
  const rawURL = String(input.url ?? "").trim();
  const url = /^https?:\/\//i.test(rawURL) ? rawURL.slice(0, 2_000) : "";
  const previewURL = [input.previewURL, input.previewUrl, input.imageURL, input.imageUrl, input.thumbnailURL, input.thumbnailUrl]
    .map((value) => String(value ?? "").trim()).find((value) => /^https?:\/\//i.test(value))?.slice(0, 2_000) ?? "";
  const creator = String(input.creator ?? input.artist ?? "").trim().slice(0, 240);
  const license = String(input.license ?? input.licence ?? "").trim().slice(0, 240);
  const rawLicenseURL = String(input.licenseURL ?? input.licenseUrl ?? "").trim();
  const licenseURL = /^https?:\/\//i.test(rawLicenseURL) ? rawLicenseURL.slice(0, 2_000) : "";
  const sourceName = String(input.sourceName ?? input.source_name ?? "").trim().slice(0, 240);
  const visualDescription = String(input.visualDescription ?? input.visual_description ?? "").trim().slice(0, 12_000);
  const width = Number.isInteger(Number(input.width)) && Number(input.width) > 0 ? Math.min(Number(input.width), 100_000) : null;
  const height = Number.isInteger(Number(input.height)) && Number(input.height) > 0 ? Math.min(Number(input.height), 100_000) : null;
  const mediaKind = previewURL || input.mediaKind === "image" || input.media_kind === "image" ? "image" : "document";
  const extractedContent = String(input.extractedContent ?? "").trim().slice(0, 80_000);
  const extractionStatus = ["success", "failed", "summary-only", "provided"].includes(input.extractionStatus)
    ? input.extractionStatus
    : extractedContent ? "provided" : "summary-only";
  if (!title && !summary && !url) throw new Error("参考资料内容为空。");
  const reference = {
    id: randomUUID(), type: String(input.type ?? "reference").slice(0, 40), title: title || url || "未命名参考", url, summary,
    origin: String(input.origin ?? "cross-mode").slice(0, 80), mediaKind, previewURL, creator, license, licenseURL, sourceName,
    width, height, visualDescription, createdAt: new Date().toISOString(), extractedContent, extractionStatus,
    extractionError: String(input.extractionError ?? "").trim().slice(0, 1_000),
    extractedAt: input.extractedAt || null, extractionAttemptedAt: input.extractionAttemptedAt || null,
    extractionMetadata: input.extractionMetadata && typeof input.extractionMetadata === "object" ? structuredClone(input.extractionMetadata) : null
  };
  if (mediaKind === "image") {
    reference.visual = {
      mode: "metadata-only",
      pixelAccess: false,
      basis: "来源标题、说明和结构化元数据",
      agentText: [
        "视觉参考转译（metadata-only；纯文本 Agent 未读取图片像素）",
        `标题：${reference.title}`,
        `来源：${sourceName || url || "未知"}`,
        `创作者：${creator || "未知"}`,
        `许可：${license || "未知"}`,
        `尺寸：${width && height ? `${width} × ${height}` : "未知"}`,
        `来源提供的视觉说明：${visualDescription || summary || "未提供"}`,
        "使用限制：只能依据以上文本与元数据作为视觉方向参考，不得声称已看图、逐像素分析或识别了未在文本中描述的内容。"
      ].join("\n")
    };
  }
  return reference;
}

function svgSourceURL(reference) {
  for (const value of [reference.previewURL, reference.url]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      const pathname = decodeURIComponent(url.pathname);
      const isCommonsFilePage = /(?:^|\.)wikimedia\.org$/i.test(url.hostname) && /^\/wiki\/File:/i.test(pathname);
      if (/\.svg$/i.test(pathname) && !isCommonsFilePage) return url.href;
    } catch {}
  }
  const filename = reference.title.replace(/^File:\s*/i, "").trim();
  try {
    const page = new URL(reference.url);
    if (/\.svg$/i.test(filename) && /(?:^|\.)wikimedia\.org$/i.test(page.hostname)) {
      return `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(filename)}`;
    }
  } catch {}
  return "";
}

async function hydrateSVGReference(reference, extractor = extractPublicSource) {
  const sourceURL = svgSourceURL(reference);
  if (!sourceURL) return reference;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const extracted = await extractor({ url: sourceURL });
      if (!/<svg\b/i.test(extracted.content)) throw new Error("来源没有返回可读取的 SVG 源码。");
      const source = extracted.content.slice(0, 60_000);
      reference.extractedContent = source;
      reference.extractionStatus = "success";
      reference.extractedAt = new Date().toISOString();
      reference.extractionAttemptedAt = reference.extractedAt;
      reference.extractionMetadata = { ...extracted.metadata, sourceURL, attempts: attempt };
      reference.extractionError = "";
      reference.visual = {
        mode: "svg-source",
        pixelAccess: false,
        sourceAccess: true,
        basis: "公开 SVG 矢量源码、来源说明和结构化元数据",
        agentText: [
          "视觉参考（svg-source；可读取矢量源码，但未读取栅格像素）",
          `标题：${reference.title}`,
          `来源：${reference.sourceName || reference.url || sourceURL}`,
          `创作者：${reference.creator || "未知"}`,
          `许可：${reference.license || "未知"}`,
          `来源提供的视觉说明：${reference.visualDescription || reference.summary || "未提供"}`,
          "SVG 源码开始：",
          source,
          "SVG 源码结束。",
          "使用限制：可以依据源码中的 viewBox、路径、几何、配色与比例提炼视觉原则；不得声称读取了未提供的像素内容。"
        ].join("\n")
      };
      return reference;
    } catch (error) {
      lastError = error;
    }
  }
  reference.extractionStatus = "failed";
  reference.extractionAttemptedAt = new Date().toISOString();
  reference.extractionError = String(lastError?.message || "SVG 源码读取失败。").slice(0, 1_000);
  return reference;
}

async function hydrateProjectSVGReferences(project, store, extractor = extractPublicSource) {
  const candidates = (project.executionReferences ?? []).filter((reference) =>
    reference?.visual?.mode !== "svg-source" && svgSourceURL(reference)
  );
  if (!candidates.length) return;
  const hydrated = await Promise.all(candidates.map((reference) => hydrateSVGReference(structuredClone(reference), extractor)));
  await store.mutate(() => {
    for (const incoming of hydrated) {
      const stored = project.executionReferences?.find((reference) => reference.id === incoming.id);
      if (stored) Object.assign(stored, incoming);
    }
    project.updatedAt = new Date().toISOString();
  });
}

function executionReferenceContextContent(reference) {
  return [`执行参考：${reference.title}`, reference.url, reference.summary, reference.visual?.agentText].filter(Boolean).join("\n");
}

function normalizeLearningShelfKey(value) {
  const key = String(value ?? "").trim();
  if (!/^(?:file|material):/.test(key) || key.length > 1_200) throw new Error("学习文件栏项目标识无效。");
  return key;
}

function learningSourceRoot(project, settings, sourceId) {
  if (!sourceId || sourceId === "project") return resolveProjectWorkspace(project, settings);
  const source = (project.learningSources ?? []).find((item) => item.id === sourceId);
  if (!source) throw new Error("学习源码来源不存在。");
  return source.root;
}

function publicLearningSources(project) {
  return [
    { id: "project", type: "project", title: "项目工作目录" },
    ...(project.learningSources ?? []).map(({ id, type, title, url, createdAt, documentOverviews, overviewMeta, overviewGeneratedAt }) => ({
      id, type, title, url: url ?? "", createdAt,
      documentOverviews: Array.isArray(documentOverviews) ? documentOverviews : [], overviewMeta: overviewMeta ?? null, overviewGeneratedAt: overviewGeneratedAt ?? null
    }))
  ];
}

const MAX_LEARNING_IMPORT_FILE_BYTES = 1024 * 1024;
const MAX_LEARNING_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_LEARNING_IMPORT_FILES = 500;

function safeLearningImportPath(value) {
  const raw = decodeURIComponent(String(value ?? "")).replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..") || raw.length > 500) throw new Error("导入文件路径无效或越界。");
  const relative = parts.join("/");
  if (!isSupportedSourceFile(parts.at(-1))) throw new Error("这个文件不是支持的源码类型。");
  return relative;
}

function ownsProjectCall(activeControllers, projectId, controller) {
  return activeControllers.get(projectId) === controller;
}

function releaseProjectCall(activeControllers, busyProjects, projectId, controller) {
  if (!ownsProjectCall(activeControllers, projectId, controller)) return false;
  activeControllers.delete(projectId);
  busyProjects.delete(projectId);
  return true;
}

const previewDiagnosticsScript = `<script src="/preview-trace.js" data-error-panel="dshwf-preview-error"></script>`;
const previewHiddenStateStyle = `<style id="loopcanvas-preview-hidden-state">[hidden]{display:none!important}</style>`;
const previewContentSecurityPolicy = (previewOrigin) => `sandbox allow-scripts; default-src 'none'; script-src 'self' ${previewOrigin} 'unsafe-inline' https:; style-src 'self' ${previewOrigin} 'unsafe-inline' https:; img-src 'self' ${previewOrigin} data: blob: https:; media-src 'self' ${previewOrigin} data: blob: https:; font-src 'self' ${previewOrigin} data: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
const previewDependencyPrefix = "__dependency__/";
const previewDependencyMaximumBytes = 8 * 1024 * 1024;
const previewDependencyTimeoutMs = 15_000;

function previewArtifactPath(projectId, filename) {
  const segments = String(filename ?? "").split(/[\\/]+/).filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.includes("..")) return null;
  return `/preview/${encodeURIComponent(projectId)}/${segments.map(encodeURIComponent).join("/")}`;
}

function previewDependencyPath(projectId, resource) {
  let remote;
  try { remote = new URL(resource); } catch { return null; }
  if (remote.protocol !== "https:" || remote.username || remote.password || remote.port) return null;
  const pathname = remote.pathname.split("/").map(encodeURIComponent).join("/");
  return `/preview/${encodeURIComponent(projectId)}/${previewDependencyPrefix}${encodeURIComponent(remote.hostname)}${pathname}${remote.search}`;
}

function remoteDependencyFromPreviewPath(requested, search = "") {
  if (!requested.startsWith(previewDependencyPrefix)) return null;
  const segments = requested.slice(previewDependencyPrefix.length).split("/");
  const hostname = segments.shift();
  if (!hostname || !segments.length) return null;
  const remote = new URL("https://invalid.example/");
  remote.hostname = hostname;
  remote.pathname = `/${segments.join("/")}`;
  remote.search = search;
  return remote;
}

function proxyDeclaredPreviewResources(source, dependencies, projectId) {
  return String(source ?? "").replace(/(\b(?:src|href)\s*=\s*)(["'])(https:\/\/[^"']+)\2/gi, (match, prefix, quote, resource) => {
    if (!isDeclaredCDNResource(resource, dependencies)) return match;
    const proxied = previewDependencyPath(projectId, resource);
    if (!proxied) return match;
    const original = resource.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `${prefix}${quote}${proxied}${quote} data-loopcanvas-remote-src="${original}"`;
  });
}

async function readPreviewDependency(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > previewDependencyMaximumBytes) throw new Error("远程依赖超过 8 MiB 上限");
  const chunks = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > previewDependencyMaximumBytes) throw new Error("远程依赖超过 8 MiB 上限");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function previewImportMapScript(dependencies, source, projectId) {
  if (/<script\b[^>]*\btype\s*=\s*["']importmap["']/i.test(source)) return "";
  const resolved = resolveThreeModuleDependency(dependencies);
  if (!resolved) return "";
  const root = resolved.host === "unpkg.com"
    ? `https://unpkg.com/three@${resolved.version}`
    : `https://cdn.jsdelivr.net/npm/three@${resolved.version}`;
  const importMap = JSON.stringify({ imports: {
    three: previewDependencyPath(projectId, `${root}/build/three.module.js`),
    "three/addons/": previewDependencyPath(projectId, `${root}/examples/jsm/`)
  } }).replaceAll("<", "\\u003c");
  return `<script type="importmap">${importMap}</script>`;
}

function securedPreviewHTML(source, dependencies = [], projectId = "") {
  const html = proxyDeclaredPreviewResources(source, dependencies, projectId);
  const headInjection = `${previewHiddenStateStyle}${previewDiagnosticsScript}${previewImportMapScript(dependencies, html, projectId)}`;
  const head = html.match(/<head[^>]*>/i);
  if (head?.index != null) {
    const end = head.index + head[0].length;
    return `${html.slice(0, end)}${headInjection}${html.slice(end)}`;
  }
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag?.index != null) {
    const end = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, end)}<head><meta charset="utf-8">${headInjection}</head>${html.slice(end)}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${headInjection}</head><body>${html}</body></html>`;
}

function artifactSourceManifest(artifact) {
  return [...new Set([artifact?.filename, ...(artifact?.files ?? [])].map((item) => String(item ?? "").replaceAll("\\", "/").trim()).filter(Boolean))];
}

async function writeArtifactSource(projectRoot, relativePath, content) {
  const boundary = path.resolve(projectRoot);
  const candidate = path.resolve(boundary, relativePath);
  const relative = path.relative(boundary, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("几何编辑源码路径超出项目工作目录。");
  const source = await readSourceFile(boundary, relativePath);
  const temporary = path.join(path.dirname(candidate), `.${path.basename(candidate)}.loopcanvas-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, candidate);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => null);
    throw error;
  }
  return source.path;
}

async function prepareGeometrySourceChange(project, body) {
  const artifact = project.artifact;
  if (!artifact) throw new Error("当前项目没有可二维编辑的图形预览。");
  const direct = body.sourceEdit ? validateDirectSourceEdit(body.sourceEdit) : null;
  if (direct) {
    if (!artifact.projectRoot) throw new Error("Canvas 内部对象必须来自有工作目录的源码产物。");
    if (!artifactSourceManifest(artifact).includes(direct.path)) throw new Error("Canvas 适配器只能替换当前产物清单内的源码。");
    const source = await readSourceFile(artifact.projectRoot, direct.path);
    const patched = applyDirectSourceEdit(source.content, direct);
    return { path: source.path, content: patched.content, edit: body.geometry, anchor: String(body.target?.traceId || body.target?.groupId || "canvas-adapter"), mode: "canvas-source-replace" };
  }
  if (artifact.kind !== "html") throw new Error("这个运行时界面需要 Canvas/Three 适配器提供精确源码替换，不能凭坐标猜改组件代码。");
  const manifest = artifactSourceManifest(artifact).filter(isDeclarativeGeometrySource);
  if (!artifact.projectRoot) {
    const patched = applyDOMGeometryToSource(String(artifact.content ?? ""), body.target, body.geometry);
    return { path: artifact.filename || "index.html", content: patched.content, edit: patched.edit, anchor: patched.anchor, mode: "dom-geometry" };
  }
  const matches = [];
  let ambiguity = null;
  for (const relativePath of manifest) {
    const source = await readSourceFile(artifact.projectRoot, relativePath).catch(() => null);
    if (!source) continue;
    try {
      const patched = applyDOMGeometryToSource(source.content, body.target, body.geometry);
      matches.push({ path: source.path, content: patched.content, edit: patched.edit, anchor: patched.anchor, mode: "dom-geometry" });
    } catch (error) {
      if (/不唯一/.test(error.message)) ambiguity = error;
      else if (!/找不到精确元素锚点/.test(error.message)) throw error;
    }
  }
  if (ambiguity) throw ambiguity;
  if (matches.length !== 1) throw new Error(matches.length ? "元素锚点在多个源码文件中出现，已拒绝凭推测改代码。" : "当前产物源码中找不到唯一锚点，未改动代码。");
  return matches[0];
}

export async function createLoopCanvasServer(options = {}) {
  const agentPresence = new AgentPresence();
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory;
  const workspace = options.workspace ?? defaultWorkspace;
  const planRunner = agentPresence.wrap("plan", options.planWithHarness ?? planWithHarness);
  const executeRunner = agentPresence.wrap("execute", options.executeWithHarness ?? executeWithHarness);
  const executeProjectRunner = agentPresence.wrap("execute", options.executeProjectWithHarness ?? executeProjectWithHarness);
  const reviewRunner = agentPresence.wrap("review", options.reviewStepWithHarness ?? reviewStepWithHarness);
  const finalReviewRunner = agentPresence.wrap("review", options.finalReviewWithHarness ?? finalReviewWithHarness);
  const enforceAgentReviewChain = options.enforceAgentReviewChain ?? !options.executeWithHarness;
  const exploreRunner = options.exploreWithHarness ?? exploreWithHarness;
  const sourceContentExtractor = options.extractPublicSource ?? extractPublicSource;
  const previewDependencyFetcher = options.fetchPreviewDependency ?? fetch;
  const processRunner = options.runProcess ?? runProcess;
  const traceRunner = options.tracePreviewWithHarness ?? tracePreviewWithHarness;
  const repositoryOverviewRunner = options.summarizeRepositoryWithHarness ?? summarizeRepositoryWithHarness;
  const probeRunner = options.probeHarness ?? probeHarness;
  const localAgentsProbeRunner = options.probeLocalAgents ?? probeLocalAgents;
  const codexModelsRunner = options.listCodexModels ?? listCodexModels;
  const codexToolsRunner = options.listCodexTools ?? listCodexTools;
  await mkdir(dataDirectory, { recursive: true });
  const store = new StateStore(path.join(dataDirectory, "state.json"), workspace);
  const pendingLearningImports = new Map();
  await store.load();
  const workflowLibrary = new WorkflowLibrary(path.join(dataDirectory, "workflows.sqlite"));
  const workflowTools = createWorkflowTools({ dataDirectory, processRunner });
  let workflowToolCache = { key: "", at: 0, tools: [] };
  const workflowToolCatalog = async ({ refresh = false } = {}) => {
    const current = await harnessSettings();
    const key = JSON.stringify([current.agentRuntime, current.codexPath || process.env.LOOPCANVAS_CODEX_EXECUTABLE || "", current.workspace]);
    if (!refresh && workflowToolCache.key === key && Date.now() - workflowToolCache.at < 30_000) return workflowToolCache.tools;
    const tools = [...await workflowTools.catalog(), ...await codexToolsRunner(current)];
    workflowToolCache = { key, at: Date.now(), tools };
    return tools;
  };
  const agentWorkflowExecutor = agentPresence.wrap("execute", options.executeWorkflowNodeWithHarness ?? executeWorkflowNodeWithHarness);
  const workflowRuntime = new WorkflowRuntime(workflowLibrary, async (...args) => (await workflowTools.execute(...args)) ?? agentWorkflowExecutor(...args));
  const handleWorkflowAPI = workflowAPI({ library: workflowLibrary, runtime: workflowRuntime, dataDirectory, generate: agentPresence.wrap("plan", options.generateWorkflowNodesWithHarness ?? generateWorkflowNodesWithHarness), toolCatalog: workflowToolCatalog, settings: harnessSettings, readJSON, json });
  const remoteManager = options.remoteManager ?? await new RemoteManager({ dataDirectory, ...(options.remote ?? {}) }).load();
  const runtimePreviewManager = options.runtimePreviewManager ?? createRuntimePreviewManager(options.runtimePreview ?? {});
  const token = randomBytes(24).toString("base64url");
  const voiceWake = new VoiceWakeBroker();
  const busyProjects = new Set();
  const activeControllers = new Map();
  const restoringProjects = new Set();
  const checkpointBeforeCall = async (project, reason, details, controller) => {
    try { return await store.createCheckpoint(project.id, reason, details); }
    catch (error) { releaseProjectCall(activeControllers, busyProjects, project.id, controller); throw error; }
  };
  const restoreProject = async (projectId, restore, restoring = true) => {
    if (busyProjects.has(projectId) || agentPresence.snapshot().calls.some((call) => call.projectId === projectId)) throw new Error("项目仍在执行或停止中，请等待 Agent 退出后再回退。");
    busyProjects.add(projectId);
    restoringProjects.add(projectId);
    try {
      await runtimePreviewManager.stop?.(projectId);
      await restore();
      if (restoring) updateRuntime(projectId, { active: false, activity: "已恢复执行前的文件与工作流状态", percent: null });
    } finally { restoringProjects.delete(projectId); busyProjects.delete(projectId); }
  };
  const activeModeCalls = new Set();
  const runtimeStates = new Map();
  const runtimeMetrics = new Map();
  const writeConversationRecord = (_directory, input = {}) => persistConversationRecord(dataDirectory, {
    ...input,
    agentRoute: input.agentRoute ?? runtimeStates.get(input.projectId)?.agentRoute ?? null,
    runtime: input.runtime
      ?? runtimeStates.get(input.projectId)?.runtime
      ?? (store.state.settings.agentRuntime === "codex" ? "codex" : "dsh")
  });

  const metricKey = (projectId, runtime) => `${projectId}:${runtime}`;
  const updateRuntime = (projectId, patch) => {
    runtimeStates.set(projectId, { active: false, activity: "等待自动执行", percent: null, updatedAt: new Date().toISOString(), ...(runtimeStates.get(projectId) ?? {}), ...patch, updatedAt: new Date().toISOString() });
  };
  const recordAgentEvent = (projectId, runtime, stepId = null) => (event = {}) => {
    if (event.type === "metrics" && event.metrics) {
      const key = metricKey(projectId, runtime);
      runtimeMetrics.set(key, mergeMetrics(runtimeMetrics.get(key), event.metrics));
    }
    const project = store.project(projectId);
    const step = project?.steps.find((item) => item.id === stepId);
    updateRuntime(projectId, {
      runtime,
      ...(event.type === "route" && event.route ? { agentRoute: event.route, activity: `${event.route.role} · ${event.route.actualModel || event.route.model || event.route.requestedModel || "当前模型"} · ${event.route.actualEffort || event.route.effort || event.route.requestedEffort || "默认"}` } : {}),
      ...(event.activity ? { activity: String(event.activity) } : {}),
      ...(step ? { percent: completedStepPercent(step), stepId: step.id, stepTitle: step.title } : {})
    });
  };
  const runtimePayload = (project) => {
    const runtime = store.state.settings.agentRuntime === "codex" ? "codex" : "dsh";
    const active = busyProjects.has(project.id);
    const saved = runtimeStates.get(project.id);
    const error = project.lastError || project.pendingAction?.error || project.executionRun?.error;
    const activity = !active && (project.isPaused || project.executionRun?.status === "cancelled") ? "执行已暂停"
      : !active && error ? `执行失败：${error}`
      : !active && project.phase === "complete" ? "全部节点已验证并交付"
      : !active && saved?.active ? "执行已结束"
      : saved?.activity ?? "等待自动执行";
    return {
      ...(saved ?? { percent: null, updatedAt: null }),
      active, activity,
      runtime,
      metrics: runtimeMetrics.get(metricKey(project.id, runtime)) ?? null
    };
  };

  const pauseProject = async (project) => {
    const controller = activeControllers.get(project.id);
    controller?.abort();
    if (controller) {
      activeControllers.delete(project.id);
      busyProjects.delete(project.id);
    }
    await store.mutate(() => {
      const pending = project.pendingAction;
      if (pending?.status === "running") {
        if (pending.type === "plan" && project.phase === "planning") project.phase = "intake";
        if (pending.type === "execute") {
          const runningStep = project.steps.find((step) => step.id === pending.stepId && step.status === "running");
          if (runningStep) runningStep.status = "ready";
        }
        project.pendingAction = { ...pending, status: "cancelled", error: null };
      }
      project.isPaused = true;
      project.lastError = null;
      project.handoff = generateHandoff(project);
      appendLog(project, "system", "任务已暂停", "活动 Agent 任务已取消；双版本交接文档已生成。");
      appendContext(project, "system", "任务暂停；活动 Agent 任务已取消并创建交接快照。", null, "系统");
    });
    updateRuntime(project.id, { active: false, activity: "自动执行已由用户暂停" });
  };

  const resumeProject = async (project) => {
    await store.mutate(() => {
      project.isPaused = false;
      if (project.pendingAction?.status === "cancelled") project.pendingAction.error = null;
      project.lastError = null;
      appendLog(project, "system", "任务已恢复", "已恢复用户操作；没有自动重发任务，避免重复计费。");
      appendContext(project, "system", "任务恢复；暂停期间的任务没有自动重发。", null, "系统");
    });
  };

  async function harnessSettings({ requiredPlugins = [] } = {}) {
    const settings = structuredClone(store.state.settings);
    if (settings.agentRuntime === "codex") return settings;
    const runtimePluginStates = { ...store.state.dshPluginStates };
    for (const pluginId of requiredPlugins) runtimePluginStates[pluginId] = true;
    if (!Object.keys(runtimePluginStates).length) return settings;
    const probe = await probeRunner(settings);
    if (probe.version !== DSH_PLUGIN_RUNTIME_VERSION) {
      throw new Error(`已同步插件仅验证过 dsh ${DSH_PLUGIN_RUNTIME_VERSION}；当前是 ${probe.version}，已停止调用。`);
    }
    settings.dshPluginPatch = await buildDshPluginPatch({ dataDirectory, runtimeStates: runtimePluginStates });
    return settings;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? "";
      const runtimeProjectId = runtimePreviewProjectId(host);
      if (!runtimeProjectId && !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) {
        return json(response, 403, { error: "Host 已拒绝。" });
      }
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (runtimeProjectId) {
        if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)) return json(response, 405, { error: "请求方法不支持。" });
        if (url.pathname === runtimePreviewTracePath && ["GET", "HEAD"].includes(request.method)) {
          const candidate = path.join(publicRoot, "preview-trace.js");
          const info = await stat(candidate);
          response.writeHead(200, { "Content-Type": mimeTypes[".js"], "Content-Length": info.size, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          if (request.method === "HEAD") return response.end();
          return createReadStream(candidate).pipe(response);
        }
        const project = projectOrThrow(store, runtimeProjectId);
        if (!isRuntimePreviewArtifact(project.artifact)) return json(response, 404, { error: "当前产物没有可运行的图形预览。" });
        if (restoringProjects.has(project.id)) return json(response, 409, { error: "正在恢复项目文件，请稍后重试。" });
        await runtimePreviewManager.proxy(project, request, response);
        return;
      }
      const targetProjectId = url.pathname.match(/^\/api\/projects\/([^/]+)/)?.[1];
      if (restoringProjects.has(targetProjectId)) return json(response, 409, { error: "正在恢复项目文件，请稍后重试。" });
      const isAPI = url.pathname.startsWith("/api/");
      if (isAPI && request.method !== "GET" && request.headers["x-loopcanvas-token"] !== token) {
        return json(response, 403, { error: "会话令牌无效，请刷新页面。", code: "SESSION_TOKEN_EXPIRED" });
      }

      if (await handleWorkflowAPI(request, response, url)) return;

      const previewMatch = url.pathname.match(/^\/preview\/([^/]+)(?:\/(.*))?$/);
      if (request.method === "GET" && previewMatch) {
        const project = projectOrThrow(store, previewMatch[1]);
        const artifact = project.artifact;
        if (!artifact || artifact.kind !== "html") return json(response, 404, { error: "没有可预览的 HTML 产物。" });
        const requested = decodeURIComponent(previewMatch[2] ?? "");
        if (!requested) {
          if (!artifact.projectRoot) {
            const body = Buffer.from(securedPreviewHTML(artifact.content, artifact.dependencies, project.id), "utf8");
            response.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store",
              "Content-Security-Policy": previewContentSecurityPolicy(url.origin),
              "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
            });
            return response.end(body);
          }
          const location = previewArtifactPath(project.id, artifact.filename);
          if (!location) return json(response, 400, { error: "产物入口路径无效。" });
          response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
          return response.end();
        }
        const remoteDependency = remoteDependencyFromPreviewPath(requested, url.search);
        if (remoteDependency) {
          if (!isDeclaredCDNResource(remoteDependency.href, artifact.dependencies)) return json(response, 403, { error: "远程依赖未在当前产物中声明。" });
          try {
            const remoteResponse = await previewDependencyFetcher(remoteDependency.href, {
              redirect: "error",
              signal: AbortSignal.timeout(previewDependencyTimeoutMs),
              headers: { Accept: "application/javascript,text/javascript,text/css;q=0.9,*/*;q=0.1" }
            });
            if (!remoteResponse.ok) throw new Error(`HTTP ${remoteResponse.status}`);
            const contentType = String(remoteResponse.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
            const allowedTypes = new Set(["application/javascript", "text/javascript", "application/ecmascript", "text/css"]);
            if (!allowedTypes.has(contentType)) throw new Error(`不支持的内容类型 ${contentType || "未知"}`);
            const body = await readPreviewDependency(remoteResponse);
            response.writeHead(200, {
              "Content-Type": `${contentType}; charset=utf-8`, "Content-Length": body.length, "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*",
              "Cross-Origin-Resource-Policy": "cross-origin", "Referrer-Policy": "no-referrer"
            });
            return response.end(body);
          } catch (error) {
            return json(response, 502, { error: `远程依赖加载失败：${remoteDependency.hostname}${remoteDependency.pathname}（${error.message}）` });
          }
        }
        if (!artifact.projectRoot) return json(response, 404, { error: "内联产物没有附属文件。" });
        const allowed = new Set([artifact.filename, ...(artifact.files ?? [])].map((item) => path.normalize(item)));
        const normalized = path.normalize(requested);
        if (!allowed.has(normalized)) return json(response, 403, { error: "该文件不在产物清单中。" });
        const root = await realpath(artifact.projectRoot);
        const candidate = await realpath(path.resolve(root, normalized)).catch(() => null);
        if (!candidate) return json(response, 404, { error: "产物文件不存在。" });
        const relative = path.relative(root, candidate);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return json(response, 403, { error: "预览路径越界。" });
        const info = await stat(candidate).catch(() => null);
        if (!info?.isFile()) return json(response, 404, { error: "产物文件不存在。" });
        if (normalized === path.normalize(artifact.filename)) {
          const html = artifact.content || await readFile(candidate, "utf8");
          const body = Buffer.from(securedPreviewHTML(html, artifact.dependencies, project.id), "utf8");
          response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store",
            "Content-Security-Policy": previewContentSecurityPolicy(url.origin),
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
          });
          return response.end(body);
        }
        response.writeHead(200, { "Content-Type": mimeTypes[path.extname(candidate).toLowerCase()] ?? "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": previewContentSecurityPolicy(url.origin) });
        return createReadStream(candidate).pipe(response);
      }

      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        return json(response, 200, {
          token,
          voiceWakeVersion: 1,
          agentPresence: agentPresence.snapshot(),
          state: publicState(store, busyProjects),
          installation: await installationStatus(store.state.settings),
          runtime: { version: "0.1.0", address: "仅本机 127.0.0.1" },
          remote: remoteManager.publicStatus()
        });
      }

      if (request.method === "GET" && url.pathname === "/api/agents/presence") {
        return json(response, 200, agentPresence.snapshot());
      }
      if (request.method === "POST" && url.pathname === "/api/voice/wake") {
        const event = voiceWake.create(await readJSON(request), store.project(store.state.activeProjectId));
        return json(response, 201, event);
      }
      const voiceWakeClaim = url.pathname.match(/^\/api\/voice\/wake\/([\da-f-]+)\/claim$/i);
      if (request.method === "POST" && voiceWakeClaim) {
        return json(response, 200, { event: voiceWake.claim(voiceWakeClaim[1]) });
      }

      if (request.method === "GET" && url.pathname === "/api/remote/status") {
        return json(response, 200, { remote: remoteManager.publicStatus() });
      }

      if (request.method === "POST" && url.pathname === "/api/remote/pairings") {
        return json(response, 201, { pairing: await remoteManager.createPairing(await readJSON(request)), remote: remoteManager.publicStatus() });
      }

      const remoteDeviceMatch = url.pathname.match(/^\/api\/remote\/devices\/([^/]+)\/revoke$/);
      if (request.method === "POST" && remoteDeviceMatch) {
        return json(response, 200, { remote: await remoteManager.revokeDevice(remoteDeviceMatch[1]) });
      }

      if (request.method === "POST" && url.pathname === "/api/remote/handoffs") {
        const body = await readJSON(request);
        return json(response, 201, { event: await remoteManager.createHandoff(body), remote: remoteManager.publicStatus() });
      }

      const remoteCommandMatch = url.pathname.match(/^\/api\/remote\/commands\/([^/]+)\/decision$/);
      if (request.method === "POST" && remoteCommandMatch) {
        const body = await readJSON(request);
        const command = remoteManager.state.commands.find((item) => item.id === remoteCommandMatch[1]);
        if (!command || command.status !== "pending") throw new Error("Remote 命令不存在或已处理。");
        let event = null;
        if (body.decision === "approved") {
          const project = store.project(store.state.activeProjectId);
          if (command.command.type === "pause") {
            if (!project) throw new Error("没有当前项目，无法执行暂停。");
            await pauseProject(project);
          } else if (command.command.type === "resume") {
            if (!project) throw new Error("没有当前项目，无法执行恢复。");
            await resumeProject(project);
          } else if (["open_url", "handoff"].includes(command.command.type)) {
            const targetDeviceId = String(body.targetDeviceId ?? command.deviceId ?? "");
            if (!targetDeviceId) throw new Error("打开网页前必须选择已配对目标设备。");
            event = await remoteManager.createHandoff({ url: command.command.url, title: command.command.label, targetDeviceId });
          }
        }
        const decided = await remoteManager.decideCommand(command.id, body.decision);
        return json(response, 200, { command: decided, event, remote: remoteManager.publicStatus(), state: publicState(store, busyProjects) });
      }

      const runtimeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runtime$/);
      if (request.method === "GET" && runtimeMatch) {
        const project = projectOrThrow(store, runtimeMatch[1]);
        return json(response, 200, { runtime: runtimePayload(project) });
      }

      if (request.method === "POST" && url.pathname === "/api/settings") {
        const input = await readJSON(request);
        if (Object.hasOwn(input, "codexRoleModels")) {
          input.codexRoleModels = normalizeCodexRoleModels(input.codexRoleModels);
          const proposed = { ...store.state.settings, ...input };
          if (proposed.agentRuntime === "codex" && proposed.smartRouting !== false) validateCodexRoleCatalog(input.codexRoleModels, await codexModelsRunner(proposed));
        }
        const settings = await store.updateSettings(input);
        return json(response, 200, { settings, installation: await installationStatus(settings) });
      }

      if (request.method === "POST" && url.pathname === "/api/harness/probe") {
        const draft = await readJSON(request);
        return json(response, 200, {
          probe: await probeRunner({ ...store.state.settings, dshPath: String(draft.dshPath ?? store.state.settings.dshPath).trim() })
        });
      }

      if (request.method === "POST" && url.pathname === "/api/agents/probe") {
        const draft = await readJSON(request);
        return json(response, 200, {
          installation: await localAgentsProbeRunner({
            ...store.state.settings,
            dshPath: String(draft.dshPath ?? store.state.settings.dshPath).trim()
          })
        });
      }

      if (request.method === "POST" && url.pathname === "/api/codex/models") {
        return json(response, 200, { models: await codexModelsRunner(store.state.settings) });
      }

      if (request.method === "POST" && url.pathname === "/api/attachments") {
        const bytes = await readBuffer(request);
        const attachment = await stageAttachment({
          dataDirectory, state: store.state, bytes,
          filename: decodeURIComponent(String(request.headers["x-file-name"] ?? "attachment")),
          mimeType: String(request.headers["content-type"] ?? "application/octet-stream"),
          source: decodeURIComponent(String(request.headers["x-attachment-source"] ?? "Web 文件选择器"))
        });
        try {
          await store.mutate((state) => { state.draftAttachments.push(attachment); });
        } catch (error) {
          await discardDraftAttachment({ dataDirectory, state: { draftAttachments: [attachment] }, attachmentId: attachment.id }).catch(() => {});
          throw error;
        }
        return json(response, 201, { attachment, state: publicState(store, busyProjects) });
      }

      const attachmentTextMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/text$/);
      if (request.method === "GET" && attachmentTextMatch) {
        return json(response, 200, { text: await readTextAttachment(store.state, attachmentTextMatch[1]) });
      }

      const attachmentContentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
      if (request.method === "GET" && attachmentContentMatch) {
        const attachment = findAttachment(store.state, attachmentContentMatch[1]);
        if (!attachment) return json(response, 404, { error: "附件不存在。" });
        const root = path.resolve(dataDirectory, "attachments");
        const candidate = path.resolve(attachment.localPath);
        const relative = path.relative(root, candidate);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return json(response, 403, { error: "附件路径越界。" });
        const info = await stat(candidate).catch(() => null);
        if (!info?.isFile()) return json(response, 404, { error: "附件文件不存在。" });
        response.writeHead(200, {
          "Content-Type": attachment.mimeType || "application/octet-stream", "Content-Length": info.size,
          "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
        });
        return createReadStream(candidate).pipe(response);
      }

      const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (request.method === "DELETE" && attachmentMatch) {
        await store.mutate((state) => discardDraftAttachment({ dataDirectory, state, attachmentId: attachmentMatch[1] }));
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      if (request.method === "GET" && url.pathname === "/api/capabilities/agents") {
        return json(response, 200, { document: await readAgentsDocument(store.state.settings.workspace) });
      }

      if (request.method === "POST" && url.pathname === "/api/capabilities/agents") {
        const body = await readJSON(request);
        return json(response, 200, { document: await saveAgentsDocument(store.state.settings.workspace, body.path, body.content) });
      }

      if (request.method === "GET" && url.pathname === "/api/capabilities") {
        return json(response, 200, { items: [...await scanCapabilities(url.searchParams.get("kind"), store.state.settings.workspace), ...(url.searchParams.get("kind") === "skills" ? workflowLibrary.catalog().skills.map((s) => ({ id: s.id, name: s.name, path: "本机工作流 Skill 库", detail: s.detail })) : [])] });
      }

      if (request.method === "GET" && url.pathname === "/api/diagnostics") {
        return json(response, 200, { items: await listDiagnostics(dataDirectory) });
      }

      if (request.method === "GET" && url.pathname === "/api/plugins") {
        return json(response, 200, await listPlugins({ dataDirectory, runtimeStates: store.state.dshPluginStates }));
      }

      const pluginMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)$/);
      if (request.method === "POST" && pluginMatch) {
        const body = await readJSON(request);
        const id = decodeURIComponent(pluginMatch[1]);
        const enabled = body.enabled === true;
        const catalog = await listPlugins({ dataDirectory, runtimeStates: store.state.dshPluginStates });
        const item = catalog.items.find((candidate) => candidate.id === id);
        if (!item?.manifest) throw new Error("插件不存在。");
        if (!item.runtime.supported) throw new Error(`这个插件无法同步：${item.runtime.reason}`);
        if (enabled) {
          if (body.confirmed !== true) throw new Error("开启插件前必须查看简介和功能并明确确认。");
          const probe = await probeRunner(store.state.settings);
          if (probe.version !== DSH_PLUGIN_RUNTIME_VERSION) {
            throw new Error(`只支持同步到 dsh ${DSH_PLUGIN_RUNTIME_VERSION}；当前是 ${probe.version}。`);
          }
        }
        await store.mutate((state) => { state.dshPluginStates[id] = enabled; });
        return json(response, 200, await listPlugins({ dataDirectory, runtimeStates: store.state.dshPluginStates }));
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        const project = await store.createProject(await readJSON(request));
        return json(response, 201, { project, state: publicState(store, busyProjects) });
      }

      if (request.method === "POST" && url.pathname === "/api/projects/draft") {
        const project = await store.createProject({ goal: "", draft: true });
        return json(response, 201, { project, state: publicState(store, busyProjects) });
      }

      const activateMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/activate$/);
      if (request.method === "POST" && activateMatch) {
        await store.setActiveProject(activateMatch[1]);
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const pinMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/pin$/);
      if (request.method === "POST" && pinMatch) {
        const { pinned } = await readJSON(request);
        if (typeof pinned !== "boolean") throw new Error("置顶状态必须是布尔值。");
        const project = await store.setProjectPinned(pinMatch[1], pinned);
        return json(response, 200, { project, state: publicState(store, busyProjects) });
      }

      const archiveMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/archive$/);
      if (request.method === "POST" && archiveMatch) {
        activeControllers.get(archiveMatch[1])?.abort();
        activeControllers.delete(archiveMatch[1]);
        busyProjects.delete(archiveMatch[1]);
        await store.archiveProject(archiveMatch[1]);
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      if (request.method === "POST" && url.pathname === "/api/projects/restore-archived") {
        const project = await store.restoreLatestArchivedProject();
        return json(response, 200, { project, state: publicState(store, busyProjects) });
      }

      const restoreArchivedMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/restore$/);
      if (request.method === "POST" && restoreArchivedMatch) {
        const project = await store.restoreArchivedProject(restoreArchivedMatch[1]);
        return json(response, 200, { project, state: publicState(store, busyProjects) });
      }

      const renameMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/rename$/);
      if (request.method === "POST" && renameMatch) {
        const { title } = await readJSON(request);
        const project = await store.renameProject(renameMatch[1], title);
        return json(response, 200, { project, state: publicState(store, busyProjects) });
      }

      const projectWorkspaceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/workspace$/);
      if (request.method === "POST" && projectWorkspaceMatch) {
        const { workspace } = await readJSON(request);
        const explicit = String(workspace ?? "").trim();
        if (explicit) {
          const info = await stat(explicit).catch(() => null);
          if (!info?.isDirectory()) throw new Error("显式工作目录必须已经存在且是文件夹；留空则使用自动派生目录。");
        }
        const project = await store.updateProjectWorkspace(projectWorkspaceMatch[1], explicit);
        return json(response, 200, { project, state: publicState(store, busyProjects) });
      }

      const documentsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/documents$/);
      if (documentsMatch) {
        const project = projectOrThrow(store, documentsMatch[1]);
        const workspace = resolveProjectWorkspace(project, store.state.settings);
        if (request.method === "GET") {
          await ensureProjectDocuments({ workspace, project });
          const documents = await readProjectDocuments(workspace);
          const paths = projectDocumentPaths(workspace);
          return json(response, 200, {
            workspace,
            documents: {
              agents: { path: paths.agents, content: documents.agents },
              constitution: { path: paths.constitution, content: documents.constitution }
            }
          });
        }
        if (request.method === "POST") {
          const { name, content } = await readJSON(request);
          const saved = await saveProjectDocument(workspace, name, content);
          return json(response, 200, { workspace, document: saved });
        }
      }

      const conversationsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/conversations$/);
      if (request.method === "GET" && conversationsMatch) {
        return json(response, 200, { items: await listConversationRecords(dataDirectory, conversationsMatch[1]) });
      }

      const conversationMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/conversations\/([^/]+)$/);
      if (request.method === "GET" && conversationMatch) {
        return json(response, 200, { record: await readConversationRecord(dataDirectory, conversationMatch[1], conversationMatch[2]) });
      }

      const designApplyMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/design\/apply$/);
      if (request.method === "POST" && designApplyMatch) {
        const project = projectOrThrow(store, designApplyMatch[1]);
        if (busyProjects.has(project.id)) throw new Error("项目正在执行，暂时不能覆盖产物源码。");
        const body = await readJSON(request);
        if (!body.target || typeof body.target !== "object" || JSON.stringify(body.target).length > 8_000) throw new Error("二维编辑目标无效。");
        const change = await prepareGeometrySourceChange(project, body);
        if (project.artifact.projectRoot) await writeArtifactSource(project.artifact.projectRoot, change.path, change.content);
        const now = new Date().toISOString();
        let record;
        await store.mutate(() => {
          if (!project.artifact.projectRoot || change.path === project.artifact.filename) project.artifact.content = change.content;
          project.artifact.geometryEdits ??= [];
          record = {
            id: randomUUID(), at: now, mode: change.mode, path: change.path, anchor: change.anchor,
            original: change.edit?.original ?? body.geometry?.original ?? null,
            final: change.edit?.final ?? body.geometry?.final ?? null,
            corners: change.edit?.corners ?? body.geometry?.corners ?? [],
            interactionRegions: change.edit?.interactionRegions ?? body.geometry?.interactionRegions ?? []
          };
          project.artifact.geometryEdits.unshift(record);
          if (project.artifact.geometryEdits.length > 50) project.artifact.geometryEdits.length = 50;
          project.updatedAt = now;
          appendLog(project, "decision", "二维坐标已直接写回源码", `${change.path} · ${change.anchor}`);
        });
        return json(response, 200, { edit: record, state: publicState(store, busyProjects) });
      }

      const reviseProjectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/revise$/);
      if (request.method === "POST" && reviseProjectMatch) {
        const project = projectOrThrow(store, reviseProjectMatch[1]);
        if (busyProjects.has(project.id)) throw new Error("这个项目已有任务正在执行，请等待当前调用结束后再提交返修。");
        const { feedback } = await readJSON(request);
        const normalized = String(feedback ?? "").trim().slice(0, 20_000);
        if (!normalized) throw new Error("请先说明整体需要怎样修改。");
        const step = project.steps.find((item) => item.id === project.artifactStepId)
          ?? [...project.steps].reverse().find((item) => ["review", "approved"].includes(item.status));
        if (!step) throw new Error("当前产物没有可重新打开的完成步骤。");
        await store.mutate(() => {
          const now = new Date().toISOString();
          if (step.status === "review") rejectStep(project, step.id, normalized);
          else if (step.status === "approved") reopenStep(project, step.id, normalized);
          else throw new Error(`当前步骤处于“${step.status}”，不能发起整体返修。`);
          project.phase = "workspace";
          project.pendingAction = null;
          project.lastError = null;
          if (project.executionMode === "continuous") {
            project.executionRun = { ...(project.executionRun ?? {}), status: "cancelled", completedAt: now, error: null };
          } else if (project.executionMode?.startsWith("adaptive")) {
            project.executionRun = { ...(project.executionRun ?? {}), status: "ready", completedAt: null, error: null, awaitingStepIds: [] };
          }
          appendLog(project, "revision", "从演示窗口发起整体返修", normalized, step.id);
          project.updatedAt = now;
        });
        return json(response, 200, { stepId: step.id, repairQueued: !project.isPaused, state: publicState(store, busyProjects) });
      }

      const debugLocateMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/debug\/locate$/);
      if (request.method === "POST" && debugLocateMatch) {
        const project = projectOrThrow(store, debugLocateMatch[1]);
        if (!project.artifact || (project.artifact.kind !== "html" && !isRuntimePreviewArtifact(project.artifact))) throw new Error("当前项目没有可回溯的图形预览。");
        const body = await readJSON(request);
        const step = project.steps.find((item) => item.id === project.artifactStepId)
          ?? [...project.steps].reverse().find((item) => item.result?.artifact || item.subprocesses?.some((subprocess) => subprocess.result?.artifact));
        if (!step) throw new Error("找不到生成当前预览的步骤，无法建立调试记录。");
        const subprocess = step.subprocesses?.find((item) => item.id === project.artifactSubprocessId)
          ?? [...(step.subprocesses ?? [])].reverse().find((item) => item.result?.artifact || ["review", "approved"].includes(item.status))
          ?? null;
        const target = body.target && typeof body.target === "object"
          ? body.target
          : { kind: "dom", element: body.element };
        const element = target.element && typeof target.element === "object" ? target.element : body.element;
        const candidates = await findPreviewSourceCandidates(project.artifact, target);
        const exactCandidates = target.traceId
          ? candidates.filter((candidate) => candidate.signals.includes(`traceId=${String(target.traceId).slice(0, 240)}`))
          : [];
        const callKey = `preview-trace:${project.id}`;
        if (activeModeCalls.has(callKey)) throw new Error("已有一个预览源码回溯正在进行，请稍候。");
        activeModeCalls.add(callKey);
        try {
          const traced = exactCandidates.length === 1
            ? {
                request: { kind: "trace_preview_source_exact", traceId: target.traceId },
                rawOutput: JSON.stringify({ status: "success", source: exactCandidates[0].path }),
                result: {
                  source: exactCandidates[0],
                  decisionSummary: `运行时 traceId “${target.traceId}”唯一命中该源码位置，无需 Agent 推测。`
                }
              }
            : await traceRunner({ project: structuredClone(project), step: structuredClone(step), subprocess: subprocess ? structuredClone(subprocess) : null, target, element, candidates }, await harnessSettings());
          const now = new Date().toISOString();
          const locationMethod = exactCandidates.length === 1 ? "exact" : exactCandidates.length > 1 ? "combined" : "inferred";
          const confidence = locationMethod === "exact" ? 1 : locationMethod === "combined" ? 0.82 : 0.55;
          const locationEvidence = traced.result.source.signals ?? [];
          const appendedRequirements = project.context.filter((item) => item.stepId === step.id && ["correction", "decision"].includes(item.kind)).map((item) => item.content);
          const completionLogs = project.decisionLog.filter((item) => item.stepId === step.id).slice(-20).map((item) => ({ at: item.at, title: item.title, detail: item.detail }));
          const record = {
            id: randomUUID(), createdAt: now, updatedAt: now, status: "open",
            stepId: step.id, subprocessId: subprocess?.id ?? null,
            initialRequirement: project.goal,
            appendedRequirements,
            agentExecutionSummary: String(subprocess?.result?.assistantMessage ?? step.conversation?.findLast((item) => item.role === "assistant")?.text ?? "尚无该子进程的执行摘要。"),
            completionLogs,
            target,
            element,
            source: traced.result.source,
            locationMethod,
            confidence,
            locationEvidence,
            agentDecisionSummary: traced.result.decisionSummary,
            feedback: ""
          };
          await store.mutate(() => {
            step.debugRecords ??= [];
            step.debugRecords.push(record);
            if (subprocess) { subprocess.debugRecords ??= []; subprocess.debugRecords.push(structuredClone(record)); }
            project.selectedStepId = step.id;
            project.updatedAt = now;
            appendLog(project, "debug", "预览元素已回溯到源码", `${record.source.path}：L${record.source.startLine}–L${record.source.endLine}`, step.id);
          });
          await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "preview-trace", status: "success", request: traced.request, output: traced.rawOutput }).catch(() => null);
          return json(response, 200, { record, state: publicState(store, busyProjects) });
        } finally {
          activeModeCalls.delete(callKey);
        }
      }

      const debugFeedbackMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/debug\/([^/]+)$/);
      if (request.method === "POST" && debugFeedbackMatch) {
        const project = projectOrThrow(store, debugFeedbackMatch[1]);
        const step = project.steps.find((item) => item.id === debugFeedbackMatch[2]);
        if (!step) throw new Error("调试记录对应步骤不存在。");
        const { feedback } = await readJSON(request);
        const normalized = String(feedback ?? "").trim().slice(0, 20_000);
        if (!normalized) throw new Error("请先填写修改意见。");
        const record = (step.debugRecords ?? []).find((item) => item.id === debugFeedbackMatch[3]);
        if (!record) throw new Error("调试记录不存在。");
        if (busyProjects.has(project.id)) throw new Error("这个项目已有任务正在执行，请等待当前调用结束后再提交修改。");
        await store.mutate(() => {
          const now = new Date().toISOString();
          if (step.status === "review") rejectStep(project, step.id, normalized, record.subprocessId ?? null);
          else if (step.status === "approved") reopenStep(project, step.id, normalized, record.subprocessId ?? null);
          else throw new Error(`当前步骤处于“${step.status}”，不能从这条调试记录发起返修。`);
          record.feedback = normalized; record.status = "feedback-recorded"; record.updatedAt = now;
          const subprocess = step.subprocesses?.find((item) => item.id === record.subprocessId);
          const nested = subprocess?.debugRecords?.find((item) => item.id === record.id);
          if (nested) { nested.feedback = normalized; nested.status = record.status; nested.updatedAt = now; }
          project.phase = "workspace";
          project.pendingAction = null;
          project.lastError = null;
          if (project.executionMode === "continuous") {
            project.executionRun = { ...(project.executionRun ?? {}), status: "cancelled", completedAt: now, error: null };
          } else if (project.executionMode?.startsWith("adaptive")) {
            project.executionRun = { ...(project.executionRun ?? {}), status: "ready", completedAt: null, error: null, awaitingStepIds: [] };
          }
          appendLog(project, "debug", "调试修改意见已锁定到返修版本", `${record.source?.path ?? "未知源码"}：${normalized}`, step.id);
          project.updatedAt = now;
        });
        return json(response, 200, { record, repairQueued: !project.isPaused, state: publicState(store, busyProjects) });
      }

      const sourceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/source$/);
      if (request.method === "GET" && sourceMatch) {
        const project = projectOrThrow(store, sourceMatch[1]);
        const sourceId = url.searchParams.get("sourceId") || "project";
        const sourceRoot = learningSourceRoot(project, store.state.settings, sourceId);
        const requestedPath = url.searchParams.get("path");
        if (requestedPath) return json(response, 200, { file: await readSourceFile(sourceRoot, requestedPath), sourceId });
        return json(response, 200, { workspace: sourceRoot, sourceId, sources: publicLearningSources(project), files: await listSourceFiles(sourceRoot) });
      }

      const localLearningSourceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/sources\/local$/);
      if (request.method === "POST" && localLearningSourceMatch) {
        const project = projectOrThrow(store, localLearningSourceMatch[1]);
        const body = await readJSON(request);
        const requested = String(body.folderPath ?? "").trim();
        if (!path.isAbsolute(requested)) throw new Error("本机文件夹必须使用绝对路径。");
        const root = await realpath(requested).catch(() => null);
        const info = root ? await stat(root).catch(() => null) : null;
        if (!root || !info?.isDirectory()) throw new Error("本机文件夹不存在或无法读取。");
        const duplicate = (project.learningSources ?? []).find((item) => item.root === root);
        if (duplicate) return json(response, 200, { source: duplicate, state: publicState(store, busyProjects) });
        const source = { id: randomUUID(), type: "local", title: path.basename(root) || root, root, createdAt: new Date().toISOString() };
        await store.mutate(() => { project.learningSources ??= []; project.learningSources.push(source); project.updatedAt = source.createdAt; });
        return json(response, 201, { source, state: publicState(store, busyProjects) });
      }

      const learningImportStartMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/sources\/import$/);
      if (request.method === "POST" && learningImportStartMatch) {
        const project = projectOrThrow(store, learningImportStartMatch[1]);
        const body = await readJSON(request);
        const id = randomUUID();
        const title = String(body.title ?? "桌面导入").trim().slice(0, 120) || "桌面导入";
        const root = path.join(dataDirectory, "learning-imports", project.id, ".staging", id);
        await mkdir(root, { recursive: true });
        pendingLearningImports.set(id, { id, projectId: project.id, title, root, fileCount: 0, byteCount: 0 });
        return json(response, 201, { importId: id, limits: { maxFiles: MAX_LEARNING_IMPORT_FILES, maxBytes: MAX_LEARNING_IMPORT_BYTES, maxFileBytes: MAX_LEARNING_IMPORT_FILE_BYTES } });
      }

      const learningImportFileMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/sources\/import\/([^/]+)\/file$/);
      if (request.method === "POST" && learningImportFileMatch) {
        const project = projectOrThrow(store, learningImportFileMatch[1]);
        const pending = pendingLearningImports.get(learningImportFileMatch[2]);
        if (!pending || pending.projectId !== project.id) throw new Error("学习导入批次不存在或已经结束。");
        if (pending.fileCount >= MAX_LEARNING_IMPORT_FILES) throw new Error(`一次最多导入 ${MAX_LEARNING_IMPORT_FILES} 个源码文件。`);
        const relative = safeLearningImportPath(request.headers["x-learning-path"]);
        const bytes = await readBuffer(request, MAX_LEARNING_IMPORT_FILE_BYTES);
        if (pending.byteCount + bytes.length > MAX_LEARNING_IMPORT_BYTES) throw new Error("一次导入的源码总量不能超过 20 MiB。");
        const destination = path.resolve(pending.root, relative);
        const boundary = path.resolve(pending.root);
        const inside = path.relative(boundary, destination);
        if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("导入文件路径越界。");
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
        pending.fileCount += 1;
        pending.byteCount += bytes.length;
        return json(response, 201, { path: relative, fileCount: pending.fileCount, byteCount: pending.byteCount });
      }

      const learningImportFinishMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/sources\/import\/([^/]+)$/);
      if (request.method === "POST" && learningImportFinishMatch) {
        const project = projectOrThrow(store, learningImportFinishMatch[1]);
        const pending = pendingLearningImports.get(learningImportFinishMatch[2]);
        if (!pending || pending.projectId !== project.id) throw new Error("学习导入批次不存在或已经结束。");
        if (!pending.fileCount) throw new Error("没有可导入的源码文件。");
        const root = path.join(dataDirectory, "learning-imports", project.id, pending.id);
        await mkdir(path.dirname(root), { recursive: true });
        await rename(pending.root, root);
        const source = { id: pending.id, type: "upload", title: pending.title, root, fileCount: pending.fileCount, byteCount: pending.byteCount, createdAt: new Date().toISOString() };
        await store.mutate(() => { project.learningSources ??= []; project.learningSources.push(source); project.updatedAt = source.createdAt; });
        pendingLearningImports.delete(pending.id);
        return json(response, 201, { source, state: publicState(store, busyProjects) });
      }

      if (request.method === "DELETE" && learningImportFinishMatch) {
        const project = projectOrThrow(store, learningImportFinishMatch[1]);
        const pending = pendingLearningImports.get(learningImportFinishMatch[2]);
        if (!pending || pending.projectId !== project.id) return json(response, 200, { cancelled: false });
        pendingLearningImports.delete(pending.id);
        await rm(pending.root, { recursive: true, force: true });
        return json(response, 200, { cancelled: true });
      }

      const githubLearningSourceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/sources\/github$/);
      if (request.method === "POST" && githubLearningSourceMatch) {
        const project = projectOrThrow(store, githubLearningSourceMatch[1]);
        const body = await readJSON(request);
        const repository = parseGitHubRepositoryURL(body.url);
        const duplicate = (project.learningSources ?? []).find((item) => item.type === "github" && item.url === repository.webURL);
        if (duplicate) return json(response, 200, { source: duplicate, state: publicState(store, busyProjects) });
        const projectWorkspace = resolveProjectWorkspace(project, store.state.settings);
        const repositoryRoot = path.join(projectWorkspace, ".loopcanvas-learning", "repositories");
        const destination = path.join(repositoryRoot, `${repository.owner}-${repository.repository}-${randomUUID().slice(0, 8)}`);
        await mkdir(repositoryRoot, { recursive: true });
        const cloned = await processRunner("git", ["clone", "--depth", "1", "--filter=blob:none", "--single-branch", "--", repository.url, destination], {
          cwd: repositoryRoot, timeoutMs: 5 * 60 * 1000, env: { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" }
        });
        if (cloned.code !== 0) {
          await rm(destination, { recursive: true, force: true }).catch(() => {});
          throw new Error(cloned.stderr.trim() || "GitHub 仓库导入失败，请确认仓库公开且 Git 可用。");
        }
        const source = { id: randomUUID(), type: "github", title: `${repository.owner}/${repository.repository}`, root: destination, url: repository.webURL, createdAt: new Date().toISOString() };
        await store.mutate(() => { project.learningSources ??= []; project.learningSources.push(source); project.updatedAt = source.createdAt; });
        return json(response, 201, { source, state: publicState(store, busyProjects) });
      }

      const repositoryOverviewMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/sources\/([^/]+)\/overview$/);
      if (repositoryOverviewMatch && ["GET", "POST"].includes(request.method)) {
        const project = projectOrThrow(store, repositoryOverviewMatch[1]);
        const source = (project.learningSources ?? []).find((item) => item.id === repositoryOverviewMatch[2]);
        if (!source || source.type !== "github") throw new Error("只有已打开的 GitHub 仓库可以生成文档概要。");
        if (request.method === "GET") {
          const prepared = await buildRepositoryOverviewDocuments(source.root);
          return json(response, 200, { source: { id: source.id, title: source.title, url: source.url }, estimate: prepared.estimate, generated: Boolean(source.overviewGeneratedAt), documents: source.documentOverviews ?? [] });
        }
        const body = await readJSON(request);
        if (body.confirmed !== true) throw new Error("生成仓库文档概要会计入 Token 消耗，请先明确确认。");
        const callKey = `learning:${project.id}`;
        if (activeModeCalls.has(callKey)) throw new Error("这个项目已有学习解释正在生成。");
        const prepared = await buildRepositoryOverviewDocuments(source.root);
        if (!prepared.documents.length) throw new Error("仓库中没有找到支持的代码文档。");
        const controller = new AbortController();
        activeModeCalls.add(callKey);
        try {
          const summaries = [];
          const settings = await harnessSettings();
          for (let index = 0; index < prepared.documents.length; index += 20) {
            const batch = prepared.documents.slice(index, index + 20);
            const generated = await repositoryOverviewRunner({ project: structuredClone(project), source: structuredClone(source), documents: batch }, settings, controller.signal);
            summaries.push(...generated.result);
            await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "learning-repository-overview", status: "success", request: generated.request, output: generated.rawOutput }).catch(() => null);
          }
          const now = new Date().toISOString();
          await store.mutate(() => {
            source.documentOverviews = summaries;
            source.overviewMeta = prepared.estimate;
            source.overviewGeneratedAt = now;
            project.updatedAt = now;
          });
          return json(response, 200, { documents: structuredClone(summaries), estimate: prepared.estimate, state: publicState(store, busyProjects) });
        } finally {
          activeModeCalls.delete(callKey);
        }
      }

      const learningExplainMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/explain$/);
      if (request.method === "POST" && learningExplainMatch) {
        const project = projectOrThrow(store, learningExplainMatch[1]);
        const callKey = `learning:${project.id}`;
        if (activeModeCalls.has(callKey)) throw new Error("这个项目已有学习解释正在生成。");
        const body = await readJSON(request);
        const sourceId = String(body.sourceId || "project");
        const sourceRoot = learningSourceRoot(project, store.state.settings, sourceId);
        const selection = await readSourceSelection(sourceRoot, body.filePath, body.startLine, body.endLine);
        selection.sourceId = sourceId;
        const module = ["explanation", "data-structure", "syntax", "flow"].includes(body.module) ? body.module : "explanation";
        const controller = new AbortController();
        activeModeCalls.add(callKey);
        try {
          const learned = await learnWithHarness({ project: structuredClone(project), selection, module }, await harnessSettings(), controller.signal);
          const now = new Date().toISOString();
          const thread = {
            id: randomUUID(), title: `${selection.filePath}:${selection.startLine}-${selection.endLine}`,
            module, selection, createdAt: now, updatedAt: now,
            messages: [{ id: randomUUID(), role: "assistant", text: learned.result.answer, at: now, details: learned.result }]
          };
          await store.mutate(() => {
            project.learningThreads ??= [];
            project.learningThreads.unshift(thread);
            if (project.learningThreads.length > 40) project.learningThreads.length = 40;
            project.updatedAt = now;
          });
          await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "learning-explain", status: "success", request: learned.request, output: learned.rawOutput }).catch(() => null);
          return json(response, 200, { thread: structuredClone(thread), state: publicState(store, busyProjects) });
        } finally {
          activeModeCalls.delete(callKey);
        }
      }

      const learningChatMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/chat$/);
      if (request.method === "POST" && learningChatMatch) {
        const project = projectOrThrow(store, learningChatMatch[1]);
        const body = await readJSON(request);
        const question = String(body.question ?? "").trim();
        if (!question) throw new Error("请输入你还没理解的问题。");
        const thread = (project.learningThreads ?? []).find((item) => item.id === body.threadId);
        if (!thread) throw new Error("学习对话不存在，请重新选择代码片段。");
        const callKey = `learning:${project.id}`;
        if (activeModeCalls.has(callKey)) throw new Error("这个项目已有学习解释正在生成。");
        const controller = new AbortController();
        activeModeCalls.add(callKey);
        try {
          const learned = await learnWithHarness({
            project: structuredClone(project), selection: structuredClone(thread.selection), module: thread.module,
            question, history: structuredClone(thread.messages)
          }, await harnessSettings(), controller.signal);
          const now = new Date().toISOString();
          await store.mutate(() => {
            thread.messages.push({ id: randomUUID(), role: "user", text: question, at: now });
            thread.messages.push({ id: randomUUID(), role: "assistant", text: learned.result.answer, at: now, details: learned.result });
            thread.updatedAt = now;
            project.updatedAt = now;
          });
          await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "learning-chat", status: "success", request: learned.request, output: learned.rawOutput }).catch(() => null);
          return json(response, 200, { thread: structuredClone(thread), state: publicState(store, busyProjects) });
        } finally {
          activeModeCalls.delete(callKey);
        }
      }

      const learningThreadMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/threads\/([^/]+)$/);
      if (request.method === "POST" && learningThreadMatch) {
        const project = projectOrThrow(store, learningThreadMatch[1]);
        const threadId = decodeURIComponent(learningThreadMatch[2]);
        const action = String((await readJSON(request)).action ?? "");
        if (!["archive", "restore", "delete", "restore-deleted"].includes(action)) throw new Error("不支持的学习窗口操作。");
        project.learningThreads ??= [];
        project.archivedLearningThreads ??= [];
        project.deletedLearningThreads ??= [];
        const collections = {
          active: project.learningThreads,
          archived: project.archivedLearningThreads,
          deleted: project.deletedLearningThreads
        };
        const locations = Object.entries(collections).map(([name, items]) => ({ name, items, index: items.findIndex((item) => item.id === threadId) }));
        const located = locations.find((item) => item.index >= 0);
        if (!located) throw new Error("学习窗口不存在。");
        const allowed = action === "archive" ? located.name === "active"
          : action === "restore" ? located.name === "archived"
          : action === "restore-deleted" ? located.name === "deleted"
          : located.name !== "deleted";
        if (!allowed) throw new Error("学习窗口当前状态不支持这个操作。");
        const destination = action === "archive" ? collections.archived : action === "delete" ? collections.deleted : collections.active;
        const now = new Date().toISOString();
        await store.mutate(() => {
          const [thread] = located.items.splice(located.index, 1);
          if (action === "archive") thread.archivedAt = now;
          else delete thread.archivedAt;
          if (action === "delete") thread.deletedAt = now;
          else delete thread.deletedAt;
          destination.unshift(thread);
          if (collections.deleted.length > 40) collections.deleted.length = 40;
          project.updatedAt = now;
        });
        return json(response, 200, {
          threadId,
          view: action === "archive" ? "archived" : action === "delete" ? "deleted" : "active",
          state: publicState(store, busyProjects)
        });
      }

      const learningDocumentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/document$/);
      if (request.method === "POST" && learningDocumentMatch) {
        const project = projectOrThrow(store, learningDocumentMatch[1]);
        const callKey = `learning:${project.id}`;
        if (activeModeCalls.has(callKey)) throw new Error("这个项目已有学习解释正在生成。");
        const body = await readJSON(request);
        const module = ["data-structure", "flow"].includes(body.module) ? body.module : null;
        if (!module) throw new Error("完整学习只支持数据结构或运行流程模块。");
        const sourceId = String(body.sourceId || "project");
        const sourceRoot = learningSourceRoot(project, store.state.settings, sourceId);
        const selection = await readSourceDocument(sourceRoot, body.filePath);
        selection.sourceId = sourceId;
        const controller = new AbortController();
        activeModeCalls.add(callKey);
        try {
          const learned = await learnWithHarness({ project: structuredClone(project), selection, module, documentMode: true }, await harnessSettings(), controller.signal);
          const now = new Date().toISOString();
          const moduleTitle = module === "data-structure" ? "数据结构" : "运行流程";
          const thread = {
            id: randomUUID(), title: `${moduleTitle} · ${selection.filePath}`, module, scope: "document", selection,
            createdAt: now, updatedAt: now,
            messages: [{ id: randomUUID(), role: "assistant", text: learned.result.answer, at: now, details: learned.result }]
          };
          await store.mutate(() => {
            project.learningThreads ??= [];
            project.learningThreads.unshift(thread);
            if (project.learningThreads.length > 40) project.learningThreads.length = 40;
            project.updatedAt = now;
          });
          await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "learning-document", status: "success", request: learned.request, output: learned.rawOutput }).catch(() => null);
          return json(response, 200, { thread: structuredClone(thread), state: publicState(store, busyProjects) });
        } finally {
          activeModeCalls.delete(callKey);
        }
      }

      const learningReferenceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/reference$/);
      if (request.method === "POST" && learningReferenceMatch) {
        const project = projectOrThrow(store, learningReferenceMatch[1]);
        const body = await readJSON(request);
        const storedMaterial = body.materialId ? (project.learningMaterials ?? []).find((item) => item.id === body.materialId) : null;
        if (body.materialId && !storedMaterial) throw new Error("学习资料不存在，请重新加入文件栏。");
        const reference = storedMaterial ? structuredClone(storedMaterial) : normalizeTransferReference(body.reference);
        const sourceText = [
          `标题：${reference.title}`,
          reference.url ? `链接：${reference.url}` : "",
          reference.summary ? `来源简介：\n${reference.summary}` : "",
          reference.extractedContent ? `已解析的来源正文/代码：\n${reference.extractedContent}` : "",
          reference.visual?.agentText
        ].filter(Boolean).join("\n\n");
        const selection = {
          filePath: reference.url || reference.title, language: "reference", startLine: 1,
          endLine: Math.max(1, sourceText.split("\n").length), code: sourceText
        };
        const learned = await learnWithHarness({ project: structuredClone(project), selection, module: "explanation" }, await harnessSettings());
        const now = new Date().toISOString();
        const thread = {
          id: randomUUID(), title: `参考解析 · ${reference.title}`, module: "explanation", selection,
          reference, createdAt: now, updatedAt: now,
          messages: [{ id: randomUUID(), role: "assistant", text: learned.result.answer, at: now, details: learned.result }]
        };
        await store.mutate(() => { project.learningThreads ??= []; project.learningThreads.unshift(thread); project.learningThreads.length = Math.min(project.learningThreads.length, 40); project.updatedAt = now; });
        await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "learning-reference", status: "success", request: learned.request, output: learned.rawOutput }).catch(() => null);
        return json(response, 200, { thread: structuredClone(thread), state: publicState(store, busyProjects) });
      }

      const learningMaterialsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/materials$/);
      if (request.method === "POST" && learningMaterialsMatch) {
        const project = projectOrThrow(store, learningMaterialsMatch[1]);
        const material = normalizeTransferReference((await readJSON(request)).reference);
        const duplicate = (project.learningMaterials ?? []).find((item) => item.url && material.url && item.url === material.url || (!item.url && item.title === material.title && item.summary === material.summary));
        if (duplicate && ["success", "provided"].includes(duplicate.extractionStatus)) {
          return json(response, 200, { material: structuredClone(duplicate), state: publicState(store, busyProjects) });
        }
        const attemptedAt = new Date().toISOString();
        if (material.url) {
          try {
            const extracted = await sourceContentExtractor(material);
            material.extractedContent = String(extracted.content ?? "").trim().slice(0, 80_000);
            material.extractionStatus = "success";
            material.extractionError = "";
            material.extractedAt = attemptedAt;
            material.extractionAttemptedAt = attemptedAt;
            material.extractionMetadata = extracted.metadata && typeof extracted.metadata === "object" ? structuredClone(extracted.metadata) : null;
          } catch (error) {
            material.extractedContent = "";
            material.extractionStatus = "failed";
            material.extractionError = String(error?.message || "无法读取来源内容。请稍后重试或手动粘贴正文。").slice(0, 1_000);
            material.extractionAttemptedAt = attemptedAt;
          }
        } else {
          material.extractionStatus = material.extractedContent ? "provided" : "summary-only";
        }
        await store.mutate(() => {
          project.learningMaterials ??= [];
          if (duplicate) Object.assign(duplicate, material, { id: duplicate.id, createdAt: duplicate.createdAt });
          else project.learningMaterials.unshift(material);
          if (project.learningMaterials.length > 100) project.learningMaterials.length = 100;
          project.updatedAt = attemptedAt;
        });
        const stored = duplicate ?? material;
        return json(response, duplicate ? 200 : 201, { material: structuredClone(stored), state: publicState(store, busyProjects) });
      }

      const learningShelfMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/learning\/shelf$/);
      if (request.method === "POST" && learningShelfMatch) {
        const project = projectOrThrow(store, learningShelfMatch[1]);
        const body = await readJSON(request);
        const key = normalizeLearningShelfKey(body.key);
        const action = String(body.action ?? "");
        if (!["pin", "unpin", "archive", "restore"].includes(action)) throw new Error("不支持的学习文件栏操作。");
        await store.mutate(() => {
          project.learningShelf ??= { pinned: [], archived: [] };
          const pinned = new Set(project.learningShelf.pinned ?? []);
          const archived = new Set(project.learningShelf.archived ?? []);
          if (action === "pin") { archived.delete(key); pinned.delete(key); project.learningShelf.pinned = [key, ...pinned].slice(0, 500); project.learningShelf.archived = [...archived].slice(-500); }
          if (action === "unpin") { pinned.delete(key); project.learningShelf.pinned = [...pinned].slice(0, 500); }
          if (action === "archive") { pinned.delete(key); archived.add(key); project.learningShelf.pinned = [...pinned].slice(0, 500); project.learningShelf.archived = [...archived].slice(-500); }
          if (action === "restore") { archived.delete(key); project.learningShelf.archived = [...archived].slice(-500); }
          project.updatedAt = new Date().toISOString();
        });
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const executionReferenceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/references$/);
      if (request.method === "POST" && executionReferenceMatch) {
        const project = projectOrThrow(store, executionReferenceMatch[1]);
        const reference = await hydrateSVGReference(normalizeTransferReference((await readJSON(request)).reference), sourceContentExtractor);
        const duplicate = (project.executionReferences ?? []).find((item) => item.url && item.url === reference.url || (!item.url && item.title === reference.title && item.summary === reference.summary));
        await store.mutate(() => {
          if (duplicate) {
            Object.assign(duplicate, {
              extractedContent: reference.extractedContent,
              extractedAt: reference.extractedAt,
              extractionAttemptedAt: reference.extractionAttemptedAt,
              extractionStatus: reference.extractionStatus,
              extractionMetadata: reference.extractionMetadata,
              extractionError: reference.extractionError,
              visual: reference.visual
            });
            const contextItem = project.context?.find((item) => item.id === duplicate.contextId);
            if (contextItem) contextItem.content = executionReferenceContextContent(duplicate);
          } else {
            project.executionReferences ??= [];
            project.executionReferences.unshift(reference);
            if (project.executionReferences.length > 30) project.executionReferences.length = 30;
            reference.contextId = appendContext(project, "reference", executionReferenceContextContent(reference), null, "用户拖入").id;
            appendLog(project, "decision", "加入跨模式执行参考", reference.title);
          }
          project.updatedAt = new Date().toISOString();
        });
        return json(response, 200, { reference: duplicate ?? reference, state: publicState(store, busyProjects) });
      }

      const executionReferenceItemMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/references\/([^/]+)$/);
      if (request.method === "DELETE" && executionReferenceItemMatch) {
        const project = projectOrThrow(store, executionReferenceItemMatch[1]);
        const referenceId = decodeURIComponent(executionReferenceItemMatch[2]);
        let removed;
        await store.mutate(() => {
          project.executionReferences ??= [];
          const index = project.executionReferences.findIndex((item) => item.id === referenceId);
          if (index < 0) throw new Error("执行参考不存在或已经移除。");
          [removed] = project.executionReferences.splice(index, 1);
          const legacyContent = executionReferenceContextContent(removed);
          project.context = (project.context ?? []).filter((item) => item.id !== removed.contextId
            && !(item.kind === "reference" && item.stepId == null && item.author === "用户拖入" && item.content === legacyContent));
          appendLog(project, "decision", "移除跨模式执行参考", removed.title);
          project.updatedAt = new Date().toISOString();
        });
        return json(response, 200, { removed, state: publicState(store, busyProjects) });
      }

      if (request.method === "POST" && url.pathname === "/api/explore") {
        const body = await readJSON(request);
        const project = body.projectId ? projectOrThrow(store, String(body.projectId)) : null;
        const query = String(body.query ?? "").trim();
        const requestedKind = body.kind === "art" ? "art" : "research";
        if (!query) throw new Error("请输入要探索的问题。");
        const collection = project ? (project.explorationThreads ??= []) : store.state.explorationThreads;
        const existing = body.threadId ? collection.find((item) => item.id === body.threadId) : null;
        if (body.threadId && !existing) throw new Error("探索对话不存在，请新建探索。");
        const kind = existing ? (existing.kind === "art" ? "art" : "research") : requestedKind;
        if (existing && requestedKind !== kind) throw new Error("探索类型与已有对话不一致，请新建探索。");
        // Independent pages may run together, but one conversation must stay ordered.
        const callKey = JSON.stringify(["explore", project?.id ?? null, existing ? "thread" : "page", existing?.id ?? String(body.pageId || randomUUID())]);
        if (activeModeCalls.has(callKey)) throw new Error("这个搜索页面正在检索，请等待完成或新建搜索页。");
        activeModeCalls.add(callKey);
        try {
          const explored = await exploreRunner({ project: project ? structuredClone(project) : null, query, history: structuredClone(existing?.messages ?? []), kind }, await harnessSettings({ requiredPlugins: ["tool-web"] }));
          const now = new Date().toISOString();
          let thread = existing;
          await store.mutate(() => {
            // Other operations can replace state while the network request is running.
            const currentProject = project ? store.project(project.id)
              ?? store.state.archivedProjects.find((item) => item.id === project.id) : null;
            if (project && !currentProject) throw new Error("搜索所属项目已不存在，无法保存结果。");
            const currentCollection = currentProject ? (currentProject.explorationThreads ??= []) : store.state.explorationThreads;
            thread = existing ? currentCollection.find((item) => item.id === existing.id) : null;
            if (existing && !thread) throw new Error("搜索对话已发生变化，请新建搜索页。");
            if (!thread) {
              thread = { id: randomUUID(), title: query.slice(0, 56), kind, projectId: project?.id ?? null, createdAt: now, updatedAt: now, messages: [] };
              currentCollection.unshift(thread);
              const sameKindThreads = currentCollection.filter((item) => (item.kind === "art" ? "art" : "research") === kind);
              for (const stale of sameKindThreads.slice(40)) {
                if (activeModeCalls.has(JSON.stringify(["explore", project?.id ?? null, "thread", stale.id]))) continue;
                const staleIndex = currentCollection.findIndex((item) => item.id === stale.id);
                if (staleIndex >= 0) currentCollection.splice(staleIndex, 1);
              }
            }
            thread.kind ??= kind;
            thread.messages.push({ id: randomUUID(), role: "user", text: query, at: now });
            thread.messages.push({ id: randomUUID(), role: "assistant", text: explored.result.answer, at: now, details: explored.result });
            thread.updatedAt = now;
            if (currentProject) currentProject.updatedAt = now;
          });
          await writeConversationRecord(dataDirectory, { projectId: project?.id ?? "global-exploration", operation: "explore", status: "success", request: explored.request, output: explored.rawOutput }).catch(() => null);
          return json(response, 200, { thread: structuredClone(thread) });
        } finally {
          activeModeCalls.delete(callKey);
        }
      }

      const checkpointMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/checkpoints$/);
      if (request.method === "POST" && checkpointMatch) {
        const { reason } = await readJSON(request);
        await restoreProject(checkpointMatch[1], () => store.createCheckpoint(checkpointMatch[1], String(reason ?? "手动检查点")), false);
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const restoreCheckpointMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/checkpoints\/restore$/);
      if (request.method === "POST" && restoreCheckpointMatch) {
        const { checkpointId = "" } = await readJSON(request);
        await restoreProject(restoreCheckpointMatch[1], () => store.restoreCheckpoint(restoreCheckpointMatch[1], String(checkpointId || "") || null));
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const pauseMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/pause$/);
      if (request.method === "POST" && pauseMatch) {
        const project = projectOrThrow(store, pauseMatch[1]);
        await pauseProject(project);
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const resumeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/resume$/);
      if (request.method === "POST" && resumeMatch) {
        const project = projectOrThrow(store, resumeMatch[1]);
        await resumeProject(project);
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const resetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reset$/);
      if (request.method === "POST" && resetMatch) {
        const project = projectOrThrow(store, resetMatch[1]);
        activeControllers.get(project.id)?.abort();
        await store.createCheckpoint(project.id, "返回需求输入前自动保存");
        await store.mutate(() => {
          project.phase = "intake"; project.goal = ""; project.steps = []; project.selectedStepId = null;
          project.context = []; project.decisionLog = []; project.agents = []; project.attachments = [];
          project.directives = []; project.artifact = null; project.isPaused = false; project.handoff = null;
        });
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const planMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/plan$/);
      if (request.method === "POST" && planMatch) {
        const project = projectOrThrow(store, planMatch[1]);
        const body = await readJSON(request);
        if (busyProjects.has(project.id)) throw new Error("这个项目已有任务正在执行。");
        if (project.isPaused) throw new Error("任务已暂停，请先继续。");
        if (project.steps.length) await store.createCheckpoint(project.id, "重新规划前自动保存");
        await store.mutate((state) => {
          const goal = String(body.goal ?? project.goal).trim();
          if (!goal) throw new Error("请先输入目标。");
          const wasDraft = !project.goal;
          const goalChanged = Boolean(project.goal) && project.goal !== goal;
          project.goal = goal;
          project.title ||= goal.slice(0, 28);
          project.directives = analyzeDirectives(goal);
          if (wasDraft) {
            appendContext(project, "user", goal, null, "用户");
            appendLog(project, "system", "收到用户需求", "由 Harness 判断一步直达或真实执行图，并立即开始。");
          } else if (goalChanged) {
            appendContext(project, "user", goal, null, "用户更新需求");
            appendLog(project, "decision", "更新原始需求并重新规划", "已用修改后的需求替换上次失败的规划请求。");
          }
          const selected = new Set(Array.isArray(body.attachmentIds) ? body.attachmentIds : []);
          const claimed = state.draftAttachments.filter((item) => selected.has(item.id));
          const hashes = new Set(project.attachments.map((item) => item.sha256));
          project.attachments.push(...claimed.filter((item) => !hashes.has(item.sha256)));
          state.draftAttachments = state.draftAttachments.filter((item) => !selected.has(item.id));
        });
        await hydrateProjectSVGReferences(project, store, sourceContentExtractor);
        busyProjects.add(project.id);
        const controller = new AbortController();
        activeControllers.set(project.id, controller);
        const routeCheckpointId = await checkpointBeforeCall(project, "判断与执行前", { kind: "execution" }, controller);
        await store.mutate(() => {
          project.phase = "planning";
          project.lastError = null;
          project.pendingAction = { type: "route_project", status: "running", goal: project.goal, stepId: null, feedback: "", createdAt: new Date().toISOString(), error: null };
          project.updatedAt = new Date().toISOString();
        });
        const runtime = store.state.settings.agentRuntime === "codex" ? "codex" : "dsh";
        updateRuntime(project.id, { active: true, runtime, activity: `调用 ${runtime === "codex" ? "Codex" : "DeepSeek Harness"} 判断并开始执行`, percent: null, stepId: null, stepTitle: null });
        try {
          const planned = await planRunner(structuredClone(project), await harnessSettings(), controller.signal, recordAgentEvent(project.id, runtime));
          if (!ownsProjectCall(activeControllers, project.id, controller) || controller.signal.aborted) throw new Error("任务已暂停，Agent 进程已取消。");
          if (store.state.settings.smartRouting !== false && planned.result.executionShape !== "graph") throw new Error("智能路由规划必须返回 Graph；已拒绝会绕过独立执行与审核链的 single 结果。");
          if (planned.result.executionShape === "single") {
            await recoverPrimaryArtifact(planned.result.primaryArtifact, project.workspace, planned.result.execution);
            await validateStepResult(planned.result.steps[0], planned.result.execution, { requireArtifact: true });
            if (planned.result.execution.verificationPassed !== true || planned.result.execution.blockingIssues?.length) throw new Error("一步直达最终验证未通过或仍有阻断问题。");
          }
          await store.mutate(() => {
            applyAdaptiveRoute(project, planned.result);
            if (planned.result.executionShape === "single" && store.state.settings.smartRouting === false) {
              assertPrimaryArtifactMatches(project, planned.result.execution);
              commitAdaptiveSingle(project, planned.result);
              project.steps[0].rollbackCheckpointId = routeCheckpointId;
              const checkpoint = project.checkpoints.find((item) => item.id === routeCheckpointId);
              checkpoint.stepId = project.steps[0].id;
              checkpoint.stepIds = [project.steps[0].id];
            } else {
              project.pendingAction = null;
            }
          });
          updateRuntime(project.id, { active: false, activity: planned.result.executionShape === "single" ? "已一步完成并交付" : "执行节点已就绪", percent: planned.result.executionShape === "single" ? 100 : 0 });
          releaseProjectCall(activeControllers, busyProjects, project.id, controller);
          await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "route-project", status: "success", request: planned.request, output: planned.rawOutput }).catch(() => null);
          return json(response, 200, { state: publicState(store, busyProjects) });
        } catch (error) {
          const failureContext = error.executionContext && typeof error.executionContext === "object" ? error.executionContext : null;
          if (ownsProjectCall(activeControllers, project.id, controller)) {
            await store.mutate(() => {
              project.phase = "intake";
              project.lastError = error.message;
              project.pendingAction = { ...(project.pendingAction ?? { type: "route_project", goal: project.goal }), status: controller.signal.aborted ? "cancelled" : "failed", error: error.message };
            });
            await writeConversationRecord(dataDirectory, {
              projectId: project.id,
              operation: "route-project",
              status: "failed",
              runtime,
              error: error.message,
              request: failureContext?.request,
              output: failureContext?.rawOutput
            }).catch(() => null);
            const diagnostic = await writeDiagnostic(dataDirectory, { operation: "route-project", projectId: project.id, error: error.message }).catch(() => null);
            if (diagnostic) await store.mutate(() => appendLog(project, "system", "判断或执行失败", `脱敏诊断：${diagnostic.path ?? diagnostic.filename}`));
          }
          updateRuntime(project.id, { active: false, activity: controller.signal.aborted ? "任务已暂停" : `判断或执行失败：${error.message}` });
          throw error;
        } finally {
          releaseProjectCall(activeControllers, busyProjects, project.id, controller);
        }
      }

      const adaptiveCautionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/caution$/);
      if (request.method === "POST" && adaptiveCautionMatch) {
        const project = projectOrThrow(store, adaptiveCautionMatch[1]);
        if (!project.executionMode.startsWith("adaptive")) throw new Error("只有自适应执行节点可以设置谨慎等级。");
        if (busyProjects.has(project.id)) throw new Error("节点正在执行，不能修改谨慎等级。");
        const { cautionLevel = "inherit" } = await readJSON(request);
        await store.mutate(() => setStepCaution(project, adaptiveCautionMatch[2], String(cautionLevel)));
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const adaptiveDirectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/direction$/);
      if (request.method === "POST" && adaptiveDirectionMatch) {
        const project = projectOrThrow(store, adaptiveDirectionMatch[1]);
        if (busyProjects.has(project.id)) throw new Error("节点正在执行，不能提交方向答复。");
        const { answer = "", optionId = "", supplemental = "" } = await readJSON(request);
        const step = project.steps.find((item) => item.id === adaptiveDirectionMatch[2]);
        if (!step) throw new Error("步骤不存在。");
        await store.createCheckpoint(project.id, "确认方向前", { stepId: step.id, kind: "decision" });
        await store.mutate(() => {
          // A user selection is input, not an independently reviewed execution result.
          // Resolve the decision's remaining acceptance criteria through the normal
          // executor/reviewer chain, which can ask a specific follow-up if needed.
          step.directionExecutionRequired = store.state.settings.smartRouting !== false && enforceAgentReviewChain;
          answerStepDirection(project, step.id, { answer, optionId, supplemental });
          step.agentReview = null;
          step.reviewPending = false;
          step.lastError = null;
          project.lastError = null;
          project.executionRun = { ...(project.executionRun ?? {}), status: "ready", error: null, awaitingStepIds: [] };
        });
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const adaptiveRunMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/run$/);
      if (request.method === "POST" && adaptiveRunMatch) {
        const project = projectOrThrow(store, adaptiveRunMatch[1]);
        if (project.executionMode !== "adaptive-graph") throw new Error("只有多节点自适应执行图可以使用这个入口。");
        if (!busyProjects.has(project.id) && (project.steps.some((step) => step.status === "running") || project.executionRun?.status === "running" || project.pendingAction?.status === "running")) {
          await store.mutate(() => recoverInterruptedAdaptiveExecution(project));
        }
        if (project.isPaused) throw new Error("任务已暂停，请先继续。");
        if (busyProjects.has(project.id)) throw new Error("这个项目已有任务正在执行。");
        await hydrateProjectSVGReferences(project, store, sourceContentExtractor);
        const body = await readJSON(request);
        let schedulingMode = ["ask", "sequential", "parallel"].includes(body.mode) ? body.mode : "ask";
        const requestedStepId = String(body.stepId ?? "").trim();
        if (busyProjects.has(project.id)) throw new Error("这个项目已有任务正在执行。");
        busyProjects.add(project.id);
        const controller = new AbortController();
        activeControllers.set(project.id, controller);
        let activeStepIds = [];
        const runtime = store.state.settings.agentRuntime === "codex" ? "codex" : "dsh";
        try {
          await store.mutate(() => {
            const now = new Date().toISOString();
            project.executionRun = { status: "running", startedAt: project.executionRun?.startedAt ?? now, completedAt: null, error: null, awaitingStepIds: [] };
            project.pendingAction = { type: "adaptive_run", status: "running", goal: project.goal, stepId: requestedStepId || null, feedback: "", createdAt: now, error: null };
            project.lastError = null;
          });
          const settings = await harnessSettings();
          let guard = 0;
          while (guard < project.steps.length * 3 + 3) {
            guard += 1;
            let ready = [];
            await store.mutate(() => { ready = readyAdaptiveSteps(project); });
            if (requestedStepId && ready.length) {
              const requestedStep = ready.find((step) => step.id === requestedStepId);
              if (!requestedStep) throw new Error("指定节点当前不可执行；请先完成依赖、方向确认或回退该节点。");
              ready = [requestedStep];
            }
            const awaitingDirection = ready.filter((step) => step.requiresUserDirection && !step.directionAnswer);
            if (awaitingDirection.length) {
              for (const step of awaitingDirection) {
                const stepNumber = project.steps.findIndex((item) => item.id === step.id) + 1;
                await store.createCheckpoint(project.id, `第 ${stepNumber} 步 · 决策前 · ${step.title}`, {
                  stepId: step.id,
                  kind: "decision",
                  key: `decision:${step.id}`
                });
              }
              await store.mutate(() => {
                project.selectedStepId = awaitingDirection[0].id;
                project.executionRun = { ...(project.executionRun ?? {}), status: "awaiting_direction", awaitingStepIds: awaitingDirection.map((step) => step.id), error: null };
                project.pendingAction = null;
                appendLog(project, "decision", "等待用户确认目标方向", awaitingDirection.map((step) => step.title).join("、"), awaitingDirection[0].id);
              });
              break;
            }
            if (!ready.length) {
              if (!project.steps.every((step) => step.status === "approved")) throw new Error("执行图没有可运行节点；依赖关系可能形成死锁。");
              if (store.state.settings.smartRouting !== false && enforceAgentReviewChain && project.steps.some((step) => step.agentReview?.verdict !== "pass")) {
                throw new Error("智能路由不能进入最终审核：仍有节点缺少 Sol high 独立审核通过记录。");
              }
              const lastResult = [...project.steps].reverse().find((step) => step.result)?.result;
              if (!lastResult) throw new Error("执行图完成但没有节点结果。");
              // A final verification report must not replace the actual deliverable.
              const carrier = structuredClone(lastResult);
              if (!isPrimaryArtifact(project, carrier.artifact)) {
                carrier.artifact = isPrimaryArtifact(project, project.artifact) ? structuredClone(project.artifact) : null;
              }
              await recoverPrimaryArtifact(project.primaryArtifact, project.workspace, carrier);
              await validateStepResult({ ...project.steps.at(-1), kind: "deliver" }, carrier, { requireArtifact: true });
              assertPrimaryArtifactMatches(project, carrier);
              if (carrier.verificationPassed !== true || carrier.blockingIssues?.length) throw new Error("最终交付验证未通过或仍有阻断问题。");
              let finalReview = null;
              if (store.state.settings.smartRouting !== false && enforceAgentReviewChain) {
                await store.mutate(() => {
                  project.artifact = carrier.artifact;
                  project.phase = "final_review";
                  project.finalReview = { status: "running", verdict: null, summary: "", findings: [], at: new Date().toISOString() };
                });
                updateRuntime(project.id, { active: true, activity: "裁决者正在最终审核", percent: 100 });
                finalReview = await finalReviewRunner(structuredClone(project), settings, controller.signal, recordAgentEvent(project.id, runtime));
              }
              await store.mutate(() => {
                project.artifact = carrier.artifact;
                project.finalReview = finalReview ? { status: finalReview.verdict === "pass" ? "passed" : finalReview.verdict, verdict: finalReview.verdict, summary: finalReview.summary, findings: finalReview.findings ?? [], acceptanceResults: finalReview.acceptanceResults ?? [], repairStepIds: finalReview.repairStepIds ?? [], route: finalReview.route ?? null, at: new Date().toISOString() } : project.finalReview ?? null;
                project.phase = !finalReview || finalReview.verdict === "pass" ? "complete" : "workspace";
                project.executionRun = { ...(project.executionRun ?? {}), status: !finalReview || finalReview.verdict === "pass" ? "completed" : "ready", completedAt: !finalReview || finalReview.verdict === "pass" ? new Date().toISOString() : null, error: null, awaitingStepIds: [] };
                project.pendingAction = null;
                project.lastError = null;
                if (finalReview && finalReview.verdict !== "pass") {
                  for (const stepId of minimalRepairStepIds(project, finalReview.repairStepIds ?? [])) {
                    const repairStep = project.steps.find((item) => item.id === stepId);
                    if (!repairStep || repairStep.status !== "approved") continue;
                    const findings = (finalReview.findings ?? []).filter((item) => !item.criterion || (finalReview.acceptanceResults ?? []).some((result) => result.criterion === item.criterion && !result.passed));
                    const instructions = findings.map((item) => item.repairInstruction).filter(Boolean).join("；");
                    reopenForRepair(project, stepId, [finalReview.summary, instructions].filter(Boolean).join("；"), null, findings);
                  }
                  appendLog(project, "review", "最终审核要求返修", finalReview.summary, finalReview.repairStepIds?.[0] ?? null);
                } else {
                  appendLog(project, "review", finalReview ? "最终审核 Agent 通过" : "兼容模式交付", finalReview?.summary ?? carrier.summary, project.steps.at(-1)?.id ?? null);
                }
              });
              break;
            }
            const parallelReady = canRunParallel(ready);
            if (ready.length > 1 && parallelReady && schedulingMode === "ask") {
              const stepNumbers = ready.map((step) => project.steps.findIndex((item) => item.id === step.id) + 1);
              const batchKey = ready.map((step) => step.id).sort().join("+");
              await store.createCheckpoint(project.id, `第 ${stepNumbers.join("、")} 步 · 并行方式决策前 · ${ready.map((step) => step.title).join("、")}`, {
                stepId: ready[0].id,
                kind: "decision",
                key: `decision:parallel:${batchKey}`
              });
              await store.mutate(() => {
                project.executionRun = { ...(project.executionRun ?? {}), status: "awaiting_parallel_choice", awaitingStepIds: ready.map((step) => step.id), error: null };
                project.pendingAction = null;
                appendLog(project, "decision", "等待并行方式选择", ready.map((step) => step.title).join("、"));
              });
              break;
            }
            if (schedulingMode === "parallel" && !parallelReady && ready.length > 1) throw new Error("这些节点的并行安全范围不完整或互相重叠，不能并行执行。");
            const batch = schedulingMode === "parallel" && parallelReady ? ready : [ready[0]];
            activeStepIds = batch.map((step) => step.id);
            const stepNumbers = batch.map((step) => project.steps.findIndex((item) => item.id === step.id) + 1);
            const coordinate = stepNumbers.length > 1 ? `第 ${stepNumbers.join("、")} 步` : `第 ${stepNumbers[0]} 步`;
            await store.createCheckpoint(
              project.id,
              `${coordinate} · 重要执行前 · ${batch.map((step) => step.title).join("、")}`,
              {
                stepId: batch[0].id,
                kind: "execution",
                stepIds: batch.map((step) => step.id)
              }
            );
            await store.mutate(() => {
              for (const step of batch) { step.status = "running"; step.lastError = null; }
              project.selectedStepId = batch[0].id;
            });
            updateRuntime(project.id, { active: true, runtime, activity: batch.length > 1 ? `并行执行 ${batch.length} 个节点` : `执行节点：${batch[0].title}`, percent: null, stepId: batch[0].id, stepTitle: batch[0].title });
            const snapshot = structuredClone(project);
            const settledBatch = await Promise.allSettled(batch.map((step) => {
              const snapshotStep = snapshot.steps.find((item) => item.id === step.id);
              return executeRunner(snapshot, snapshotStep, settings, repairFeedbackForStep(snapshotStep), controller.signal, recordAgentEvent(project.id, runtime, step.id));
            }));
            if (!ownsProjectCall(activeControllers, project.id, controller) || controller.signal.aborted) throw new Error("任务已暂停，Agent 进程已取消。");
            // Do not release the project lock while a sibling is still writing.
            // Keep completed siblings so a retry cannot accidentally run them twice.
            for (let index = 0; index < batch.length; index += 1) {
              const outcome = settledBatch[index];
              if (outcome.status === "rejected" && outcome.reason?.completedExecution) {
                try {
                  await validateAdaptiveNodeResult(project, batch[index], outcome.reason.completedExecution.result);
                  outcome.execution = outcome.reason.completedExecution;
                } catch (reason) { outcome.reason = reason; }
              }
              if (outcome.status !== "fulfilled" || outcome.value.needsUserDirection) continue;
              try { await validateAdaptiveNodeResult(project, batch[index], outcome.value.result); }
              catch (reason) { settledBatch[index] = { status: "rejected", reason, execution: outcome.value }; }
            }
            if (settledBatch.some((outcome) => outcome.status === "rejected")) {
              await store.mutate(() => {
                settledBatch.forEach((outcome, index) => {
                  if (outcome.status !== "fulfilled") return;
                  const step = batch[index], executed = outcome.value;
                  if (executed.needsUserDirection) {
                    Object.assign(step, { requiresUserDirection: true, directionQuestion: executed.directionQuestion, directionOptions: executed.directionOptions, selectedDirectionOptionId: null, directionSupplement: "", directionAnswer: "", status: "ready", lastError: null });
                  } else commitAdaptiveStep(project, step.id, executed);
                });
              });
              await Promise.all(settledBatch.map((outcome, index) => outcome.status === "fulfilled"
                ? writeConversationRecord(dataDirectory, { projectId: project.id, operation: "execute-node", status: outcome.value.needsUserDirection ? "awaiting_user_direction" : "success", request: outcome.value.request, output: outcome.value.rawOutput, nodeId: batch[index].id }).catch(() => null)
                : null));
              const failures = settledBatch.flatMap((outcome, index) => outcome.status === "rejected" ? [{ ...outcome, step: batch[index] }] : []);
              const error = new Error(failures.map(({ step, reason }) => `${step.title}：${reason?.message || reason}`).join("；"));
              error.executedStepIds = failures.map(({ step }) => step.id);
              error.executedBatch = failures.map(({ execution, reason }) => execution ?? { request: reason?.executionContext?.request, rawOutput: reason?.executionContext?.rawOutput });
              throw error;
            }
            const executedBatch = settledBatch.map((outcome) => outcome.value);
            const clarificationIndexes = executedBatch.map((executed, index) => executed?.needsUserDirection ? index : -1).filter((index) => index >= 0);
            if (clarificationIndexes.length) {
              let repairRequested = false;
              await store.mutate(() => {
                for (let index = 0; index < batch.length; index += 1) {
                  const step = batch[index];
                  const executed = executedBatch[index];
                  if (executed.needsUserDirection) {
                    step.requiresUserDirection = true;
                    step.directionQuestion = executed.directionQuestion;
                    step.directionOptions = executed.directionOptions;
                    step.selectedDirectionOptionId = null;
                    step.directionSupplement = "";
                    step.directionAnswer = "";
                    step.status = "ready";
                    step.lastError = null;
                    appendLog(project, "decision", "Agent 请求用户确认", executed.directionQuestion, step.id);
                  } else {
                    if (!commitAdaptiveStep(project, step.id, executed)) repairRequested = true;
                  }
                }
                project.executionRun = { ...(project.executionRun ?? {}), status: repairRequested ? "ready" : "running", awaitingStepIds: [], error: null };
                if (repairRequested) project.pendingAction = null;
              });
              await Promise.all(executedBatch.map((executed, index) => writeConversationRecord(dataDirectory, {
                projectId: project.id,
                operation: "execute-node",
                status: executed.needsUserDirection ? "awaiting_user_direction" : "success",
                request: executed.request,
                output: executed.rawOutput,
                nodeId: batch[index].id
              }).catch(() => null)));
              activeStepIds = [];
              if (schedulingMode === "parallel") schedulingMode = "ask";
              if (repairRequested) break;
              continue;
            }
            let repairRequested = false;
            await store.mutate(() => {
              for (let index = 0; index < batch.length; index += 1) if (!commitAdaptiveStep(project, batch[index].id, executedBatch[index])) repairRequested = true;
              project.executionRun = { ...(project.executionRun ?? {}), status: repairRequested ? "ready" : "running", awaitingStepIds: [], error: null };
              if (repairRequested) project.pendingAction = null;
            });
            await Promise.all(executedBatch.map((executed, index) => writeConversationRecord(dataDirectory, { projectId: project.id, operation: "execute-node", status: "success", request: executed.request, output: executed.rawOutput, nodeId: batch[index].id }).catch(() => null)));
            activeStepIds = [];
            if (schedulingMode === "parallel") schedulingMode = "ask";
            if (repairRequested) break;
            if (requestedStepId && !project.steps.every((step) => step.status === "approved")) {
              await store.mutate(() => {
                readyAdaptiveSteps(project);
                project.executionRun = { ...(project.executionRun ?? {}), status: "ready", error: null, awaitingStepIds: [] };
                project.pendingAction = null;
              });
              break;
            }
          }
          updateRuntime(project.id, { active: false, activity: project.executionRun?.status === "completed" ? "全部节点已验证并交付" : project.executionRun?.status === "awaiting_direction" ? "等待目标方向答复" : project.executionRun?.status === "ready" ? "等待手动执行" : "等待并行方式选择", percent: project.executionRun?.status === "completed" ? 100 : null, stepId: project.selectedStepId, stepTitle: project.steps.find((step) => step.id === project.selectedStepId)?.title ?? null });
          // The returned snapshot must not claim a finished request is still busy.
          releaseProjectCall(activeControllers, busyProjects, project.id, controller);
          return json(response, 200, { state: publicState(store, busyProjects) });
        } catch (error) {
          if (ownsProjectCall(activeControllers, project.id, controller)) {
            const capturedExecutions = Array.isArray(error.executedBatch) ? error.executedBatch : [];
            const capturedStepIds = Array.isArray(error.executedStepIds) ? error.executedStepIds : [];
            await store.mutate(() => {
              for (const step of project.steps.filter((item) => activeStepIds.includes(item.id) && item.status === "running")) {
                const capturedIndex = capturedStepIds.indexOf(step.id);
                if (capturedIndex >= 0 && capturedExecutions[capturedIndex]?.result) {
                  step.result = capturedExecutions[capturedIndex].result;
                  step.reviewPending = capturedExecutions[capturedIndex].reviewPending === true;
                }
                step.status = "error";
                step.lastError = error.message;
              }
              project.executionRun = { ...(project.executionRun ?? {}), status: controller.signal.aborted ? "cancelled" : "failed", completedAt: new Date().toISOString(), error: error.message, awaitingStepIds: [] };
              project.pendingAction = { ...(project.pendingAction ?? { type: "adaptive_run" }), status: controller.signal.aborted ? "cancelled" : "failed", error: error.message };
              project.lastError = controller.signal.aborted ? null : error.message;
              project.updatedAt = new Date().toISOString();
            });
            const failureContext = error.executionContext && typeof error.executionContext === "object" ? error.executionContext : null;
            if (capturedExecutions.length) {
              await Promise.all(capturedExecutions.map((executed, index) => writeConversationRecord(dataDirectory, {
                projectId: project.id,
                operation: "execute-node",
                status: "failed",
                runtime,
                request: executed.request,
                output: executed.rawOutput,
                nodeId: capturedStepIds[index] ?? null,
                error: error.message
              }).catch(() => null)));
            } else {
              await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "execute-node", status: "failed", runtime, error: error.message, request: failureContext?.request, output: failureContext?.rawOutput, nodeId: failureContext?.stepId ?? activeStepIds[0] ?? null }).catch(() => null);
            }
            const diagnostic = await writeDiagnostic(dataDirectory, { operation: "execute-node", projectId: project.id, stepId: activeStepIds[0] ?? null, error: error.message }).catch(() => null);
            if (diagnostic) await store.mutate(() => appendLog(project, "system", "节点执行失败", `脱敏诊断：${diagnostic.path ?? diagnostic.filename}`, activeStepIds[0] ?? null));
          }
          updateRuntime(project.id, { active: false, activity: controller.signal.aborted ? "执行已暂停" : `节点执行失败：${error.message}` });
          throw error;
        } finally {
          releaseProjectCall(activeControllers, busyProjects, project.id, controller);
        }
      }

      const selectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/select$/);
      if (request.method === "POST" && selectMatch) {
        const project = projectOrThrow(store, selectMatch[1]);
        const step = project.steps.find((item) => item.id === selectMatch[2]);
        if (!step || ["running", "approved"].includes(step.status)) throw new Error("当前步骤不能切换方案。");
        const { optionId, subprocessId = "" } = await readJSON(request);
        const subprocess = step.subprocesses?.length ? step.subprocesses.find((item) => item.id === subprocessId) : null;
        if (step.subprocesses?.length && !subprocess) throw new Error("请选择方案所属的子进程。");
        const optionOwner = subprocess ?? step;
        if (["running", "review", "approved"].includes(optionOwner.status)) throw new Error(`当前${subprocess ? "子进程" : "步骤"}不能切换方案。`);
        if (!(optionOwner.options ?? []).some((option) => option.id === optionId)) throw new Error("方案不属于当前子进程或已经失效。");
        await store.mutate(() => {
          optionOwner.selectedOptionId = optionId; project.updatedAt = new Date().toISOString();
          const option = optionOwner.options.find((item) => item.id === optionId);
          const target = `${step.title}${subprocess ? ` / ${subprocess.title}` : ""}`;
          appendLog(project, "decision", `选择方案：${option.title}`, `用于「${target}」；执行并验收后才成为已确认决策。`, step.id);
          appendContext(project, "decision", `为「${target}」选择方案「${option.title}」。`, step.id, "用户");
        });
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const recoverExecutionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/execution\/recover$/);
      if (request.method === "POST" && recoverExecutionMatch) {
        const project = projectOrThrow(store, recoverExecutionMatch[1]);
        if (project.executionMode !== "continuous") throw new Error("只有连续执行项目可以恢复生成结果。");
        if (project.artifact) throw new Error("项目已经登记主交付物，无需恢复。");
        if (busyProjects.has(project.id)) throw new Error("这个项目已有任务正在执行。");
        const records = await listConversationRecords(dataDirectory, project.id);
        let recovered = null;
        let latestError = null;
        for (const metadata of records.filter((item) => item.operation === "execute-project" && Number(item.sizeBytes) > 0)) {
          try {
            const record = await readConversationRecord(dataDirectory, project.id, metadata.id);
            if (!record.output?.trim()) continue;
            const raw = JSON.parse(record.output);
            const requestId = String(raw.requestID ?? raw.request_id ?? "");
            if (!requestId) throw new Error("保存的 Agent 结果缺少 requestID。");
            const normalized = normalizeProjectExecutionResponse(raw, requestId, project);
            const candidate = {
              request: record.request,
              rawOutput: record.output,
              result: executionResultForServer(normalized),
              checkpoints: normalized.checkpoints
            };
            await validateContinuousExecution(project, candidate);
            recovered = candidate;
            break;
          } catch (error) {
            latestError ??= error instanceof Error ? error : new Error(String(error));
          }
        }
        if (!recovered) throw new Error(`没有找到仍与当前方案一致且可验证的已生成结果。${latestError ? ` 最近原因：${latestError.message}` : ""}`);
        await store.mutate(() => commitContinuousExecution(project, recovered, { recovered: true }));
        updateRuntime(project.id, { active: false, activity: "已恢复生成结果，等待预览验收", percent: 100, stepId: project.steps.at(-1)?.id ?? null, stepTitle: project.steps.at(-1)?.title ?? null });
        await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "recover-execution", status: "success", request: recovered.request, output: recovered.rawOutput }).catch(() => null);
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const continuousExecuteMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/execute$/);
      if (request.method === "POST" && continuousExecuteMatch) {
        const project = projectOrThrow(store, continuousExecuteMatch[1]);
        const { feedback = "" } = await readJSON(request);
        if (store.state.settings.smartRouting !== false) throw new Error("智能路由要求逐节点执行、独立审核和最终裁决；连续单 Agent 模式仅可在关闭智能路由后用于旧项目。");
        if (project.executionMode !== "continuous") throw new Error("这个历史项目仍使用逐步执行模式。");
        if (!project.steps.length || !project.primaryArtifact) throw new Error("项目尚未生成包含主交付物的成果路线。");
        if (project.steps.some((step) => ["L2", "L3"].includes(step.riskLevel))) throw new Error("成果路线包含高风险节点，需要先逐项确认，不能连续自动执行。");
        if (busyProjects.has(project.id)) throw new Error("这个项目已有任务正在执行。");
        await hydrateProjectSVGReferences(project, store, sourceContentExtractor);
        busyProjects.add(project.id);
        const controller = new AbortController();
        activeControllers.set(project.id, controller);
        await checkpointBeforeCall(project, "连续构建前（整次执行）", { kind: "execution", stepId: project.steps[0].id, stepIds: project.steps.map((step) => step.id) }, controller);
        await store.mutate(() => {
          const now = new Date().toISOString();
          project.executionRun = { status: "running", startedAt: now, completedAt: null, error: null };
          project.pendingAction = { type: "execute_project", status: "running", goal: project.goal, stepId: null, subprocessId: null, feedback: String(feedback), createdAt: now, error: null };
          project.lastError = null;
          project.updatedAt = now;
          appendLog(project, "execution", "开始连续构建项目", `同一个 Agent 将在 ${project.workspace} 内连续维护主交付物 ${project.primaryArtifact.filename}。`);
        });
        const runtime = store.state.settings.agentRuntime === "codex" ? "codex" : "dsh";
        updateRuntime(project.id, { active: true, runtime, activity: `调用 ${runtime === "codex" ? "Codex" : "DeepSeek Harness"}：连续构建 ${project.primaryArtifact.filename}`, percent: null, stepId: null, stepTitle: null });
        let lastValidationError = null;
        try {
          const settings = await harnessSettings();
          let executed;
          let attempt = 0;
          let attemptFeedback = String(feedback).trim();
          while (attempt < MAX_EXECUTION_VALIDATION_ATTEMPTS) {
            attempt += 1;
            executed = await executeProjectRunner(structuredClone(project), settings, attemptFeedback, controller.signal, recordAgentEvent(project.id, runtime));
            if (!ownsProjectCall(activeControllers, project.id, controller) || controller.signal.aborted) throw new Error("任务已暂停，Agent 进程已取消。");
            if (executed.needsUserDirection) {
              const choices = executed.directionOptions.map((option) => option.description ? `${option.label}（${option.description}）` : option.label).join("；");
              const error = new Error(`连续构建需要你先确认：${executed.directionQuestion} 可选：${choices}`);
              error.executionContext = { request: executed.request, rawOutput: executed.rawOutput };
              throw error;
            }
            try {
              await validateContinuousExecution(project, executed);
              break;
            } catch (validationError) {
              const error = validationError instanceof Error ? validationError : new Error(String(validationError));
              lastValidationError = error;
              await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "execute-project", status: "failed", request: executed.request, output: executed.rawOutput, error: `自动校验拒绝（${attempt}/${MAX_EXECUTION_VALIDATION_ATTEMPTS}）：${error.message}` }).catch(() => null);
              if (attempt >= MAX_EXECUTION_VALIDATION_ATTEMPTS) { error.executionAttemptRecorded = true; throw error; }
              attemptFeedback = [String(feedback).trim(), automaticExecutionRepairContext(error, attempt)].filter(Boolean).join("\n\n");
            }
          }
          await store.mutate(() => commitContinuousExecution(project, executed));
          updateRuntime(project.id, { active: false, activity: "主交付物已生成，等待预览验收", percent: 100, stepId: project.steps.at(-1)?.id ?? null, stepTitle: project.steps.at(-1)?.title ?? null });
          releaseProjectCall(activeControllers, busyProjects, project.id, controller);
          await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "execute-project", status: "success", request: executed.request, output: executed.rawOutput }).catch(() => null);
          return json(response, 200, { state: publicState(store, busyProjects) });
        } catch (caughtError) {
          const originalError = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
          const error = lastValidationError && originalError !== lastValidationError
            ? new Error(`${lastValidationError.message}；自动纠错重试又失败：${originalError.message}`)
            : originalError;
          if (originalError.executionAttemptRecorded) error.executionAttemptRecorded = true;
          if (ownsProjectCall(activeControllers, project.id, controller)) {
            await store.mutate(() => {
              const cancelled = controller.signal.aborted;
              project.executionRun = { ...(project.executionRun ?? {}), status: cancelled ? "cancelled" : "failed", completedAt: new Date().toISOString(), error: error.message };
              project.lastError = cancelled ? null : error.message;
              project.pendingAction = { ...(project.pendingAction ?? { type: "execute_project", feedback: String(feedback) }), status: cancelled ? "cancelled" : "failed", error: error.message };
              project.updatedAt = new Date().toISOString();
            });
            if (!error.executionAttemptRecorded) await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "execute-project", status: "failed", error: error.message, request: originalError.executionContext?.request, output: originalError.executionContext?.rawOutput }).catch(() => null);
            const diagnostic = await writeDiagnostic(dataDirectory, { operation: "execute-project", projectId: project.id, error: error.message }).catch(() => null);
            if (diagnostic) await store.mutate(() => appendLog(project, "system", "连续构建失败", `脱敏诊断：${diagnostic.path ?? diagnostic.filename}`));
          }
          updateRuntime(project.id, { active: false, activity: controller.signal.aborted ? "连续构建已暂停" : `连续构建失败：${error.message}`, percent: null });
          throw error;
        } finally {
          releaseProjectCall(activeControllers, busyProjects, project.id, controller);
        }
      }

      const preflightMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/execute\/preflight$/);
      if (request.method === "POST" && preflightMatch) {
        const project = projectOrThrow(store, preflightMatch[1]);
        const { subprocessId = "" } = await readJSON(request);
        return json(response, 200, { readiness: executionReadiness(project, preflightMatch[2], subprocessId) });
      }

      const executeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/execute$/);
      if (request.method === "POST" && executeMatch) {
        const project = projectOrThrow(store, executeMatch[1]);
        const step = project.steps.find((item) => item.id === executeMatch[2]);
        const { feedback = "", subprocessId = "" } = await readJSON(request);
        if (!step) throw new Error("步骤不存在或计划已经更新。");
        await hydrateProjectSVGReferences(project, store, sourceContentExtractor);
        const subprocess = step.subprocesses?.length
          ? step.subprocesses.find((item) => item.id === subprocessId)
            ?? step.subprocesses.find((item) => item.id === step.selectedSubprocessId)
            ?? step.subprocesses.find((item) => ["ready", "error"].includes(item.status))
          : null;
        const readiness = executionReadiness(project, step.id, subprocess?.id ?? subprocessId);
        if (!readiness.allowed) throw new Error(`${readiness.title}：${readiness.reasons.join(" ")}`);
        if (busyProjects.has(project.id)) throw new Error("这个项目已有任务正在执行。");
        const isFinalSubprocess = Boolean(subprocess && step.subprocesses.at(-1)?.id === subprocess.id);
        const retryContext = executionRetryContext(project, step);
        const debugFeedback = (subprocess?.debugRecords ?? []).filter((item) => item.feedback).map((item) => `调试记录 ${item.source?.path ?? "未知源码"}：${item.feedback}`).join("\n");
        const repairFeedback = repairFeedbackForStep(step);
        const effectiveFeedback = [String(feedback).trim(), repairFeedback, debugFeedback, retryContext].filter(Boolean).join("\n\n");
        busyProjects.add(project.id);
        const controller = new AbortController();
        activeControllers.set(project.id, controller);
        await checkpointBeforeCall(project, `执行前 · ${step.title}`, { kind: "execution", stepId: step.id }, controller);
        await store.mutate(() => {
          step.status = "running"; project.updatedAt = new Date().toISOString();
          if (subprocess) {
            subprocess.status = "running";
            subprocess.lastError = null;
            subprocess.contextSnapshot = {
              capturedAt: new Date().toISOString(),
              initialRequirement: project.goal,
              appendedRequirements: project.context.filter((item) => item.stepId === step.id && ["correction", "decision"].includes(item.kind)).map((item) => item.content),
              completedSubprocesses: step.subprocesses.filter((item) => item.status === "approved").map((item) => ({ id: item.id, title: item.title, summary: item.result?.summary ?? "" })),
              currentArtifact: project.artifact ? { title: project.artifact.title, filename: project.artifact.filename, files: project.artifact.files ?? [] } : null
            };
            step.selectedSubprocessId = subprocess.id;
          }
          project.pendingAction = { type: "execute", status: "running", goal: project.goal, stepId: step.id, subprocessId: subprocess?.id ?? null, feedback: String(feedback), retryContext, createdAt: new Date().toISOString(), error: null };
          step.conversation.push({ id: randomUUID(), role: "user", text: effectiveFeedback || `执行：${step.title}${subprocess ? ` / ${subprocess.title}` : ""}`, subprocessId: subprocess?.id ?? null });
          appendLog(project, "execution", subprocess ? "开始子进程执行" : "开始单步执行", `只执行「${step.title}${subprocess ? ` / ${subprocess.title}` : ""}」，不会自动进入下一项。`, step.id);
        });
        const runtime = store.state.settings.agentRuntime === "codex" ? "codex" : "dsh";
        updateRuntime(project.id, { active: true, runtime, activity: `调用 ${runtime === "codex" ? "Codex" : "DeepSeek Harness"}：${step.title}${subprocess ? ` / ${subprocess.title}` : ""}`, percent: completedStepPercent(step), stepId: step.id, stepTitle: step.title });
        let lastValidationError = null;
        try {
          const settings = await harnessSettings();
          let executed;
          let attempt = 0;
          let attemptFeedback = effectiveFeedback;
          while (attempt < MAX_EXECUTION_VALIDATION_ATTEMPTS) {
            attempt += 1;
            executed = await executeRunner(structuredClone(project), structuredClone(step), settings, attemptFeedback, controller.signal, recordAgentEvent(project.id, runtime, step.id));
            if (!ownsProjectCall(activeControllers, project.id, controller) || controller.signal.aborted) throw new Error("任务已暂停，Agent 进程已取消。");
            try {
              await validateStepResult(step, executed.result, { requireArtifact: subprocess ? isFinalSubprocess : undefined });
              break;
            } catch (validationError) {
              const error = validationError instanceof Error ? validationError : new Error(String(validationError));
              lastValidationError = error;
              const recorded = await writeConversationRecord(dataDirectory, {
                projectId: project.id,
                operation: "execute",
                status: "failed",
                request: executed.request,
                output: executed.rawOutput,
                error: `自动校验拒绝（${attempt}/${MAX_EXECUTION_VALIDATION_ATTEMPTS}）：${error.message}`
              }).then(() => true, () => false);
              if (attempt >= MAX_EXECUTION_VALIDATION_ATTEMPTS) {
                if (recorded) error.executionAttemptRecorded = true;
                throw error;
              }
              attemptFeedback = [effectiveFeedback, automaticExecutionRepairContext(error, attempt)].filter(Boolean).join("\n\n");
            }
          }
          await store.mutate(() => {
            step.status = executed.agentReview && executed.agentReview.verdict !== "pass" ? "ready" : "review";
            step.result = executed.result;
            step.agentReview = executed.agentReview ? { verdict: executed.agentReview.verdict, summary: executed.agentReview.summary, findings: executed.agentReview.findings ?? [], verifiedEvidence: executed.agentReview.verifiedEvidence ?? [], route: executed.agentReview.route ?? null, reviewedRevision: executed.agentReview.reviewedRevision, at: new Date().toISOString() } : null;
            step.routing = executed.route ? { role: executed.route.role, model: executed.route.model, effort: executed.route.effort, available: executed.route.available, reason: executed.route.selection || executed.route.fallbackReason || "", executorLabel: routeLabel(executed.route, "执行 Agent") } : step.routing ?? null;
            if (executed.agentReview && executed.agentReview.verdict !== "pass") {
              step.revision += 1;
              step.repairFindings = executed.agentReview.findings ?? [];
              step.lastFeedback = [executed.agentReview.summary, ...(executed.agentReview.findings ?? []).map((item) => item.repairInstruction).filter(Boolean)].join("；").slice(0, 8_000);
              project.artifact = null;
              project.artifactStepId = null;
              project.artifactSubprocessId = null;
              project.executionRun = { ...(project.executionRun ?? {}), status: "ready", completedAt: null, error: null, awaitingStepIds: [] };
            }
            if (subprocess) { subprocess.status = executed.agentReview && executed.agentReview.verdict !== "pass" ? "ready" : "review"; subprocess.result = executed.result; subprocess.lastError = null; subprocess.lastFeedback = executed.agentReview && executed.agentReview.verdict !== "pass" ? step.lastFeedback : subprocess.lastFeedback; }
            if (executed.result.artifact && (!executed.agentReview || executed.agentReview.verdict === "pass")) {
              project.artifact = executed.result.artifact;
              project.artifactStepId = step.id;
              project.artifactSubprocessId = subprocess?.id ?? null;
            }
            const now = new Date().toISOString();
            project.context.push({ id: randomUUID(), at: now, kind: "result", content: executed.result.assistantMessage, stepId: step.id, subprocessId: subprocess?.id ?? null });
            step.conversation.push({ id: randomUUID(), role: "assistant", text: executed.result.assistantMessage, subprocessId: subprocess?.id ?? null });
            project.agents.push({ id: randomUUID(), name: subprocess ? `${step.title} / ${subprocess.title}` : step.title, focus: subprocess?.purpose ?? step.purpose, status: "complete", progress: 1, notes: [executed.result.assistantMessage], stepId: step.id, subprocessId: subprocess?.id ?? null });
            appendLog(project, executed.agentReview ? "review" : "execution", executed.agentReview?.verdict === "pass" ? "审核 Agent 通过" : executed.agentReview ? "审核 Agent 退回" : subprocess ? "子进程返回结果" : "Agent 返回结果", executed.agentReview?.summary ?? executed.result.summary, step.id);
            if (attempt > 1) appendLog(project, "execution", "自动纠错已通过", `第 ${attempt}/${MAX_EXECUTION_VALIDATION_ATTEMPTS} 次尝试通过客观校验。`, step.id);
            project.updatedAt = now;
            project.lastError = null;
            project.pendingAction = null;
          });
          updateRuntime(project.id, { active: false, activity: executed.result.requiresPreview ? "可验收预览已生成，等待检查" : executed.result.artifact ? "阶段产物已记录，准备继续" : "子进程已完成，准备继续", percent: completedStepPercent(step) });
          releaseProjectCall(activeControllers, busyProjects, project.id, controller);
          await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "execute", status: "success", request: executed.request, output: executed.rawOutput }).catch(() => null);
          return json(response, 200, { state: publicState(store, busyProjects) });
        } catch (caughtError) {
          const originalError = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
          const error = lastValidationError && originalError !== lastValidationError
            ? new Error(`${lastValidationError.message}；自动纠错重试又失败：${originalError.message}`)
            : originalError;
          if (originalError.executionAttemptRecorded) error.executionAttemptRecorded = true;
          if (ownsProjectCall(activeControllers, project.id, controller)) {
            await store.mutate(() => {
              step.status = "ready";
              if (subprocess) { subprocess.status = "error"; subprocess.lastError = error.message; step.selectedSubprocessId = subprocess.id; }
              project.lastError = error.message;
              project.pendingAction = { ...(project.pendingAction ?? { type: "execute", stepId: step.id, subprocessId: subprocess?.id ?? null, feedback: String(feedback) }), status: controller.signal.aborted ? "cancelled" : "failed", error: error.message };
            });
            if (!error.executionAttemptRecorded) {
              await writeConversationRecord(dataDirectory, { projectId: project.id, operation: "execute", status: "failed", error: error.message, request: originalError.executionContext?.request, output: originalError.executionContext?.rawOutput }).catch(() => null);
            }
            const diagnostic = await writeDiagnostic(dataDirectory, { operation: "execute", projectId: project.id, stepId: step.id, error: error.message }).catch(() => null);
            if (diagnostic) await store.mutate(() => appendLog(project, "system", "单步执行失败", `脱敏诊断：${diagnostic.path ?? diagnostic.filename}`, step.id));
          }
          updateRuntime(project.id, { active: false, activity: controller.signal.aborted ? "执行已暂停" : `执行失败：${error.message}`, percent: completedStepPercent(step) });
          throw error;
        } finally {
          releaseProjectCall(activeControllers, busyProjects, project.id, controller);
        }
      }

      const agentReviewMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/agent-review$/);
      if (request.method === "POST" && agentReviewMatch) {
        const project = projectOrThrow(store, agentReviewMatch[1]);
        const step = project.steps.find((item) => item.id === agentReviewMatch[2]);
        if (!step?.result) throw new Error("当前步骤还没有可审核的执行结果。");
        if (busyProjects.has(project.id)) throw new Error("这个项目已有 Agent 正在运行。");
        busyProjects.add(project.id);
        const controller = new AbortController();
        activeControllers.set(project.id, controller);
        const runtime = store.state.settings.agentRuntime === "codex" ? "codex" : "dsh";
        try {
          updateRuntime(project.id, { active: true, runtime, activity: `审核者正在检查：${step.title}`, stepId: step.id, stepTitle: step.title });
          const review = await reviewRunner({ project: structuredClone(project), step: structuredClone(step), result: structuredClone(step.result) }, await harnessSettings(), controller.signal, recordAgentEvent(project.id, runtime, step.id));
          if (!ownsProjectCall(activeControllers, project.id, controller) || controller.signal.aborted) throw new Error("审核已暂停，未应用迟到结果。");
          if (step.reviewPending) await validateAdaptiveNodeResult(project, step, step.result);
          await store.mutate(() => {
            step.agentReview = { verdict: review.verdict, summary: review.summary, findings: review.findings ?? [], verifiedEvidence: review.verifiedEvidence ?? [], route: review.route ?? null, reviewedRevision: review.reviewedRevision, at: new Date().toISOString() };
            if (review.verdict === "pass") {
              step.status = "approved";
              if (step.reviewPending) {
                step.reviewPending = false;
                step.lastError = null;
                project.lastError = null;
                project.pendingAction = null;
                project.executionRun = { ...(project.executionRun ?? {}), status: "ready", error: null, completedAt: null };
                if (isPrimaryArtifact(project, step.result.artifact)) {
                  project.artifact = step.result.artifact;
                  project.artifactStepId = step.id;
                  project.artifactSubprocessId = null;
                }
              }
              readyAdaptiveSteps(project);
            }
            else if (project.executionMode?.startsWith("adaptive")) {
              const recordedReview = step.agentReview;
              const feedback = [review.summary, ...(review.findings ?? []).map((item) => item.repairInstruction).filter(Boolean)].join("；").slice(0, 8_000);
              reopenForRepair(project, step.id, feedback, null, review.findings ?? [], { preserveDirection: step.directionExecutionRequired === true });
              step.agentReview = recordedReview;
              project.finalReview = null;
            }
            else {
              step.status = "ready";
              step.revision = (step.revision ?? 1) + 1;
              step.repairFindings = review.findings ?? [];
              step.lastFeedback = [review.summary, ...(review.findings ?? []).map((item) => item.repairInstruction).filter(Boolean)].join("；").slice(0, 8_000);
              project.phase = "workspace";
              project.finalReview = null;
              project.artifact = null;
              project.artifactStepId = null;
              project.artifactSubprocessId = null;
              project.executionRun = { ...(project.executionRun ?? {}), status: "ready", completedAt: null, error: null, awaitingStepIds: [] };
              project.pendingAction = null;
            }
            appendLog(project, "review", review.verdict === "pass" ? "审核 Agent 通过" : "审核 Agent 退回", review.summary, step.id);
          });
          updateRuntime(project.id, { active: false, activity: review.verdict === "pass" ? "步骤审核通过" : "步骤审核要求返修" });
          releaseProjectCall(activeControllers, busyProjects, project.id, controller);
          return json(response, 200, { state: publicState(store, busyProjects) });
        } catch (error) {
          if (ownsProjectCall(activeControllers, project.id, controller) && !controller.signal.aborted) {
            await store.mutate(() => {
              project.lastError = error.message;
              if (step.reviewPending) step.lastError = error.message;
              appendLog(project, "review", "步骤审核失败", error.message, step.id);
            });
            updateRuntime(project.id, { active: false, activity: `步骤审核失败：${error.message}` });
          }
          throw error;
        } finally { releaseProjectCall(activeControllers, busyProjects, project.id, controller); }
      }

      const finalReviewMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/final-review$/);
      if (request.method === "POST" && finalReviewMatch) {
        const project = projectOrThrow(store, finalReviewMatch[1]);
        if (!project.artifact) throw new Error("当前还没有主交付物，不能最终审核。");
        if (!project.steps.length || project.steps.some((step) => step.status !== "approved" || (store.state.settings.smartRouting !== false && step.agentReview?.verdict !== "pass"))) {
          throw new Error(store.state.settings.smartRouting !== false ? "所有步骤必须先由独立审核者审核通过，才能进行最终审核。" : "所有步骤必须先通过当前兼容流程的验收，才能进行最终审核。");
        }
        if (busyProjects.has(project.id)) throw new Error("这个项目已有 Agent 正在运行。");
        busyProjects.add(project.id);
        const controller = new AbortController();
        activeControllers.set(project.id, controller);
        const runtime = store.state.settings.agentRuntime === "codex" ? "codex" : "dsh";
        try {
          await store.mutate(() => { project.phase = "final_review"; project.finalReview = { status: "running", verdict: null, summary: "", findings: [], at: new Date().toISOString() }; });
          updateRuntime(project.id, { active: true, runtime, activity: "裁决者正在最终审核", percent: 100 });
          const review = await finalReviewRunner(structuredClone(project), await harnessSettings(), controller.signal, recordAgentEvent(project.id, runtime));
          if (!ownsProjectCall(activeControllers, project.id, controller) || controller.signal.aborted) throw new Error("最终审核已暂停，未应用迟到结果。");
          await store.mutate(() => {
            project.finalReview = { status: review.verdict === "pass" ? "passed" : review.verdict, verdict: review.verdict, summary: review.summary, findings: review.findings ?? [], acceptanceResults: review.acceptanceResults ?? [], repairStepIds: review.repairStepIds ?? [], route: review.route ?? null, at: new Date().toISOString() };
            project.phase = review.verdict === "pass" ? "complete" : "workspace";
            project.executionRun = { ...(project.executionRun ?? {}), status: review.verdict === "pass" ? "completed" : "ready", completedAt: review.verdict === "pass" ? new Date().toISOString() : null, error: null, awaitingStepIds: [] };
            project.pendingAction = null;
            if (review.verdict !== "pass") for (const stepId of minimalRepairStepIds(project, review.repairStepIds ?? [])) {
              const step = project.steps.find((item) => item.id === stepId);
              if (!step) continue;
              if (step.status !== "approved") continue;
              const findings = (review.findings ?? []).filter((item) => !item.criterion || (review.acceptanceResults ?? []).some((result) => result.criterion === item.criterion && !result.passed));
              const instructions = findings.map((item) => item.repairInstruction).filter(Boolean).join("；");
              reopenForRepair(project, stepId, [review.summary, instructions].filter(Boolean).join("；"), null, findings);
            }
            appendLog(project, "review", review.verdict === "pass" ? "最终审核 Agent 通过" : "最终审核要求返修", review.summary, review.repairStepIds?.[0] ?? null);
          });
          updateRuntime(project.id, { active: false, activity: review.verdict === "pass" ? "最终审核通过" : "最终审核要求返修", percent: review.verdict === "pass" ? 100 : null });
          releaseProjectCall(activeControllers, busyProjects, project.id, controller);
          return json(response, 200, { state: publicState(store, busyProjects) });
        } catch (error) {
          if (ownsProjectCall(activeControllers, project.id, controller) && !controller.signal.aborted) {
            await store.mutate(() => {
              project.phase = "workspace";
              project.lastError = error.message;
              project.finalReview = { ...(project.finalReview ?? {}), status: "failed", error: error.message, summary: error.message };
              appendLog(project, "review", "最终审核失败", error.message);
            });
            updateRuntime(project.id, { active: false, activity: `最终审核失败：${error.message}` });
          }
          throw error;
        } finally { releaseProjectCall(activeControllers, busyProjects, project.id, controller); }
      }

      const approveMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/approve$/);
      if (request.method === "POST" && approveMatch) {
        const project = projectOrThrow(store, approveMatch[1]);
        const step = project.steps.find((item) => item.id === approveMatch[2]);
        if (store.state.settings.smartRouting !== false && enforceAgentReviewChain && step?.agentReview?.verdict !== "pass") throw new Error("智能路由下必须先由独立审核者审核通过，不能直接验收。");
        await store.mutate(() => {
          approveStep(project, approveMatch[2]);
          if (store.state.settings.smartRouting !== false && project.steps.every((item) => item.status === "approved")) project.phase = "final_review";
        });
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const rejectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/reject$/);
      if (request.method === "POST" && rejectMatch) {
        const project = projectOrThrow(store, rejectMatch[1]);
        const { feedback } = await readJSON(request);
        await store.mutate(() => rejectStep(project, rejectMatch[2], feedback));
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const reopenMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/reopen$/);
      if (request.method === "POST" && reopenMatch) {
        const project = projectOrThrow(store, reopenMatch[1]);
        const { feedback } = await readJSON(request);
        await store.mutate(() => reopenStep(project, reopenMatch[2], feedback));
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const rollbackMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/rollback$/);
      if (request.method === "POST" && rollbackMatch) {
        const project = projectOrThrow(store, rollbackMatch[1]);
        await restoreProject(project.id, () => store.rollbackStep(project.id, rollbackMatch[2]));
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const repairMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/return-to-repair$/);
      if (request.method === "POST" && repairMatch) {
        const project = projectOrThrow(store, repairMatch[1]);
        if (busyProjects.has(project.id)) throw new Error("项目仍在执行，请暂停或等待结束后再返回修复。");
        const { feedback } = await readJSON(request);
        await store.mutate(() => returnVerificationToRepair(project, repairMatch[2], feedback));
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      const moveMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/steps\/([^/]+)\/move$/);
      if (request.method === "POST" && moveMatch) {
        const project = projectOrThrow(store, moveMatch[1]);
        const { beforeStepId } = await readJSON(request);
        await store.mutate(() => moveStep(project, moveMatch[2], beforeStepId));
        return json(response, 200, { state: publicState(store, busyProjects) });
      }

      if (isAPI) return json(response, 404, { error: "接口不存在。" });
      if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "请求方法不支持。" });
      const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const candidate = path.resolve(publicRoot, relative);
      if (!candidate.startsWith(`${publicRoot}${path.sep}`)) return json(response, 403, { error: "路径已拒绝。" });
      const info = await stat(candidate).catch(() => null);
      if (!info?.isFile()) return json(response, 404, { error: "文件不存在。" });
      response.writeHead(200, {
        "Content-Type": mimeTypes[path.extname(candidate)] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self' http://*.localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
      });
      if (request.method === "HEAD") return response.end();
      createReadStream(candidate).pipe(response);
    } catch (error) {
      json(response, 400, { error: error?.message || "请求失败。" });
    }
  });

  server.once("close", () => { runtimePreviewManager.close().catch(() => null); });
  server.once("close", () => { workflowRuntime.close().finally(() => workflowLibrary.close()); });
  return { server, store, token, remoteManager, runtimePreviewManager, workflowLibrary, workflowRuntime };
}

export async function startServer({ host = "127.0.0.1", port = 4317, remoteHost = "127.0.0.1", remotePort = 4321, ...options } = {}) {
  const runtime = await createLoopCanvasServer(options);
  await new Promise((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(port, host, resolve);
  });
  const address = runtime.server.address();
  let remoteRuntime = null;
  try {
    if (runtime.remoteManager.enabled) remoteRuntime = await startRemoteListener({ manager: runtime.remoteManager, host: remoteHost, port: remotePort });
  } catch (error) {
    await new Promise((resolve) => runtime.server.close(resolve));
    throw error;
  }
  return { ...runtime, url: `http://${host}:${address.port}`, remoteServer: remoteRuntime?.server ?? null, remoteURL: remoteRuntime?.url ?? null };
}
