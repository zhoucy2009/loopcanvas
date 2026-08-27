import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { zstdDecompressSync } from "node:zlib";
import { ensureProjectDocuments, readProjectDocuments } from "./capabilities.js";
import { buildAgentPrompt, serializeAgentRequest } from "./agent-prompt.js";
import { invokeCodex, listCodexModels, resolveCodex } from "./codex.js";

export { listCodexModels, resolveCodex };

// 解析 dsh 输出时的安全上限：超过即明确报错，绝不再静默截断 JSON。
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
// 未指定 outputDir 时（如版本探测）的内存捕获上限。
const MEMORY_CAPTURE_BYTES = 32 * 1024 * 1024;

async function isExecutable(candidate) {
  if (!candidate) return false;
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveDsh({ explicitPath = "", home = os.homedir(), envPath = process.env.PATH ?? "" } = {}) {
  if (explicitPath) return (await isExecutable(explicitPath)) ? explicitPath : null;

  for (const directory of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "dsh");
    if (await isExecutable(candidate)) return candidate;
  }

  const npxRoot = path.join(home, ".npm", "_npx");
  try {
    const entries = await readdir(npxRoot, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(npxRoot, entry.name, "node_modules", ".bin", "dsh");
      if (await isExecutable(candidate)) {
        candidates.push({ candidate, modified: (await stat(path.join(npxRoot, entry.name))).mtimeMs });
      }
    }
    candidates.sort((a, b) => b.modified - a.modified);
    if (candidates[0]) return candidates[0].candidate;
  } catch {}

  const profileCandidate = path.join(home, ".dsh", "profiles", "headless", "node_modules", ".bin", "dsh");
  return (await isExecutable(profileCandidate)) ? profileCandidate : null;
}

export function runProcess(executable, args, { cwd, env = {}, timeoutMs = 30 * 60 * 1000, signal, outputDir } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("任务已取消。"));
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const stdoutPath = outputDir ? path.join(outputDir, "stdout.log") : null;
    const stderrPath = outputDir ? path.join(outputDir, "stderr.log") : null;
    let stdoutStream = null;
    let stderrStream = null;
    if (stdoutPath) {
      stdoutStream = createWriteStream(stdoutPath);
      stderrStream = createWriteStream(stderrPath);
      child.stdout.pipe(stdoutStream);
      child.stderr.pipe(stderrStream);
    } else {
      const collectMemory = (current, chunk) => {
        const combined = Buffer.concat([current, chunk]);
        return combined.length > MEMORY_CAPTURE_BYTES ? combined.subarray(combined.length - MEMORY_CAPTURE_BYTES) : combined;
      };
      child.stdout.on("data", (chunk) => { stdout = collectMemory(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = collectMemory(stderr, chunk); });
    }
    let finished = false;
    const abort = () => {
      if (finished) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      if (finished) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      finished = true;
      stdoutStream?.destroy();
      stderrStream?.destroy();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      finished = true;
      stdoutStream?.end();
      stderrStream?.end();
      resolve({
        code: code ?? -1,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutPath,
        stderrPath
      });
    });
  });
}

async function readCapturedText(outputPath, inline, { ceiling = MAX_OUTPUT_BYTES, label = "Harness 输出" } = {}) {
  if (!outputPath) return inline;
  const info = await stat(outputPath).catch(() => null);
  if (!info) return "";
  if (info.size > ceiling) {
    throw new Error(`${label}超过 ${Math.round(ceiling / 1024 / 1024)} MiB 安全上限，已停止解析；请减小单步产物内容或拆分请求。`);
  }
  return readFile(outputPath, "utf8");
}

async function dshSessionSnapshot(dshHome) {
  const root = path.join(dshHome, "sessions");
  const snapshot = new Map();
  try {
    for (const relative of await readdir(root, { recursive: true })) {
      if (!String(relative).endsWith("session.jsonl.zstd")) continue;
      const file = path.join(root, relative);
      snapshot.set(file, (await stat(file)).mtimeMs);
    }
  } catch {}
  return snapshot;
}

function dshActivity(events) {
  const tool = [...events].reverse().find((event) => event?.type === "tool/call");
  if (!tool) return "DeepSeek Harness 正在执行当前子进程";
  const name = String(tool.data?.name ?? "Harness 工具");
  let args = {};
  try { args = JSON.parse(String(tool.data?.arguments ?? "{}")); } catch {}
  const file = args.path ?? args.file ?? args.filePath ?? args.target;
  if (file && /(?:write|edit|replace|patch|str-replace)/i.test(name)) return `修改文件：${String(file)}`;
  return `调用 ${name} 工具`;
}

export async function readDshSessionTelemetry(file) {
  if (!file) return null;
  let rows;
  try {
    const text = zstdDecompressSync(await readFile(file)).toString("utf8").trim();
    rows = text ? text.split("\n").map((line) => JSON.parse(line)) : [];
  } catch { return null; }
  const samples = new Map();
  let contextWindow = null;
  let lastUsage = null;
  for (const event of rows) {
    if (event.type === "request/context" && Number.isFinite(event.data?.contextWindow)) contextWindow = Number(event.data.contextWindow);
    const usage = event.type === "assistant/chunk" && event.data?.chunk?.type === "usage"
      ? event.data.chunk.usage
      : event.type === "assistant/message" ? event.data?.usage : null;
    if (!usage) continue;
    lastUsage = usage;
    samples.set(`${event.data?.turn ?? "?"}:${event.data?.step ?? "?"}`, usage);
  }
  let input = 0; let cached = 0; let written = 0; let output = 0;
  for (const usage of samples.values()) {
    input += Number(usage.inputTokens ?? 0);
    cached += Number(usage.cacheReadTokens ?? 0);
    written += Number(usage.cacheWriteTokens ?? 0);
    output += Number(usage.outputTokens ?? 0);
  }
  const contextTokens = lastUsage ? Number(lastUsage.inputTokens ?? 0) + Number(lastUsage.cacheReadTokens ?? 0) + Number(lastUsage.cacheWriteTokens ?? 0) : null;
  return {
    activity: dshActivity(rows),
    metrics: {
      runtime: "dsh",
      source: "DeepSeek Harness token-meter",
      cumulativeMode: "delta",
      cumulativeTokens: input + cached + written + output,
      uncachedInputTokens: input,
      cachedInputTokens: cached,
      cacheWriteInputTokens: written,
      outputTokens: output,
      cacheHitRate: input + cached > 0 ? cached / (input + cached) : null,
      contextTokens,
      contextWindow,
      contextPercent: contextTokens != null && contextWindow ? Math.min(1, contextTokens / contextWindow) : null,
      remainingPercent: null,
      remainingLabel: "DSH API 余额",
      remainingText: "Harness 未提供"
    }
  };
}

async function newestChangedDshSession(before, dshHome) {
  const after = await dshSessionSnapshot(dshHome);
  return [...after.entries()]
    .filter(([file, modified]) => !before.has(file) || modified > before.get(file))
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

export async function installationStatus(settings = {}) {
  const [dshPath, codexPath] = await Promise.all([
    resolveDsh({ explicitPath: settings.dshPath }),
    resolveCodex({ explicitPath: settings.codexPath || process.env.LOOPCANVAS_CODEX_EXECUTABLE || "" })
  ]);
  return {
    node: { found: true, path: process.execPath, version: process.version },
    dsh: { found: Boolean(dshPath), path: dshPath },
    codex: { found: Boolean(codexPath), path: codexPath }
  };
}

export async function probeHarness(settings = {}) {
  const dshPath = await resolveDsh({ explicitPath: settings.dshPath });
  if (!dshPath) throw new Error("未找到 dsh。请先运行 npx @deepseek-ai/dsh web。 ");
  const output = await runProcess(dshPath, ["--version"], {
    cwd: os.tmpdir(),
    env: { DSH_HOME: process.env.DSH_HOME || path.join(os.homedir(), ".dsh") },
    timeoutMs: 20_000
  });
  if (output.code !== 0) throw new Error(output.stderr.trim() || "dsh --version 执行失败。");
  return { path: dshPath, version: output.stdout.trim() || "未知版本" };
}

export async function probeCodex(settings = {}) {
  const codexPath = await resolveCodex({ explicitPath: settings.codexPath || process.env.LOOPCANVAS_CODEX_EXECUTABLE || "" });
  if (!codexPath) throw new Error("未找到 Codex。请确认 Codex CLI 或 ChatGPT macOS 应用已安装。");

  const versionOutput = await runProcess(codexPath, ["--version"], { cwd: os.tmpdir(), timeoutMs: 20_000 });
  if (versionOutput.code !== 0) throw new Error(versionOutput.stderr.trim() || "codex --version 执行失败。");

  const helpOutput = await runProcess(codexPath, ["app-server", "--help"], { cwd: os.tmpdir(), timeoutMs: 20_000 });
  const helpText = `${helpOutput.stdout}\n${helpOutput.stderr}`;
  const supportsAppServer = helpOutput.code === 0 && helpText.includes("--listen") && helpText.includes("stdio://");
  if (!supportsAppServer) throw new Error("已找到 Codex，但未验证到 app-server stdio 能力。");

  return {
    path: codexPath,
    version: versionOutput.stdout.trim() || versionOutput.stderr.trim() || "未知版本",
    supportsAppServer: true
  };
}

export async function probeLocalAgents(settings = {}) {
  const installation = await installationStatus(settings);
  const [dsh, codex] = await Promise.all([
    installation.dsh.found
      ? probeHarness(settings)
        .then((probe) => ({ ...installation.dsh, ...probe, ready: true }))
        .catch((error) => ({ ...installation.dsh, ready: false, error: error.message }))
      : Promise.resolve({ ...installation.dsh, ready: false, error: "未找到 dsh。" }),
    installation.codex.found
      ? probeCodex(settings)
        .then((probe) => ({ ...installation.codex, ...probe, ready: true }))
        .catch((error) => ({ ...installation.codex, ready: false, error: error.message }))
      : Promise.resolve({ ...installation.codex, ready: false, error: "未找到 Codex。" })
  ]);
  return { ...installation, dsh, codex };
}

function yamlQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function extractJSONObject(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [];
  if (fenced) candidates.push(fenced);
  candidates.push(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    const parsed = tryParseJSON(candidate);
    if (parsed) return parsed;
  }
  // 模型输出常在结尾漏掉闭合括号：用栈统计未闭合的 `{`/`[`，按反序补上 `}`/`]` 后再解析。
  const repaired = repairTrailingBraces(trimmed);
  if (repaired) return repaired;
  const balanced = findLastBalancedJSON(trimmed);
  if (balanced) {
    const parsed = tryParseJSON(balanced);
    if (parsed) return parsed;
  }
  const sizeMB = (Buffer.byteLength(trimmed) / 1024 / 1024).toFixed(1);
  throw new Error(`Agent 没有返回可解析的完整 JSON 对象（输出约 ${sizeMB} MiB）。若输出被截断或过大，请减小产物内容后重试。`);
}

function tryParseJSON(candidate) {
  try { return JSON.parse(candidate); } catch { return null; }
}

function repairTrailingBraces(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const root = text.slice(start);
  const closers = missingClosers(root);
  if (!closers || closers.length < 1 || closers.length > 8) return null;
  return tryParseJSON(`${root}${closers.reverse().join("")}`);
}

// 返回需要按反序补上的闭合符；遇到括号不匹配或无法可靠判断时返回 null。
function missingClosers(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      const expected = ch;
      if (stack.length && stack[stack.length - 1] === expected) stack.pop();
      else return null;
    }
  }
  return stack;
}

// 从文本末尾向前扫描，返回最后一个括号平衡的 JSON 对象；可容忍 JSON 前的说明文字和 JSON 后的尾随内容。
function findLastBalancedJSON(text) {
  let depth = 0;
  let endPos = -1;
  let inString = false;
  let escaped = false;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "}") {
      if (depth === 0) endPos = index;
      depth += 1;
    } else if (ch === "{") {
      depth -= 1;
      if (depth === 0 && endPos >= 0) return text.slice(index, endPos + 1);
    }
  }
  return null;
}

function normalizeOption(raw = {}) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
    title: String(raw.title ?? "未命名方案"),
    subtitle: String(raw.subtitle ?? ""),
    technicalReason: String(raw.technicalReason ?? raw.technical_reason ?? ""),
    advantages: Array.isArray(raw.advantages) ? raw.advantages.map(String) : [],
    tradeoffs: Array.isArray(raw.tradeoffs) ? raw.tradeoffs.map(String) : [],
    downstreamImpact: String(raw.downstreamImpact ?? raw.downstream_impact ?? ""),
    isRecommended: Boolean(raw.isRecommended ?? raw.is_recommended),
    origin: ["userExplicit", "userInferred", "model"].includes(raw.origin) ? raw.origin : "model",
    matchedDirectiveIDs: Array.isArray(raw.matchedDirectiveIDs ?? raw.matched_directive_ids) ? (raw.matchedDirectiveIDs ?? raw.matched_directive_ids).map(String) : [],
    rankReason: String(raw.rankReason ?? raw.rank_reason ?? "")
  };
}

const subprocessBlueprints = {
  decision: [["确认边界", "核对目标、约束和决策边界。"], ["比较方案", "比较当前步骤候选方案的证据与取舍。"], ["记录决定", "记录选择依据和下游影响。"]],
  build: [["读取当前状态", "只读取完成本步骤需要的文件和上下文。"], ["实施局部改动", "完成一个可独立检查的改动。"], ["验证局部结果", "运行直接相关检查并保存证据。"]],
  integrate: [["确认集成边界", "定位输入、输出和受影响模块。"], ["完成集成", "连接已确认产物。"], ["检查回归", "验证主流程和直接边界。"]],
  verify: [["准备验证", "确认验收条件和验证方法。"], ["执行验证", "运行检查并保存证据。"], ["归档结论", "记录阻断问题、偏差和下一步。"]],
  deliver: [["核对交付范围", "确认交付物、入口和运行条件。"], ["整理交付物", "形成可使用的完整交付包。"], ["最终验收", "按原始要求逐项核查。"]]
};

function normalizePlannedSubprocesses(rawStep = {}, kind = "build") {
  const supplied = rawStep.subprocesses ?? rawStep.subProcesses ?? rawStep.sub_processes;
  const input = Array.isArray(supplied) && supplied.length >= 3 && supplied.length <= 6
    ? supplied
    : (subprocessBlueprints[kind] ?? subprocessBlueprints.build).map(([title, purpose]) => ({ title, purpose }));
  return input.map((item, index) => ({
    id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
    title: String(item.title ?? `子进程 ${index + 1}`),
    purpose: String(item.purpose ?? ""),
    options: Array.isArray(item.options) ? item.options.map(normalizeOption) : []
  }));
}

function normalizeDirectionOptions(rawStep, question) {
  const supplied = rawStep.directionOptions ?? rawStep.direction_options;
  const options = (Array.isArray(supplied) ? supplied : []).slice(0, 5).map((item, index) => {
    if (typeof item === "string") return { id: `direction-${index + 1}`, label: item.trim(), description: "" };
    return {
      id: String(item?.id ?? item?.value ?? `direction-${index + 1}`).trim(),
      label: String(item?.label ?? item?.title ?? item?.value ?? "").trim(),
      description: String(item?.description ?? item?.detail ?? "").trim()
    };
  }).filter((item) => item.id && item.label);
  if (options.length >= 2) return options.filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
  const inferred = [...String(question ?? "").matchAll(/(?:方向\s*)?([A-Z])\s*[（(]([^）)]+)[）)]/gi)].slice(0, 5).map((match) => ({
    id: `direction-${match[1].toLowerCase()}`,
    label: `方向 ${match[1].toUpperCase()}`,
    description: match[2].trim()
  }));
  return inferred.length >= 2 ? inferred : [];
}

export function normalizePlanResponse(raw, requestId) {
  const response = raw.response && typeof raw.response === "object" ? raw.response : raw;
  const returnedId = response.requestID ?? response.request_id;
  if (returnedId && returnedId !== requestId) throw new Error("Agent 返回了错误的 requestID。");
  if ((response.status ?? "success") === "failure") throw new Error(response.error || "Agent 判断或执行失败。");
  if (!Array.isArray(response.steps) || response.steps.length < 1 || response.steps.length > 12) throw new Error("Harness 必须返回 1–12 个真实执行节点。");
  const requestedShape = response.executionShape ?? response.execution_shape;
  const executionShape = ["single", "graph"].includes(requestedShape) ? requestedShape : response.steps.length === 1 ? "single" : "graph";
  if (executionShape === "single" && response.steps.length !== 1) throw new Error("一步直达只能包含一个执行节点。");
  if (executionShape === "graph" && response.steps.length < 2) throw new Error("多节点执行图至少需要两个节点。");
  const steps = response.steps.map((rawStep) => {
    const kind = ["analyze", "decision", "build", "integrate", "verify", "deliver"].includes(rawStep.kind) ? rawStep.kind : "build";
    const directionQuestion = String(rawStep.directionQuestion ?? rawStep.direction_question ?? "").trim();
    return {
      id: typeof rawStep.id === "string" && rawStep.id ? rawStep.id : randomUUID(),
      title: String(rawStep.title ?? "未命名步骤"),
      purpose: String(rawStep.purpose ?? ""),
      kind,
      riskLevel: ["L0", "L1", "L2", "L3"].includes(rawStep.riskLevel ?? rawStep.risk_level) ? (rawStep.riskLevel ?? rawStep.risk_level) : "L1",
      cautionLevel: ["low", "medium", "high"].includes(rawStep.cautionLevel ?? rawStep.caution_level) ? (rawStep.cautionLevel ?? rawStep.caution_level) : null,
      impactAnalysis: rawStep.impactAnalysis ?? rawStep.impact_analysis ?? null,
      appliedDirectiveIDs: Array.isArray(rawStep.appliedDirectiveIDs ?? rawStep.applied_directive_ids) ? (rawStep.appliedDirectiveIDs ?? rawStep.applied_directive_ids).map(String) : [],
      dependencies: Array.isArray(rawStep.dependencies) ? rawStep.dependencies.map(String) : [],
      requiresUserDirection: Boolean(rawStep.requiresUserDirection ?? rawStep.requires_user_direction),
      directionQuestion,
      directionOptions: normalizeDirectionOptions(rawStep, directionQuestion),
      selectedDirectionOptionId: null,
      directionSupplement: "",
      directionAnswer: "",
      parallelSafe: Boolean(rawStep.parallelSafe ?? rawStep.parallel_safe),
      writeScope: Array.isArray(rawStep.writeScope ?? rawStep.write_scope) ? (rawStep.writeScope ?? rawStep.write_scope).map(String).filter(Boolean).slice(0, 40) : [],
      acceptanceCriteria: Array.isArray(rawStep.acceptanceCriteria ?? rawStep.acceptance_criteria) ? (rawStep.acceptanceCriteria ?? rawStep.acceptance_criteria).map(String).filter(Boolean).slice(0, 12) : [],
      subprocesses: [],
      options: []
    };
  });
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) throw new Error("计划包含重复的步骤 ID。");
  const positions = new Map(steps.map((step, index) => [step.id, index]));
  for (const [index, step] of steps.entries()) {
    if (step.dependencies.some((dependency) => !ids.has(dependency) || dependency === step.id || positions.get(dependency) >= index)) {
      throw new Error(`步骤“${step.title}”包含缺失、倒序或自引用依赖。`);
    }
    if (step.requiresUserDirection && !step.directionQuestion) throw new Error(`方向节点“${step.title}”必须给出需要用户回答的问题。`);
    if (step.requiresUserDirection && step.directionOptions.length < 2) throw new Error(`方向节点“${step.title}”必须给出 2–5 个明确选项。`);
  }
  const rawPrimaryArtifact = response.primaryArtifact ?? response.primary_artifact;
  if (!rawPrimaryArtifact || typeof rawPrimaryArtifact !== "object") throw new Error("计划必须明确唯一主交付物。");
  const primaryArtifact = {
    title: String(rawPrimaryArtifact.title ?? "主交付物"),
    kind: ["html", "markdown", "text"].includes(rawPrimaryArtifact.kind) ? rawPrimaryArtifact.kind : "text",
    filename: String(rawPrimaryArtifact.filename ?? "").trim(),
    entrypoint: String(rawPrimaryArtifact.entrypoint ?? rawPrimaryArtifact.filename ?? "").trim(),
    acceptanceCriteria: Array.isArray(rawPrimaryArtifact.acceptanceCriteria ?? rawPrimaryArtifact.acceptance_criteria)
      ? (rawPrimaryArtifact.acceptanceCriteria ?? rawPrimaryArtifact.acceptance_criteria).map(String).filter(Boolean).slice(0, 12)
      : []
  };
  if (!primaryArtifact.filename || path.isAbsolute(primaryArtifact.filename) || primaryArtifact.filename.split(/[\\/]/).includes("..")) {
    throw new Error("计划主交付物必须使用项目目录内的相对文件名。");
  }
  if (!primaryArtifact.acceptanceCriteria.length) throw new Error("计划必须给出主交付物的客观验收条件。");
  return {
    assistantMessage: String(response.assistantMessage ?? response.assistant_message ?? (executionShape === "single" ? "任务可一步完成并已交付。" : "已生成自适应执行图。")),
    executionShape,
    primaryArtifact,
    steps,
    execution: executionShape === "single" ? normalizeExecutionResponse(response, requestId, "", { stepKind: "deliver" }).result : null
  };
}

function normalizeVisualReferenceUsage(result, requiredVisualReferences = []) {
  if (!requiredVisualReferences.length) return [];
  const expected = new Set(requiredVisualReferences.map((reference) => String(reference.id)));
  const seen = new Set();
  const usage = (Array.isArray(result.visualReferencesUsed ?? result.visual_references_used) ? (result.visualReferencesUsed ?? result.visual_references_used) : []).map((item) => {
    const id = String(item?.id ?? "").trim();
    const appliedAs = String(item?.appliedAs ?? item?.applied_as ?? "").trim().slice(0, 2_000);
    const evidence = String(item?.evidence ?? "").trim().slice(0, 4_000);
    if (!expected.has(id) || seen.has(id) || !appliedAs || !evidence) return null;
    seen.add(id);
    return { id, appliedAs, evidence };
  }).filter(Boolean);
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`Agent 未确认使用 ${missing.length} 个视觉参考；不能把执行标记为已参考。`);
  return usage;
}

export function normalizeExecutionResponse(raw, requestId, expectedOptionId = "", { stepKind = "", requiredVisualReferences = [] } = {}) {
  const response = raw.response && typeof raw.response === "object" ? raw.response : raw;
  const returnedId = response.requestID ?? response.request_id;
  if (returnedId && returnedId !== requestId) throw new Error("Agent 返回了错误的 requestID。");
  const status = String(response.status ?? "success").trim().toLowerCase();
  if (status === "needs_user_direction") {
    const question = String(response.directionQuestion ?? response.direction_question ?? "").trim();
    const directionOptions = normalizeDirectionOptions(response, question);
    if (!question) throw new Error("Agent 请求用户方向时缺少问题。");
    if (directionOptions.length < 2) throw new Error("Agent 请求用户方向时必须提供 2–5 个明确选项。");
    return {
      needsUserDirection: true,
      assistantMessage: String(response.assistantMessage ?? response.assistant_message ?? "需要你确认执行方向。"),
      directionQuestion: question,
      directionOptions
    };
  }
  if (status === "failure") throw new Error(response.error || "Agent 返回 failure，但没有提供具体错误。");
  const result = response.result ?? response.step_result;
  if (!result || typeof result !== "object") throw new Error("Agent 没有返回步骤结果。");
  const selectedOptionId = String(result.selectedOptionId ?? result.selected_option_id ?? "").trim();
  if (expectedOptionId && !selectedOptionId) {
    throw new Error("Agent 步骤结果缺少 selectedOptionId，无法确认执行的是用户所选方案。");
  }
  if (expectedOptionId && selectedOptionId !== expectedOptionId) {
    throw new Error(`Agent 返回的方案 ${selectedOptionId} 与用户所选方案 ${expectedOptionId} 不一致，已拒绝结果。`);
  }
  const artifact = result.artifact && typeof result.artifact === "object" ? {
    title: String(result.artifact.title ?? "最新产物"),
    kind: ["html", "markdown", "text"].includes(result.artifact.kind) ? result.artifact.kind : "text",
    content: String(result.artifact.content ?? result.artifact.html ?? ""),
    filename: String(result.artifact.filename ?? "artifact.txt"),
    projectRoot: result.artifact.projectRoot ?? result.artifact.project_root ?? null,
    files: Array.isArray(result.artifact.files) ? result.artifact.files.map(String) : [],
    entrypoint: result.artifact.entrypoint ? String(result.artifact.entrypoint) : null,
    dependencies: Array.isArray(result.artifact.dependencies) ? result.artifact.dependencies.map(String) : [],
    runCommands: Array.isArray(result.artifact.runCommands ?? result.artifact.run_commands)
      ? (result.artifact.runCommands ?? result.artifact.run_commands).map(String) : [],
    testCommands: Array.isArray(result.artifact.testCommands ?? result.artifact.test_commands)
      ? (result.artifact.testCommands ?? result.artifact.test_commands).map(String) : [],
    testResults: Array.isArray(result.artifact.testResults ?? result.artifact.test_results)
      ? (result.artifact.testResults ?? result.artifact.test_results).map(String) : []
  } : null;
  const requestedPreview = result.requiresPreview ?? result.requires_preview;
  const requiresPreview = Boolean(artifact && (
    stepKind === "deliver" || (artifact.kind === "html" && requestedPreview === true)
  ));
  return {
    assistantMessage: String(response.assistantMessage ?? response.assistant_message ?? "当前步骤已执行。"),
    result: {
      selectedOptionId,
      summary: String(result.summary ?? "Agent 未提供摘要。"),
      actualChanges: Array.isArray(result.actualChanges ?? result.actual_changes) ? (result.actualChanges ?? result.actual_changes).map(String) : [],
      evidence: Array.isArray(result.evidence) ? result.evidence.map(String) : [],
      deviation: String(result.deviation ?? "无"),
      rollback: String(result.rollback ?? "未提供"),
      verificationPassed: typeof (result.verificationPassed ?? result.verification_passed) === "boolean"
        ? (result.verificationPassed ?? result.verification_passed) : null,
      blockingIssues: Array.isArray(result.blockingIssues ?? result.blocking_issues)
        ? (result.blockingIssues ?? result.blocking_issues).map(String) : [],
      ...(requiredVisualReferences.length ? { visualReferencesUsed: normalizeVisualReferenceUsage(result, requiredVisualReferences) } : {}),
      requiresPreview,
      previewReason: requiresPreview
        ? String(result.previewReason ?? result.preview_reason ?? (stepKind === "deliver" ? "最终成果需要预览验收。" : "已形成可直接检查的成果里程碑。"))
        : "",
      artifact
    }
  };
}

export function executionResultForServer(response) {
  if (response.needsUserDirection) return response;
  return { ...response.result, assistantMessage: response.assistantMessage };
}

export function normalizeProjectExecutionResponse(raw, requestId, project) {
  const normalized = normalizeExecutionResponse(raw, requestId, "", { stepKind: "deliver", requiredVisualReferences: visualReferencesForAgent(project) });
  if (normalized.needsUserDirection) return normalized;
  const response = raw.response && typeof raw.response === "object" ? raw.response : raw;
  const result = response.result ?? response.step_result ?? {};
  const selectedOptionIds = project.steps.map((step) => step.selectedOptionId).filter(Boolean).sort();
  const appliedOptionIds = Array.isArray(result.appliedOptionIds ?? result.applied_option_ids)
    ? (result.appliedOptionIds ?? result.applied_option_ids).map(String).sort()
    : [];
  if (selectedOptionIds.length !== appliedOptionIds.length || selectedOptionIds.some((id, index) => id !== appliedOptionIds[index])) {
    throw new Error("Agent 未完整回传并遵守全部里程碑的用户所选方案。");
  }
  const stepIds = new Set(project.steps.map((step) => step.id));
  const checkpoints = Array.isArray(result.checkpoints) ? result.checkpoints.map((checkpoint) => ({
    stepId: String(checkpoint.stepId ?? checkpoint.step_id ?? ""),
    summary: String(checkpoint.summary ?? ""),
    actualChanges: Array.isArray(checkpoint.actualChanges ?? checkpoint.actual_changes) ? (checkpoint.actualChanges ?? checkpoint.actual_changes).map(String) : [],
    evidence: Array.isArray(checkpoint.evidence) ? checkpoint.evidence.map(String) : [],
    verificationPassed: typeof (checkpoint.verificationPassed ?? checkpoint.verification_passed) === "boolean"
      ? (checkpoint.verificationPassed ?? checkpoint.verification_passed) : null
  })) : [];
  if (checkpoints.length !== project.steps.length || checkpoints.some((checkpoint) => !stepIds.has(checkpoint.stepId)) || new Set(checkpoints.map((checkpoint) => checkpoint.stepId)).size !== project.steps.length) {
    throw new Error("Agent 返回的检查点没有完整覆盖计划 Graph。");
  }
  return { ...normalized, checkpoints, appliedOptionIds };
}

function throwWithExecutionContext(caught, { request, rawOutput, stepId = null } = {}) {
  const error = caught instanceof Error ? caught : new Error(String(caught));
  error.executionContext = { request, rawOutput, stepId };
  throw error;
}

export const LEARNING_MODEL_POLICY = [
  "你处于 LoopCanvas 学习模式，只能教学和解释，不能修改、创建、删除或重命名任何项目文件。",
  "不得输出补丁、可直接执行的修改命令或以完成任务为目的的代码替换；用户要求改代码时，解释思路并提醒切回执行模式。",
  "回答必须以给定源码片段为主要依据；区分已从代码确认的事实、合理推断和未知，不得编造未提供的上下文。",
  "优先用循序渐进、适合当前问题的中文解释；解释标识符、输入输出、控制流、数据结构、语法和边界条件。",
  "同一片段的后续问题必须继承已有对话，但发现先前解释错误时要明确纠正。",
  "整篇数据结构或运行流程讲解必须按源码中的真实行号分段，每段绑定足以理解该概念或流程的连续代码范围；不得编造文件、标识符、调用关系或行号。",
  "不得读取或输出 API Key、令牌、凭证或项目外隐私数据。"
].join(" ");

export const EXPLORATION_MODEL_POLICY = [
  "你处于 LoopCanvas 探索模式，只做研究、检索、比较和总结，不修改用户项目或生产环境。",
  "每次探索必须先实际调用 web_search 检索公开网络；工具不可用、调用失败或没有找到可核查网页来源时必须返回 failure 并明确说明联网不可用，不得用训练记忆伪装成搜索结果，也不得使用或索取用户私有凭证。",
  "来源优先级：官方文档或规范、项目官方仓库和维护者资料、同行评审论文或权威机构、信誉良好的技术出版物，最后才是社区讨论。",
  "每个关键结论必须给出可核查 URL；无法验证的内容要标为未知，不得杜撰仓库、链接、星标、更新时间或许可证。",
  "存在当前项目上下文时，优先研究与项目技术栈、目标和问题相关的内容，但用户明确提出无关主题时不得强行关联。",
  "展示来源可信度、判断理由、与当前项目的相关性，并区分事实、推断和建议。"
].join(" ");

export const EXPLORATION_ART_MODEL_POLICY = [
  "艺术探索应研究视觉风格、艺术史与文化语境、构图、色彩、字体、材质、媒介和代表创作者，给出可继续检索的中英文关键词。",
  "Pinterest 只能作为视觉灵感的发现入口，不得把 Pin、图板或推荐流本身当作权威出处；尽量追溯到创作者官网、博物馆、画廊、出版社或作品原始页面。",
  "清楚区分对作品可见特征的观察、基于来源的事实和主观建议；无法确认作者、年份、版权或来源时必须标为未知。",
  "尊重著作权和署名，不建议逐像素复制仍受保护的作品；将参考转化为可组合的视觉原则和差异化方向。"
].join(" ");

const VISUAL_REFERENCE_MODEL_POLICY = "visualReferences 是服务端生成的可审计视觉转译。mode=metadata-only 且 pixelAccess=false 时，你没有看过图片像素；只能使用 agentText 中的标题、来源说明和结构化元数据。不得补写未给出的颜色、构图、主体或材质。若使用了参考，必须在 result.visualReferencesUsed 中逐一原样回传 id，并用 appliedAs 说明如何应用、用 evidence 指向可公开检查的产物证据；缺少回执会使结果被拒绝。";

function visualReferenceUsageExample(visualReferences = []) {
  if (!visualReferences.length) return "";
  return `,\"visualReferencesUsed\":[${visualReferences.map((reference) => `{\"id\":${JSON.stringify(reference.id)},\"appliedAs\":\"具体应用方式\",\"evidence\":\"可公开核查的产物证据\"}`).join(",")}]`;
}

export function explorationModelPolicy(kind = "research") {
  return kind === "art" ? `${EXPLORATION_MODEL_POLICY} ${EXPLORATION_ART_MODEL_POLICY}` : EXPLORATION_MODEL_POLICY;
}

export function normalizeLearningResponse(raw, requestId, { maxLine = Number.MAX_SAFE_INTEGER, requireSections = false } = {}) {
  const response = raw.response && typeof raw.response === "object" ? raw.response : raw;
  const returnedId = response.requestID ?? response.request_id;
  if (returnedId && returnedId !== requestId) throw new Error("Agent 返回了错误的 requestID。");
  if ((response.status ?? "success") === "failure") throw new Error(response.error || "Agent 学习解释失败。");
  const answer = String(response.answer ?? response.assistantMessage ?? response.assistant_message ?? "").trim();
  if (!answer) throw new Error("Agent 没有返回学习解释。");
  const sections = (Array.isArray(response.sections) ? response.sections : []).map((section) => {
    const title = String(section?.title ?? "").trim();
    const explanation = String(section?.explanation ?? section?.answer ?? "").trim();
    const rawStart = Number.parseInt(section?.startLine ?? section?.start_line, 10);
    const rawEnd = Number.parseInt(section?.endLine ?? section?.end_line, 10);
    if (!title || !explanation || !Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return null;
    const startLine = Math.max(1, Math.min(maxLine, rawStart));
    const endLine = Math.max(startLine, Math.min(maxLine, rawEnd));
    return {
      title, explanation, startLine, endLine,
      keyPoints: Array.isArray(section.keyPoints ?? section.key_points) ? (section.keyPoints ?? section.key_points).map(String).slice(0, 8) : []
    };
  }).filter(Boolean).slice(0, 30);
  const codeReferences = (Array.isArray(response.codeReferences ?? response.code_references) ? (response.codeReferences ?? response.code_references) : []).map((reference) => {
    const rawStart = Number.parseInt(reference?.startLine ?? reference?.start_line, 10);
    const rawEnd = Number.parseInt(reference?.endLine ?? reference?.end_line, 10);
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return null;
    const startLine = Math.max(1, Math.min(maxLine, rawStart));
    const endLine = Math.max(startLine, Math.min(maxLine, rawEnd));
    return { label: String(reference.label ?? reference.reason ?? `L${startLine}–L${endLine}`).slice(0, 160), startLine, endLine };
  }).filter(Boolean).slice(0, 12);
  if (requireSections && !sections.length) throw new Error("Agent 没有返回带源码行号的完整学习章节。");
  return {
    answer,
    keyPoints: Array.isArray(response.keyPoints ?? response.key_points) ? (response.keyPoints ?? response.key_points).map(String).slice(0, 12) : [],
    concepts: Array.isArray(response.concepts) ? response.concepts.map(String).slice(0, 12) : [],
    followUpPrompts: Array.isArray(response.followUpPrompts ?? response.follow_up_prompts) ? (response.followUpPrompts ?? response.follow_up_prompts).map(String).slice(0, 6) : [],
    sections,
    codeReferences
  };
}

export function normalizeRepositoryOverviewResponse(raw, requestId, requestedDocuments) {
  const response = raw.response && typeof raw.response === "object" ? raw.response : raw;
  const returnedId = response.requestID ?? response.request_id;
  if (returnedId && returnedId !== requestId) throw new Error("Agent 返回了错误的 requestID。");
  if ((response.status ?? "success") === "failure") throw new Error(response.error || "Agent 仓库概要生成失败。");
  const requested = new Map(requestedDocuments.map((item) => [item.path, item]));
  const returned = new Map();
  for (const item of Array.isArray(response.documents) ? response.documents : []) {
    const filePath = String(item?.path ?? "");
    if (!requested.has(filePath) || returned.has(filePath)) continue;
    const summary = String(item.summary ?? "").trim();
    if (!summary) continue;
    returned.set(filePath, {
      path: filePath, summary,
      responsibilities: Array.isArray(item.responsibilities) ? item.responsibilities.map(String).slice(0, 8) : [],
      keySymbols: Array.isArray(item.keySymbols ?? item.key_symbols) ? (item.keySymbols ?? item.key_symbols).map(String).slice(0, 16) : []
    });
  }
  const missing = [...requested.keys()].filter((filePath) => !returned.has(filePath));
  if (missing.length) throw new Error(`Agent 未返回 ${missing.length} 个代码文档的概要。`);
  return requestedDocuments.map((document) => ({ ...returned.get(document.path), language: document.language, lineCount: document.lineCount, sizeBytes: document.sizeBytes, truncated: document.truncated }));
}

function normalizedSource(source = {}) {
  const url = String(source.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const credibility = ["high", "medium", "low"].includes(source.credibility) ? source.credibility : "medium";
  const previewURL = [source.previewURL, source.previewUrl, source.imageURL, source.imageUrl, source.thumbnailURL, source.thumbnailUrl]
    .map((value) => String(value ?? "").trim()).find((value) => /^https?:\/\//i.test(value))?.slice(0, 2_000) ?? "";
  const rawLicenseURL = String(source.licenseURL ?? source.licenseUrl ?? "").trim();
  return {
    title: String(source.title ?? url),
    url,
    type: String(source.type ?? "article"),
    credibility,
    credibilityReason: String(source.credibilityReason ?? source.credibility_reason ?? "未说明"),
    projectRelevance: String(source.projectRelevance ?? source.project_relevance ?? "未说明"),
    summary: String(source.summary ?? ""),
    mediaKind: previewURL || source.mediaKind === "image" || source.media_kind === "image" ? "image" : "document",
    previewURL,
    creator: String(source.creator ?? source.artist ?? "").slice(0, 240),
    license: String(source.license ?? source.licence ?? "").slice(0, 240),
    licenseURL: /^https?:\/\//i.test(rawLicenseURL) ? rawLicenseURL.slice(0, 2_000) : "",
    sourceName: String(source.sourceName ?? source.source_name ?? "").slice(0, 240),
    width: Number.isInteger(Number(source.width)) && Number(source.width) > 0 ? Math.min(Number(source.width), 100_000) : null,
    height: Number.isInteger(Number(source.height)) && Number(source.height) > 0 ? Math.min(Number(source.height), 100_000) : null,
    visualDescription: String(source.visualDescription ?? source.visual_description ?? "").slice(0, 12_000)
  };
}

export function visualReferencesForAgent(project = {}) {
  return (Array.isArray(project.executionReferences) ? project.executionReferences : []).filter((reference) => reference?.visual?.mode === "metadata-only" && reference.visual.pixelAccess === false && reference.visual.agentText).map((reference) => ({
    id: String(reference.id),
    title: String(reference.title ?? "未命名视觉参考"),
    sourceURL: String(reference.url ?? ""),
    displayOnlyPreviewURL: String(reference.previewURL ?? ""),
    mode: "metadata-only",
    pixelAccess: false,
    agentText: String(reference.visual.agentText)
  }));
}

export function normalizeExplorationResponse(raw, requestId) {
  const response = raw.response && typeof raw.response === "object" ? raw.response : raw;
  const returnedId = response.requestID ?? response.request_id;
  if (returnedId && returnedId !== requestId) throw new Error("Agent 返回了错误的 requestID。");
  if ((response.status ?? "success") === "failure") throw new Error(response.error || "Agent 探索失败。");
  const answer = String(response.answer ?? response.assistantMessage ?? response.assistant_message ?? "").trim();
  if (!answer) throw new Error("Agent 没有返回探索结论。");
  const sources = (Array.isArray(response.sources) ? response.sources : []).map(normalizedSource).filter(Boolean).slice(0, 20);
  if (!sources.length) throw new Error("Agent 未返回可核查的网页来源；不能把模型记忆标记为联网搜索结果。");
  return {
    answer,
    sources,
    unknowns: Array.isArray(response.unknowns) ? response.unknowns.map(String).slice(0, 10) : [],
    nextQuestions: Array.isArray(response.nextQuestions ?? response.next_questions) ? (response.nextQuestions ?? response.next_questions).map(String).slice(0, 6) : []
  };
}

function validateArtifactBoundary(artifact, workspace) {
  if (!artifact?.projectRoot) return;
  const root = path.resolve(artifact.projectRoot);
  const boundary = path.resolve(workspace);
  const relative = path.relative(boundary, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Agent 返回的产物目录超出已配置工作目录。");
  }
}

export function resolveProjectWorkspace(project, settings) {
  return path.resolve(project?.workspace ?? settings.workspace);
}

export function dshInvocationArguments(patchPath, prompt, pluginPatchPath = "") {
  const args = ["--profile", "headless", "--patch", patchPath];
  if (pluginPatchPath) args.push("--patch", pluginPatchPath);
  args.push(prompt);
  return args;
}

async function invokeDsh(request, settings, options = {}, signal, onEvent) {
  const dshPath = await resolveDsh({ explicitPath: settings.dshPath });
  if (!dshPath) throw new Error("未找到 dsh。请先运行 npx @deepseek-ai/dsh web。 ");
  const workspace = path.resolve(options.workspace ?? settings.workspace);
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const sessionsBefore = await dshSessionSnapshot(dshHome);
  await mkdir(workspace, { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-web-"));
  try {
    const requestPath = path.join(temporary, "request.json");
    const settingsPath = path.join(temporary, "settings.yaml");
    const patchPath = path.join(temporary, "patch.yml");
    const pluginPatchPath = settings.dshPluginPatch ? path.join(temporary, "plugins.patch.yml") : "";
    await writeFile(requestPath, serializeAgentRequest(request, 2), { mode: 0o600 });
    await writeFile(settingsPath, [
      "agent-default-model:",
      "  provider: deepseek-official",
      `  model: ${settings.model}`,
      `  reasoningEffort: ${settings.reasoningEffort}`,
      "locale:",
      "  preference: zh",
      ""
    ].join("\n"), { mode: 0o600 });
    await writeFile(patchPath, [
      "- id: settings",
      "  config:",
      `    path: ${yamlQuoted(settingsPath)}`,
      `    dshHome: ${yamlQuoted(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"))}`,
      "    watch: false",
      "    debounceMs: 100",
      ""
    ].join("\n"), { mode: 0o600 });
    if (pluginPatchPath) await writeFile(pluginPatchPath, settings.dshPluginPatch, { mode: 0o600 });
    const prompt = buildAgentPrompt({
      runtime: "dsh",
      workspace,
      request,
      requestPath,
      agents: options.agents,
      constitution: options.constitution,
      accessBoundary: "所有文件创建、编辑和命令执行必须位于工作目录内（允许其子目录）；允许按任务需要使用当前 headless 配置中已启用的工具访问公开网络；不得假设存在未启用的网络工具或工作目录之外的写入权限。"
    });
    onEvent?.({ type: "activity", activity: "调用 DeepSeek Harness" });
    let telemetryPolling = false;
    let lastLiveActivity = "";
    const pollLiveActivity = async () => {
      if (telemetryPolling) return;
      telemetryPolling = true;
      try {
        const telemetry = await readDshSessionTelemetry(await newestChangedDshSession(sessionsBefore, dshHome));
        if (telemetry?.activity && telemetry.activity !== lastLiveActivity) {
          lastLiveActivity = telemetry.activity;
          onEvent?.({ type: "activity", activity: telemetry.activity });
        }
      } finally { telemetryPolling = false; }
    };
    const telemetryTimer = setInterval(() => pollLiveActivity().catch(() => {}), 650);
    telemetryTimer.unref?.();
    let output;
    try {
      output = await runProcess(dshPath, dshInvocationArguments(patchPath, prompt, pluginPatchPath), {
        cwd: workspace,
        env: { DSH_HOME: dshHome },
        signal,
        outputDir: temporary
      });
    } finally {
      clearInterval(telemetryTimer);
    }
    if (signal?.aborted) throw new Error("任务已暂停，Harness 进程已取消。");
    const stderr = await readCapturedText(output.stderrPath, output.stderr, { ceiling: 32 * 1024 * 1024, label: "Harness 错误输出" });
    if (output.code !== 0) throw new Error(stderr.trim() || "dsh headless 执行失败。");
    const telemetry = await readDshSessionTelemetry(await newestChangedDshSession(sessionsBefore, dshHome));
    if (telemetry) {
      if (telemetry.activity !== lastLiveActivity) onEvent?.({ type: "activity", activity: telemetry.activity });
      onEvent?.({ type: "metrics", metrics: telemetry.metrics });
    }
    onEvent?.({ type: "activity", activity: "DeepSeek Harness 已返回结果，正在校验产物" });
    return await readCapturedText(output.stdoutPath, output.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function invoke(request, settings, options = {}, signal, onEvent) {
  if (settings.agentRuntime === "codex") return invokeCodex(request, settings, options, signal, onEvent);
  return invokeDsh(request, settings, options, signal, onEvent);
}

async function harnessDocuments(project, workspace) {
  await ensureProjectDocuments({ workspace, project });
  const documents = await readProjectDocuments(workspace);
  return { agents: documents.agents, constitution: documents.constitution };
}

async function invokeDisposable(request, settings, signal) {
  const disposableWorkspace = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-readonly-mode-"));
  try {
    return await invoke(request, settings, { workspace: disposableWorkspace }, signal);
  } finally {
    await rm(disposableWorkspace, { recursive: true, force: true });
  }
}

const MODEL_POLICY = "先判断任务能否由一个 Agent 在一次调用内准确完成。简单、明确、低风险且无需目标方向决策的任务选择 single，并在当前调用中直接实现、验证和交付；不得为了展示流程人为拆步。只有任务确实存在多个可独立追踪的执行节点、依赖、并行机会或必须询问用户的目标方向时才选择 graph。graph 节点必须对应 Harness 真正会执行的工作，不生成备选方案或固定模板子进程；先返回节点图，本次不得修改项目文件。节点应声明 dependencies、parallelSafe、writeScope，以及是否 requiresUserDirection。需要用户决定目标方向时，必须同时给出一个简洁问题和 2–5 个互斥、可直接执行的 directionOptions；额外补充由用户在界面中选填，不得把补充文字设为继续执行的前提。只负责收集用户选择的节点必须使用 kind=decision，用户回答即完成该节点，不能给它安排文件修改、命令或额外 Agent 工作；依赖选择的分析、构建和验证必须放在下游真实节点。其他 kind 的节点即使需要方向输入，收到回答后仍由 Agent 执行。无依赖不自动等于可并行，只有写入范围互不冲突且能独立验证时 parallelSafe 才为 true。所有完成声明必须有文件、命令输出、渲染或其他客观证据。不得读取或输出 API Key。禁止启动 Chrome 或其他 GUI 浏览器（包括 headless）。";
export const ADAPTIVE_NODE_RESULT_SCOPE_POLICY = "verificationPassed 只判断当前节点 acceptanceCriteria 是否通过；blockingIssues 只能填写阻止当前节点按其 acceptanceCriteria、writeScope 和 purpose 完成的问题。下游节点尚未创建的文件、未来节点待办或最终交付条件不属于当前节点阻断，必须放入 deviation 说明，不得放入 blockingIssues。只有 deliver 节点才可因最终主交付物尚未完成而阻断。";
export const DIRECTION_CONFLICT_POLICY = "directionAnswer 非空不等于目标已经明确。执行前必须逐项核对其中约束、originalRequirement 与用户已选方向；若它们互相排斥、在逻辑或物理上不能同时满足，或需要静默忽略、替换、合并任一项才能继续，应视为必要信息尚未回答。不得调用工具或修改文件，必须按 responseInstructions 返回 needs_user_direction、一个具体问题和 2–5 个互斥可执行选项。";

const EXECUTION_COMPLETION_POLICY = "返回 final success 前，必须用文件工具逐项重新读取或访问所声明的 artifact.projectRoot + filename、files 中每个文件和 HTML 本地资源；发现缺失时继续修复，不能只改 JSON 路径来绕过校验。无法完成并核验时返回 failure 和真实阻断原因，不能先提交再等待外部校验发现。";

const PREVIEW_GATE_POLICY = "requiresPreview 只有在当前子进程已经形成可由用户直接观察和验收的产品里程碑时才能为 true，例如苹果模型已经可见、场景已经构建成形、可交互界面达到阶段成品或最终成果已经生成。仅新增几行代码、修改配置、准备数据、生成日志/测试结果/文字报告或其他尚不可直接验收的中间文件时必须为 false；没有 artifact 时也必须为 false。最终 deliver 步骤有 artifact 时必须为 true。previewReason 用一句话说明用户现在能检查什么。";

const PREVIEW_TRACE_POLICY = "创建或修改可预览 HTML 时，执行阶段必须把每个有独立视觉边界或独立修改意义的界面组织成可选择组。DOM/SVG 组使用稳定且语义化、能在原始源码中直接搜索到的 data-loopcanvas-group；需要更细源码身份时同时使用 data-loopcanvas-trace。不要给纯布局包装层或每个文字节点重复分组。Three.js 在逻辑 Group/Object3D 的 userData.loopcanvas 中写入唯一 traceId、简短 label 和 group:true，并在场景初始化后调用 window.__loopcanvasTrace?.registerThree({THREE,scene,camera,renderer})。Canvas 2D、自定义 WebGL/WebGPU 或其他引擎必须调用 window.__loopcanvasTrace?.registerPicker({element,pick})，按命中结果返回 {kind,groupId,traceId,label,bounds?}；bounds 是相对画布的组选中框。无法为第三方或静态资产建立精确追溯时必须保持真实，不得伪造映射。";

export function compactSharedContext(items = [], userGoal = "") {
  const goal = String(userGoal ?? "").trim();
  const seen = new Set();
  const lines = [];
  for (const item of Array.isArray(items) ? items : []) {
    const kind = String(item?.kind ?? "context");
    const content = String(item?.content ?? "").trim();
    if (!content || (kind === "requirement" && content === goal)) continue;
    const key = `${kind}\u0000${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`[${kind}] ${content}`);
  }
  return lines.join("\n");
}

export async function planWithHarness(project, settings, signal, onEvent) {
  const requestId = randomUUID();
  const request = {
    id: requestId,
    kind: "route_project",
    userGoal: project.goal,
    focus: "判断任务应一步直达还是使用真实执行节点；一步直达时在本次调用内直接完成、验证并交付",
    modelPolicy: `${MODEL_POLICY} ${EXECUTION_COMPLETION_POLICY} ${PREVIEW_GATE_POLICY} ${PREVIEW_TRACE_POLICY}`,
    cautionLevel: settings.cautionLevel ?? "medium",
    sharedContext: compactSharedContext(project.context, project.goal),
    attachments: project.attachments ?? [],
    requirementDirectives: project.directives ?? [],
    existingSteps: [],
    responseInstructions: `只返回一个 JSON。共同字段：{\"requestID\":\"${requestId}\",\"status\":\"success\",\"executionShape\":\"single|graph\",\"assistantMessage\":\"判断依据和公开摘要\",\"primaryArtifact\":{\"title\":\"...\",\"kind\":\"html|markdown|text\",\"filename\":\"项目内相对路径\",\"entrypoint\":\"...\",\"acceptanceCriteria\":[\"客观条件\"]},\"steps\":[{\"id\":\"UUID\",\"title\":\"真实执行节点\",\"purpose\":\"...\",\"kind\":\"analyze|decision|build|integrate|verify|deliver\",\"riskLevel\":\"L0|L1|L2|L3\",\"cautionLevel\":null或\"low|medium|high\",\"dependencies\":[\"前置节点UUID\"],\"parallelSafe\":false,\"writeScope\":[\"预计写入的相对路径\"],\"requiresUserDirection\":false,\"directionQuestion\":\"仅在需要方向时填写简洁问题\",\"directionOptions\":[{\"id\":\"稳定短ID\",\"label\":\"可直接选择的名称\",\"description\":\"这个方向的范围或取舍\"}],\"acceptanceCriteria\":[\"节点完成条件\"],\"appliedDirectiveIDs\":[\"约束UUID\"]}]}。requiresUserDirection=true 时 directionOptions 必须有 2–5 个互斥选项；用户可另写补充但补充不是必填。若 executionShape=single：steps 只能有一个节点，立即在本次调用内完成实现和验证，并额外返回 result：{\"summary\":\"...\",\"actualChanges\":[\"...\"],\"evidence\":[\"...\"],\"deviation\":\"...\",\"rollback\":\"...\",\"verificationPassed\":true,\"blockingIssues\":[],\"artifact\":{\"title\":\"...\",\"kind\":\"html|markdown|text\",\"filename\":\"与 primaryArtifact 一致\",\"projectRoot\":\"绝对工作目录\",\"files\":[\"...\"],\"entrypoint\":\"...\",\"dependencies\":[],\"runCommands\":[],\"testCommands\":[],\"testResults\":[]}}。若 executionShape=graph：返回 2–12 个真实节点和依赖，本次不得修改任何项目文件，也不要返回普通方案 options/subprocesses；方向节点的 directionOptions 是人类门控输入。`
  };
  const workspace = resolveProjectWorkspace(project, settings);
  const documents = await harnessDocuments(project, workspace);
  const rawOutput = await invoke(request, settings, { workspace, ...documents }, signal, onEvent);
  const planned = normalizePlanResponse(extractJSONObject(rawOutput), requestId);
  if (planned.executionShape === "single" && planned.execution?.artifact) {
    validateArtifactBoundary(planned.execution.artifact, workspace);
    if (planned.execution.artifact.filename !== planned.primaryArtifact.filename || planned.execution.artifact.kind !== planned.primaryArtifact.kind) {
      throw new Error(`一步直达返回的 ${planned.execution.artifact.filename}（${planned.execution.artifact.kind}）与锁定主交付物 ${planned.primaryArtifact.filename}（${planned.primaryArtifact.kind}）不一致。`);
    }
  }
  const mapped = new Set(planned.steps.flatMap((step) => step.appliedDirectiveIDs));
  const missing = (project.directives ?? []).filter((directive) => ["required", "forbidden"].includes(directive.strength) && !mapped.has(directive.id));
  if (missing.length) throw new Error(`计划未映射硬约束：${missing.map((directive) => directive.text).join("；")}`);
  return { result: planned, request, rawOutput };
}

export async function executeWithHarness(project, step, settings, feedback = "", signal, onEvent) {
  const requestId = randomUUID();
  const subprocess = step.activeSubprocess
    ?? step.subprocesses?.find((item) => item.id === step.selectedSubprocessId)
    ?? step.subprocesses?.find((item) => ["ready", "error"].includes(item.status));
  const optionOwner = subprocess ?? step;
  const selectedOption = (optionOwner.options ?? []).find((option) => option.id === optionOwner.selectedOptionId) ?? null;
  const visualReferences = visualReferencesForAgent(project);
  const relevantContext = project.context.filter((item) => item.stepId === step.id || (item.stepId == null && ["requirement", "plan", "reference"].includes(item.kind)));
  const relevantStepIds = new Set([step.id, ...(step.dependencies ?? [])]);
  const debugContext = (optionOwner.debugRecords ?? []).slice(-8).map((record) => ({
    element: record.element,
    source: record.source ? { path: record.source.path, startLine: record.source.startLine, endLine: record.source.endLine, code: record.source.code } : null,
    agentDecisionSummary: record.agentDecisionSummary,
    feedback: record.feedback
  }));
  const request = {
    id: requestId,
    kind: "execute_step",
    targetStepID: step.id,
    targetSubprocessID: subprocess?.id ?? null,
    userGoal: project.goal,
    focus: `完成自适应执行图中的当前节点：${step.title}${subprocess ? ` / ${subprocess.title}` : ""}。${subprocess?.purpose ?? step.purpose}。只处理这个节点声明的范围并维护主交付物 ${project.primaryArtifact?.filename ?? project.artifact?.filename ?? "（尚未建立）"}；不得顺手推进其他节点。`,
    modelPolicy: `${MODEL_POLICY} ${DIRECTION_CONFLICT_POLICY} ${EXECUTION_COMPLETION_POLICY} ${PREVIEW_GATE_POLICY} ${PREVIEW_TRACE_POLICY}${visualReferences.length ? ` ${VISUAL_REFERENCE_MODEL_POLICY}` : ""}`,
    originalRequirement: project.goal,
    sharedContext: compactSharedContext(relevantContext, project.goal),
    existingSteps: project.steps.filter((item) => relevantStepIds.has(item.id)).map((item) => ({ id: item.id, title: item.title, purpose: item.purpose, kind: item.kind, status: item.status, dependencies: item.dependencies })),
    currentStep: { id: step.id, title: step.title, purpose: step.purpose, kind: step.kind, revision: step.revision },
    currentSubprocess: subprocess ? { id: subprocess.id, title: subprocess.title, purpose: subprocess.purpose, revision: subprocess.revision, selectedOptionId: subprocess.selectedOptionId, contextSnapshot: subprocess.contextSnapshot } : null,
    debugContext,
    ...(selectedOption ? { selectedOption: { ...selectedOption, userSelected: true, selectionAuthority: "user" } } : {}),
    cautionLevel: step.cautionLevel ?? settings.cautionLevel ?? "medium",
    directionAnswer: step.directionAnswer || "",
    writeScope: step.writeScope ?? [],
    acceptanceCriteria: step.acceptanceCriteria ?? [],
    userFeedback: String(feedback || ""),
    currentArtifact: project.artifact,
    visualReferences,
    attachments: project.attachments ?? [],
    requirementDirectives: project.directives ?? [],
    previewResponseContract: {
      requiredResultFields: { requiresPreview: "boolean", previewReason: "string" },
      policy: PREVIEW_GATE_POLICY
    },
    responseInstructions: `返回 JSON：成功时返回 {\"requestID\":\"${requestId}\",\"status\":\"success\",\"assistantMessage\":\"当前节点公开摘要\",\"result\":{\"summary\":\"...\",\"actualChanges\":[\"...\"],\"evidence\":[\"...\"],\"deviation\":\"...\",\"rollback\":\"恢复本节点前状态的精确方法或明确无完整回滚\",\"verificationPassed\":true或false或null,\"blockingIssues\":[\"...\"]${visualReferenceUsageExample(visualReferences)},\"artifact\":null或{\"title\":\"...\",\"kind\":\"html|markdown|text\",\"content\":\"可为空\",\"filename\":\"...\",\"projectRoot\":\"绝对路径\",\"files\":[\"...\"],\"entrypoint\":\"...\",\"dependencies\":[\"名称@版本\"],\"runCommands\":[\"...\"],\"testCommands\":[\"...\"],\"testResults\":[\"...\"]}}}。若缺少会影响目标、授权、安全、兼容性或可恢复性的必要信息，且当前 directionAnswer 没有回答，不得执行或猜测；返回 {\"requestID\":\"${requestId}\",\"status\":\"needs_user_direction\",\"assistantMessage\":\"暂停原因\",\"directionQuestion\":\"需要用户确认的问题\",\"directionOptions\":[{\"id\":\"稳定短ID\",\"label\":\"可直接选择的名称\",\"description\":\"范围或取舍\"},{\"id\":\"另一个短ID\",\"label\":\"另一个方向\",\"description\":\"范围或取舍\"}]}。问题必须提供 2–5 个互斥、可执行选项。严格遵守 cautionLevel、directionAnswer、writeScope 和 acceptanceCriteria；不要返回 options/subprocesses。${ADAPTIVE_NODE_RESULT_SCOPE_POLICY}${visualReferences.length ? " visualReferencesUsed 必须逐一覆盖 request.visualReferences，且不得声称看过像素。" : ""}`
  };
  const workspace = resolveProjectWorkspace(project, settings);
  const documents = await harnessDocuments(project, workspace);
  const rawOutput = await invoke(request, settings, { workspace, ...documents }, signal, onEvent);
  let response;
  try {
    response = normalizeExecutionResponse(extractJSONObject(rawOutput), requestId, selectedOption?.id ?? "", { stepKind: step.kind, requiredVisualReferences: visualReferences });
    if (!response.needsUserDirection) validateArtifactBoundary(response.result.artifact, workspace);
  } catch (error) {
    throwWithExecutionContext(error, { request, rawOutput, stepId: step.id });
  }
  if (response.needsUserDirection) return { needsUserDirection: true, ...response, request, rawOutput };
  return { result: executionResultForServer(response), request, rawOutput };
}

export async function executeProjectWithHarness(project, settings, feedback = "", signal, onEvent) {
  const requestId = randomUUID();
  const selectedPlan = project.steps.map((step) => {
    const selectedOption = (step.options ?? []).find((option) => option.id === step.selectedOptionId);
    if (!selectedOption) throw new Error(`里程碑“${step.title}”缺少有效的用户选择。`);
    return { id: step.id, title: step.title, purpose: step.purpose, kind: step.kind, dependencies: step.dependencies ?? [], selectedOption };
  });
  const visualReferences = visualReferencesForAgent(project);
  const request = {
    id: requestId,
    kind: "execute_project",
    userGoal: project.goal,
    focus: `在已经创建的项目目录中端到端完成目标。不要等待每个 Graph 节点再次派发；按 selectedPlan 连续推进，并始终维护唯一主交付物 ${project.primaryArtifact?.filename ?? "（未声明）"}。Graph 节点只用于返回可追溯检查点。`,
    modelPolicy: `${MODEL_POLICY} ${EXECUTION_COMPLETION_POLICY} ${PREVIEW_GATE_POLICY} ${PREVIEW_TRACE_POLICY}${visualReferences.length ? ` ${VISUAL_REFERENCE_MODEL_POLICY}` : ""}`,
    originalRequirement: project.goal,
    sharedContext: compactSharedContext(project.context, project.goal),
    selectedPlan,
    primaryArtifact: project.primaryArtifact,
    currentArtifact: project.artifact,
    visualReferences,
    attachments: project.attachments ?? [],
    requirementDirectives: project.directives ?? [],
    feedback: String(feedback ?? ""),
    responseInstructions: `返回 JSON：{\"requestID\":\"${requestId}\",\"status\":\"success\",\"assistantMessage\":\"可公开摘要\",\"result\":{\"appliedOptionIds\":[${selectedPlan.map((item) => `\"${item.selectedOption.id}\"`).join(",")}],\"summary\":\"...\",\"actualChanges\":[\"...\"],\"evidence\":[\"...\"],\"deviation\":\"...\",\"rollback\":\"...\",\"verificationPassed\":true,\"blockingIssues\":[]${visualReferenceUsageExample(visualReferences)},\"requiresPreview\":true,\"previewReason\":\"用户现在能检查什么\",\"checkpoints\":[${selectedPlan.map((item) => `{\"stepId\":\"${item.id}\",\"summary\":\"...\",\"actualChanges\":[\"...\"],\"evidence\":[\"...\"],\"verificationPassed\":true}`).join(",")}],\"artifact\":{\"title\":\"${project.primaryArtifact?.title ?? "主交付物"}\",\"kind\":\"${project.primaryArtifact?.kind ?? "text"}\",\"content\":\"完整内容或空字符串\",\"filename\":\"${project.primaryArtifact?.filename ?? "artifact.txt"}\",\"projectRoot\":\"项目工作目录绝对路径\",\"files\":[\"辅助文件\"],\"entrypoint\":\"${project.primaryArtifact?.entrypoint ?? project.primaryArtifact?.filename ?? "artifact.txt"}\",\"dependencies\":[],\"runCommands\":[],\"testCommands\":[],\"testResults\":[]}}}。必须一次连续完成全部里程碑；checkpoints 逐一覆盖 selectedPlan，但它们是同一次执行的证据记录。artifact 必须是规划锁定的主交付物，不能用说明文档、报告或截图替代。${visualReferences.length ? " visualReferencesUsed 必须逐一覆盖 request.visualReferences，且不得声称看过像素。" : ""}`
  };
  const workspace = resolveProjectWorkspace(project, settings);
  const documents = await harnessDocuments(project, workspace);
  const rawOutput = await invoke(request, settings, { workspace, ...documents }, signal, onEvent);
  let response;
  try {
    response = normalizeProjectExecutionResponse(extractJSONObject(rawOutput), requestId, project);
    if (!response.needsUserDirection) validateArtifactBoundary(response.result.artifact, workspace);
  } catch (error) {
    throwWithExecutionContext(error, { request, rawOutput });
  }
  if (response.needsUserDirection) return { needsUserDirection: true, ...response, request, rawOutput };
  if (!response.result.artifact) throw new Error("连续执行没有返回主交付物。");
  if (project.primaryArtifact && (response.result.artifact.filename !== project.primaryArtifact.filename || response.result.artifact.kind !== project.primaryArtifact.kind)) {
    throw new Error(`连续执行返回的 ${response.result.artifact.filename}（${response.result.artifact.kind}）与锁定主交付物 ${project.primaryArtifact.filename}（${project.primaryArtifact.kind}）不一致。`);
  }
  return { request, response, result: executionResultForServer(response), checkpoints: response.checkpoints, rawOutput };
}

export async function tracePreviewWithHarness({ project, step, subprocess, target, element, candidates }, settings, signal) {
  const requestId = randomUUID();
  if (!Array.isArray(candidates) || !candidates.length) throw new Error("没有找到可交给 Agent 判断的源码候选。");
  const request = {
    id: requestId,
    kind: "trace_preview_source",
    userGoal: project.goal,
    focus: "根据预览目标、用户可观察线索和限定候选，判断最可能负责该界面的源码位置。只能选择候选，不能修改文件；没有精确追溯证据时不得声称精确定位。",
    modelPolicy: MODEL_POLICY,
    stepSnapshot: { id: step.id, title: step.title, purpose: step.purpose, kind: step.kind, revision: step.revision },
    subprocessSnapshot: subprocess ? { id: subprocess.id, title: subprocess.title, purpose: subprocess.purpose, revision: subprocess.revision } : null,
    appendedRequirements: project.context.filter((item) => item.stepId === step.id && ["correction", "decision"].includes(item.kind)).map((item) => item.content),
    target: target ?? { kind: "dom", element },
    element,
    candidates: candidates.map((candidate, index) => ({ index, path: candidate.path, startLine: candidate.startLine, endLine: candidate.endLine, score: candidate.score, signals: candidate.signals, code: candidate.code })),
    responseInstructions: `返回 JSON：{\"requestID\":\"${requestId}\",\"status\":\"success\",\"selectedCandidateIndex\":0,\"decisionSummary\":\"用 1–3 句话说明使用了哪些可观察线索；不要输出隐藏思维链\"}。selectedCandidateIndex 必须是 candidates 中已有的 index。`
  };
  const workspace = resolveProjectWorkspace(project, settings);
  const documents = await harnessDocuments(project, workspace);
  const rawOutput = await invoke(request, settings, { workspace, ...documents }, signal);
  const response = extractJSONObject(rawOutput);
  const returnedId = response.requestID ?? response.request_id;
  if (returnedId && returnedId !== requestId) throw new Error("Agent 返回了错误的 requestID。");
  if ((response.status ?? "success") === "failure") throw new Error(response.error || "Agent 源码回溯失败。");
  const index = Number(response.selectedCandidateIndex ?? response.selected_candidate_index);
  if (!Number.isInteger(index) || !candidates[index]) throw new Error("Agent 返回了无效的源码候选编号。");
  return {
    result: { source: candidates[index], decisionSummary: String(response.decisionSummary ?? response.decision_summary ?? "Agent 已按元素线索选择最相关源码。") },
    request,
    rawOutput
  };
}

export async function learnWithHarness({ project, selection, module = "explanation", question = "", history = [], documentMode = false }, settings, signal) {
  const requestId = randomUUID();
  const moduleFocus = {
    explanation: "源码解释：说明这段代码做什么、为什么这样写，以及输入输出和关键控制流。",
    "data-structure": "数据结构：重点说明数据的形状、生命周期、读写关系、复杂度和边界条件。",
    syntax: "语法：逐项解释语言特性、运算符、类型、作用域和容易误解的写法。",
    flow: "运行流程：按实际执行顺序追踪调用、分支、循环、异步行为和错误路径。"
  };
  const normalizedHistory = (Array.isArray(history) ? history : []).slice(-16).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    text: String(message.text ?? "").slice(0, 12_000)
  }));
  const request = {
    id: requestId,
    kind: question ? "learning_follow_up" : documentMode ? "learning_explain_document" : "learning_explain_selection",
    systemPrompt: LEARNING_MODEL_POLICY,
    modelPolicy: LEARNING_MODEL_POLICY,
    projectContext: project ? { title: project.title, goal: project.goal } : null,
    module,
    focus: moduleFocus[module] ?? moduleFocus.explanation,
    source: selection,
    conversation: normalizedHistory,
    userQuestion: String(question ?? "").trim(),
    responseInstructions: documentMode
      ? `完整分析当前文件的${module === "data-structure" ? "数据结构" : "运行流程"}，返回 JSON：{"requestID":"${requestId}","status":"success","answer":"整份文件的总览","keyPoints":["全局关键点"],"concepts":["相关概念"],"followUpPrompts":["可继续追问的问题"],"sections":[{"title":"章节标题","explanation":"该段的完整中文解释","startLine":1,"endLine":30,"keyPoints":["本段关键点"]}]}。sections 必须覆盖文件中有意义的结构或流程；每章绑定一段连续且足够大的真实代码范围，行号必须在 1-${selection.endLine} 内。不得返回代码补丁或修改指令。`
      : `返回 JSON：{"requestID":"${requestId}","status":"success","answer":"面向学习者的完整中文解释","keyPoints":["关键点"],"concepts":["相关概念"],"followUpPrompts":["可继续追问的问题"],"codeReferences":[{"label":"这段代码支持哪条解释","startLine":${selection.startLine},"endLine":${selection.endLine}}]}。分析源码时 codeReferences 必须使用当前文件内的真实行号；纯外部参考资料可返回空数组。不得返回代码补丁或修改指令。`
  };
  const rawOutput = await invokeDisposable(request, settings, signal);
  return { result: normalizeLearningResponse(extractJSONObject(rawOutput), requestId, { maxLine: selection.endLine, requireSections: documentMode }), request, rawOutput };
}

export async function summarizeRepositoryWithHarness({ project, source, documents }, settings, signal) {
  const requestId = randomUUID();
  const request = {
    id: requestId,
    kind: "learning_repository_document_overviews",
    systemPrompt: LEARNING_MODEL_POLICY,
    modelPolicy: LEARNING_MODEL_POLICY,
    projectContext: project ? { title: project.title, goal: project.goal } : null,
    repository: { title: source.title, url: source.url },
    documents: documents.map((item) => ({ path: item.path, language: item.language, lineCount: item.lineCount, truncated: item.truncated, contentExcerpt: item.contentExcerpt })),
    responseInstructions: `只生成代码导航级概要，不做修改。必须为输入中的每一个 path 返回且只返回一个概要。返回 JSON：{"requestID":"${requestId}","status":"success","documents":[{"path":"与输入完全一致","summary":"该文档的用途和在仓库中的角色","responsibilities":["主要职责"],"keySymbols":["关键标识符"]}]}。不得把仓库地址当源码，不得编造未提供的文件、符号或调用关系；truncated=true 时明确只根据摘录总结。`
  };
  const rawOutput = await invokeDisposable(request, settings, signal);
  return { result: normalizeRepositoryOverviewResponse(extractJSONObject(rawOutput), requestId, documents), request, rawOutput };
}

export async function exploreWithHarness({ project = null, query, history = [], kind = "research" }, settings, signal) {
  const requestId = randomUUID();
  const normalizedKind = kind === "art" ? "art" : "research";
  const modelPolicy = explorationModelPolicy(normalizedKind);
  const normalizedHistory = (Array.isArray(history) ? history : []).slice(-12).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    text: String(message.text ?? "").slice(0, 12_000)
  }));
  const request = {
    id: requestId,
    kind: normalizedKind === "art" ? "visual_art_research" : "trusted_public_research",
    explorationKind: normalizedKind,
    systemPrompt: modelPolicy,
    modelPolicy,
    query: String(query ?? "").trim(),
    projectContext: project ? {
      title: project.title,
      goal: project.goal,
      technologies: (project.steps ?? []).flatMap((step) => [step.title, step.purpose]).filter(Boolean).slice(0, 20)
    } : null,
    conversation: normalizedHistory,
    requiredCapabilities: ["web_search"],
    networkRequirement: { required: true, failureMode: "return_failure", minimumHttpSources: 1 },
    failureInstructions: `必须先实际调用 web_search。web_search 不可用、调用失败或没有真实 HTTP(S) 来源时，返回 JSON：{"requestID":"${requestId}","status":"failure","error":"网页检索不可用：具体原因"}，不得凭模型记忆补写答案。`,
    responseInstructions: `返回 JSON：{"requestID":"${requestId}","status":"success","answer":"带事实、观察、推断和建议区分的中文研究结论","sources":[{"title":"来源标题","url":"https://...","type":"${normalizedKind === "art" ? "artist|museum|gallery|portfolio|publication|pinterest|article" : "official|repository|paper|article|community"}","credibility":"high|medium|low","credibilityReason":"可信度依据","projectRelevance":"与当前项目的关系或不相关","summary":"该来源支持什么"${normalizedKind === "art" ? `,"mediaKind":"image|document","previewURL":"可直接显示的公开图片 URL；无法确认则为空","creator":"创作者；未知则为空","license":"许可；未知则为空","licenseURL":"许可来源；未知则为空","sourceName":"原始站点或馆藏","width":null,"height":null,"visualDescription":"只写来源明确提供或当前页面可核查的视觉说明，不猜测"` : ""}}],"unknowns":["仍未验证的事项"],"nextQuestions":["可继续探索的问题"]}。关键结论必须有真实可核查 URL；没有证据就列入 unknowns。${normalizedKind === "art" ? " 图片字段只能在来源直接支持时填写；不要杜撰缩略图、作者、尺寸或许可。" : ""}`
  };
  if (!request.query) throw new Error("请输入要探索的问题。");
  const rawOutput = await invokeDisposable(request, settings, signal);
  return { result: normalizeExplorationResponse(extractJSONObject(rawOutput), requestId), request, rawOutput };
}
