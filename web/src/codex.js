import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildAgentPrompt } from "./agent-prompt.js";
import { resolveModelRoute, smartRoutingEnabled } from "./smart-routing.js";
import { BROWSER_VERIFY_TOOL, verifyBrowserArtifact } from "./browser-verifier.js";
import { discoverCodexInstallations } from "./codex-installation.js";

const MAX_STREAM_BYTES = 32 * 1024 * 1024;

function codexErrorDetail(value, depth = 0) {
  if (depth > 2 || value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value).trim();
  if (Array.isArray(value)) return value.map((item) => codexErrorDetail(item, depth + 1)).filter(Boolean).join(" · ");
  if (typeof value !== "object") return "";
  const preferredKeys = ["message", "detail", "details", "additionalDetails", "reason", "code", "type"];
  const parts = preferredKeys.flatMap((key) => {
    const detail = codexErrorDetail(value[key], depth + 1);
    return detail ? [detail] : [];
  });
  return [...new Set(parts)].join(" · ").slice(0, 2_000);
}

async function isExecutable(candidate) {
  if (!candidate) return false;
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodex({
  explicitPath = process.env.LOOPCANVAS_CODEX_EXECUTABLE ?? "",
  home = os.homedir(),
  envPath = process.env.PATH ?? "",
  platform = process.platform,
  applicationsRoot = "/Applications",
  fallbackPaths
} = {}) {
  if (explicitPath) return (await isExecutable(explicitPath)) ? explicitPath : null;

  const installations = await discoverCodexInstallations({ home, envPath, platform, applicationsRoot, fallbackPaths });
  return installations[0]?.path ?? null;
}

function createClient(executable, { cwd, signal, onToolCall, timeoutMs = 30 * 60 * 1000 } = {}) {
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    cwd,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let nextId = 0;
  let stdoutBuffer = "";
  const stdoutDecoder = new StringDecoder("utf8");
  let stderr = "";
  let fatalError = null;
  let closing = false;
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = [];

  const terminate = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  const fail = (error) => {
    if (fatalError || closing) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    for (const waiter of pending.values()) waiter.reject(fatalError);
    pending.clear();
    while (notificationWaiters.length) notificationWaiters.shift().reject(fatalError);
    terminate();
  };
  const abort = () => fail(new Error("任务已暂停，Codex App Server 进程已取消。"));
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => fail(new Error(`Codex App Server 执行超过 ${Math.round(timeoutMs / 1000)} 秒，已终止。`)), timeoutMs);

  const deliverNotification = (message) => {
    const waiter = notificationWaiters.shift();
    if (waiter) waiter.resolve(message);
    else notifications.push(message);
  };
  const handleMessage = (message) => {
    if (message.id != null) {
      if (message.method) {
        if (message.method === "item/tool/call" && onToolCall) {
          Promise.resolve().then(() => onToolCall(message.params)).then((result) => {
            if (!closing && !fatalError) send({ id: message.id, result });
          }).catch((error) => {
            if (!closing && !fatalError) send({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: error.message }] } });
          });
          return;
        }
        fail(new Error(`Codex 请求额外审批或客户端操作（${message.method}）；为安全起见已停止。`));
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || `Codex 请求 ${message.id} 失败。`));
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (message.method) deliverNotification(message);
  };
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += stdoutDecoder.write(chunk);
    if (Buffer.byteLength(stdoutBuffer) > MAX_STREAM_BYTES) return fail(new Error("Codex App Server 单条输出超过 32 MiB，已停止解析。"));
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try { handleMessage(JSON.parse(line)); }
      catch { fail(new Error("Codex App Server 返回了无法解析的 JSONL。")); }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (Buffer.byteLength(stderr) > MAX_STREAM_BYTES) stderr = stderr.slice(-MAX_STREAM_BYTES);
  });
  child.on("error", (error) => fail(new Error(`Codex App Server 启动失败：${error.message}`)));
  child.on("close", (code) => {
    if (closing) return;
    fail(new Error(stderr.trim() || `Codex App Server 在请求完成前退出（状态 ${code ?? "未知"}）。`));
  });

  const send = (message) => {
    if (fatalError) throw fatalError;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method, params = {}, { timeoutMs: requestTimeoutMs = 0 } = {}) => new Promise((resolve, reject) => {
    if (fatalError) return reject(fatalError);
    const id = nextId++;
    const requestTimer = requestTimeoutMs > 0 ? setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex ${method} 查询超时。`));
    }, requestTimeoutMs) : null;
    pending.set(id, {
      resolve: (value) => { clearTimeout(requestTimer); resolve(value); },
      reject: (error) => { clearTimeout(requestTimer); reject(error); }
    });
    try { send({ method, id, params }); }
    catch (error) { clearTimeout(requestTimer); pending.delete(id); reject(error); }
  });
  const notify = (method, params = {}) => send({ method, params });
  const nextNotification = () => {
    if (fatalError) return Promise.reject(fatalError);
    if (notifications.length) return Promise.resolve(notifications.shift());
    return new Promise((resolve, reject) => notificationWaiters.push({ resolve, reject }));
  };
  const close = () => {
    closing = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    for (const waiter of pending.values()) waiter.reject(new Error("Codex App Server 连接已关闭。"));
    pending.clear();
    while (notificationWaiters.length) notificationWaiters.shift().reject(new Error("Codex App Server 连接已关闭。"));
    try { child.stdin.end(); } catch {}
    terminate();
  };
  return { request, notify, nextNotification, close };
}

async function initialize(client, experimentalApi = false) {
  await client.request("initialize", {
    clientInfo: { name: "loopcanvas_web", title: "LoopCanvas Web", version: "0.1.0" },
    ...(experimentalApi ? { capabilities: { experimentalApi: true } } : {})
  });
  client.notify("initialized", {});
}

function executableSettings(settings = {}) {
  return { explicitPath: settings.codexPath || process.env.LOOPCANVAS_CODEX_EXECUTABLE || "" };
}

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function compactText(value, maximum = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function activityForItem(item = {}, completed = false) {
  if (item.type === "reasoning") return completed ? null : "Codex 正在处理当前节点";
  if (item.type === "agentMessage") return completed && item.phase === "commentary"
    ? compactText(item.text, 180) : "Codex 正在整理回复";
  if (item.type === "commandExecution") return `${completed ? "命令已结束" : "运行命令"}：${compactText(item.command || "本机命令")}`;
  if (item.type === "fileChange") {
    const paths = (item.changes ?? []).map((change) => change.path).filter(Boolean);
    return paths.length ? `修改文件：${paths.slice(0, 2).join("、")}${paths.length > 2 ? ` 等 ${paths.length} 个文件` : ""}` : "修改工作区文件";
  }
  if (item.type === "mcpToolCall") return `调用 ${compactText(`${item.server || "MCP"}.${item.tool || "tool"}`)} 工具`;
  if (item.type === "dynamicToolCall") return `调用 ${compactText(item.tool || "动态工具")} 工具`;
  if (item.type === "webSearch") return `检索：${compactText(item.query || "公开资料")}`;
  if (item.type === "imageView") return `查看图像：${compactText(item.path || "图像文件")}`;
  if (item.type === "contextCompaction") return "压缩上下文以继续执行";
  return null;
}

function metricsFromCodex(tokenUsage, accountUsage, rateLimits) {
  const total = tokenUsage?.total ?? {};
  const last = tokenUsage?.last ?? {};
  const inputTokens = finiteNumber(total.inputTokens);
  const cachedInputTokens = finiteNumber(total.cachedInputTokens) ?? 0;
  const contextInput = finiteNumber(last.inputTokens);
  const contextWindow = finiteNumber(tokenUsage?.modelContextWindow);
  const primary = rateLimits?.rateLimits?.primary ?? null;
  const usedPercent = finiteNumber(primary?.usedPercent);
  const lifetimeTokens = finiteNumber(accountUsage?.summary?.lifetimeTokens);
  return {
    runtime: "codex",
    source: "Codex App Server",
    cumulativeMode: "absolute",
    cumulativeTokens: lifetimeTokens ?? finiteNumber(total.totalTokens),
    uncachedInputTokens: inputTokens == null ? null : Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    outputTokens: finiteNumber(total.outputTokens),
    cacheHitRate: inputTokens && inputTokens > 0 ? Math.min(1, cachedInputTokens / inputTokens) : null,
    contextTokens: contextInput,
    contextWindow,
    contextPercent: contextInput != null && contextWindow ? Math.min(1, contextInput / contextWindow) : null,
    remainingPercent: usedPercent == null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    remainingLabel: "Codex 额度剩余",
    resetsAt: finiteNumber(primary?.resetsAt)
  };
}

export async function listCodexModels(settings = {}, signal) {
  const executable = await resolveCodex(executableSettings(settings));
  if (!executable) throw new Error("未找到 Codex。请确认 Codex CLI 或 ChatGPT macOS 应用已安装。");
  const client = createClient(executable, { cwd: os.tmpdir(), signal, timeoutMs: 30_000 });
  try {
    await initialize(client);
    const models = [];
    let cursor = null;
    for (let page = 0; page < 5; page += 1) {
      const result = await client.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...(Array.isArray(result.data) ? result.data : []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return models.map((model) => ({
      id: String(model.id || model.model),
      model: String(model.model || model.id),
      displayName: String(model.displayName || model.model || model.id),
      description: String(model.description || ""),
      isDefault: Boolean(model.isDefault),
      defaultReasoningEffort: String(model.defaultReasoningEffort || ""),
      supportedReasoningEfforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
        .map((item) => ({ reasoningEffort: String(item.reasoningEffort || ""), description: String(item.description || "") }))
        .filter((item) => item.reasoningEffort)
    })).filter((model) => model.model);
  } finally {
    client.close();
  }
}

const CORE_CODEX_TOOLS = Object.freeze([
  { name: "exec_command", title: "运行本机命令", description: "在工作流运行目录中执行命令并读取真实输出。", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "apply_patch", title: "修改工作区文件", description: "以补丁方式创建或修改工作流运行目录中的文件。", inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] } },
  { name: "web_search", title: "网页检索", description: "检索公开网页并返回可核查来源；是否可用取决于当前 Codex 配置和网络。", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "view_image", title: "查看本机图像", description: "读取工作区中的图像供 Agent 检查。", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "loopcanvas_verify_browser", title: "隔离浏览器验收", description: "在 LoopCanvas 管理的隔离浏览器中渲染 HTML、截图并生成打印证据。", inputSchema: BROWSER_VERIFY_TOOL.inputSchema }
]);

function codexToolEntry(tool, { source = "codex-core", namespace = "", binding = null, available = true, unavailableReason = "" } = {}) {
  const compactSchema = (schema, depth = 0) => {
    if (!schema || typeof schema !== "object" || depth > 3) return schema;
    if (Array.isArray(schema)) return schema.slice(0, 30).map((item) => compactSchema(item, depth + 1));
    const result = {};
    for (const key of ["type", "description", "required", "enum", "default", "minimum", "maximum", "additionalProperties"]) {
      if (schema[key] !== undefined) result[key] = key === "description" ? String(schema[key]).slice(0, 500) : compactSchema(schema[key], depth + 1);
    }
    if (schema.properties && typeof schema.properties === "object") result.properties = Object.fromEntries(Object.entries(schema.properties).slice(0, 80).map(([key, value]) => [key, compactSchema(value, depth + 1)]));
    if (schema.items !== undefined) result.items = compactSchema(schema.items, depth + 1);
    for (const key of ["anyOf", "oneOf", "allOf"]) if (schema[key]) result[key] = compactSchema(schema[key], depth + 1);
    return result;
  };
  return {
    name: String(tool.name),
    title: String(tool.title || tool.name),
    description: String(tool.description || "Codex 工具").slice(0, 800),
    arguments: compactSchema(tool.inputSchema ?? { type: "object" }),
    source,
    namespace,
    binding: binding ?? { kind: source, name: String(tool.name) },
    available,
    unavailableReason
  };
}

/** Return the tools Codex can expose to a workflow without executing any of them. */
export async function listCodexTools(settings = {}, signal) {
  const executable = await resolveCodex(executableSettings(settings));
  const selected = settings.agentRuntime === "codex";
  if (!executable) return CORE_CODEX_TOOLS.map((tool) => codexToolEntry(tool, { available: false, unavailableReason: "未找到 Codex App Server。" }));
  const tools = CORE_CODEX_TOOLS.map((tool) => codexToolEntry(tool, { available: selected, unavailableReason: selected ? "" : "当前执行引擎不是 Codex App Server。" }));
  const client = createClient(executable, { cwd: settings.workspace || os.tmpdir(), signal, timeoutMs: 30_000 });
  try {
    await initialize(client, true);
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await client.request("mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) }, { timeoutMs: 12_000 });
      for (const server of Array.isArray(result.data) ? result.data : []) {
        const runtimeAvailable = !["failed", "cancelled", "disabled", "authenticationRequired"].includes(server.runtimeStatus) && server.authStatus !== "notLoggedIn";
        for (const definition of Object.values(server.tools ?? {})) {
          const canonical = `mcp__${String(server.name).replace(/[^\w-]/g, "_")}__${String(definition.name).replace(/[^\w-]/g, "_")}`;
          tools.push(codexToolEntry({ ...definition, name: canonical }, {
            source: "codex-mcp",
            namespace: String(server.name),
            binding: { kind: "mcp", server: String(server.name), tool: String(definition.name) },
            available: selected && runtimeAvailable,
            unavailableReason: selected && runtimeAvailable ? "" : !selected ? "当前执行引擎不是 Codex App Server。" : server.authStatus === "notLoggedIn" ? "MCP 服务尚未登录。" : `MCP 服务状态：${server.runtimeStatus || "不可用"}`
          }));
        }
      }
      cursor = result.nextCursor || null;
      if (!cursor) break;
    }

    const apps = [];
    cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await client.request("app/list", { limit: 100, forceRefetch: false, ...(cursor ? { cursor } : {}) }, { timeoutMs: 12_000 }).catch(() => ({ data: [], nextCursor: null }));
      apps.push(...(Array.isArray(result.data) ? result.data : []).filter((app) => app.isAccessible && app.isEnabled !== false));
      cursor = result.nextCursor || null;
      if (!cursor) break;
    }
    for (let offset = 0; offset < apps.length; offset += 100) {
      const result = await client.request("app/read", { appIds: apps.slice(offset, offset + 100).map((app) => app.id), includeTools: true }, { timeoutMs: 12_000 }).catch(() => ({ apps: [] }));
      for (const app of Array.isArray(result.apps) ? result.apps : []) for (const summary of app.toolSummaries ?? []) {
        const canonical = `app__${String(app.id).replace(/[^\w-]/g, "_")}__${String(summary.name).replace(/[^\w-]/g, "_")}`;
        tools.push(codexToolEntry({ ...summary, name: canonical, inputSchema: { type: "object", description: summary.description } }, {
          source: "codex-app",
          namespace: String(app.name),
          binding: { kind: "app", appId: String(app.id), appName: String(app.name), tool: String(summary.name) },
          available: selected && summary.isEnabled !== false && !summary.disabledReason,
          unavailableReason: !selected ? "当前执行引擎不是 Codex App Server。" : String(summary.disabledReason || "")
        }));
      }
    }
    return tools;
  } catch (error) {
    return tools.map((tool) => tool.source === "codex-core" ? { ...tool, inventoryWarning: `动态工具目录读取失败：${error.message}` } : tool);
  } finally {
    client.close();
  }
}

export function codexPrompt(request, workspace, options, writable) {
  return buildAgentPrompt({
    runtime: "codex",
    workspace,
    request,
    agents: options.agents,
    constitution: options.constitution,
    extraBoundaries: writable ? "浏览器验收优先调用已提供的 loopcanvas_verify_browser（entrypoint 为项目相对 HTML 路径）。该工具由宿主管理独立无头浏览器与临时目录，返回实际截图、打印 PDF 和报告；不连接个人浏览器会话。渲染成功不等于验收通过，必须检查返回图像与打印证据。资源阻断或启动失败时如实报告，不得使用 --no-sandbox、个人 profile 或要求整体关闭执行沙盒。" : "",
    accessBoundary: writable
      ? "当前为 workspace-write、允许按任务需要访问公开网络且不自动批准越权操作；项目文件写入与命令的工作目录必须位于项目内；可调用已安装的工具。宿主管理的隔离浏览器可使用专用临时目录，证据保存到项目内。"
      : "本次为 read-only、允许按任务需要访问公开网络且不自动批准越权操作；不得创建、修改或删除任何文件，不得运行会改变状态的命令。"
  });
}

export async function invokeCodex(request, settings, options = {}, signal, onEvent) {
  const executable = await resolveCodex(executableSettings(settings));
  if (!executable) throw new Error("未找到 Codex。请确认 Codex CLI 或 ChatGPT macOS 应用已安装。");
  const workspace = path.resolve(options.workspace ?? settings.workspace);
  const route = resolveModelRoute(request, settings);
  onEvent?.({ type: "route", route });
  const legacyWritable = request.kind === "route_project" || request.kind === "execute_step" || request.kind === "execute_project" || request.kind === "custom_workflow_execute";
  const readonlyAnalysis = request.node?.type === "review" || (request.kind === "custom_workflow_execute" && ["agent_transcript_analyze", "agent_media_match"].includes(request.node?.tool));
  const writable = !readonlyAnalysis && (smartRoutingEnabled(settings, request) ? route.role === "executor" : legacyWritable);
  let workingDirectory = workspace;
  if (writable) await mkdir(workspace, { recursive: true });
  else await access(workspace).catch(() => { workingDirectory = os.tmpdir(); });
  let activeThreadId = "";
  let browserBusy = false;
  const browserLifetime = new AbortController();
  const browserSignal = signal ? AbortSignal.any([signal, browserLifetime.signal]) : browserLifetime.signal;
  const client = createClient(executable, { cwd: workingDirectory, signal, onToolCall: writable ? async (params) => {
    if (params?.tool !== BROWSER_VERIFY_TOOL.name || params.namespace || params.threadId !== activeThreadId || !activeThreadId || !params.turnId || !params.callId) throw new Error("未授权的客户端工具请求。");
    if (browserBusy) throw new Error("当前会话已有浏览器验收在运行，请等待结果后重试。");
    browserBusy = true;
    try {
      onEvent?.({ type: "activity", activity: "隔离浏览器渲染与打印验收" });
      const { report, screenshot } = await verifyBrowserArtifact(workspace, params.arguments, { signal: browserSignal });
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(report) },
        ...(screenshot.length <= 8 * 1024 * 1024 ? [{ type: "inputImage", imageUrl: `data:image/png;base64,${screenshot.toString("base64")}` }] : [{ type: "inputText", text: "截图超过内联限制，请打开报告中的 screenshot 文件检查。" }])] };
    } finally { browserBusy = false; }
  } : undefined });
  try {
    await initialize(client, writable);
    if (route.routed) {
      const catalog = [];
      let cursor = null;
      do {
        const page = await client.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        catalog.push(...(Array.isArray(page?.data) ? page.data : []));
        cursor = page?.nextCursor || null;
      } while (cursor && catalog.length < 500);
      const selected = catalog.find((item) => String(item.model || item.id) === route.model);
      if (!selected) throw new Error(`${route.role} 需要模型 ${route.model}，但本机 Codex 模型目录中不可用。`);
      const supportedEfforts = (Array.isArray(selected.supportedReasoningEfforts) ? selected.supportedReasoningEfforts : []).map((item) => String(item.reasoningEffort || "")).filter(Boolean);
      if (route.effort && !supportedEfforts.includes(route.effort)) throw new Error(`${route.model} 的本机模型目录未明确包含 ${route.role} 所需的 ${route.effort} 推理强度。`);
      onEvent?.({ type: "route", route: { ...route, catalogValidated: true, actualModel: String(selected.model || selected.id), actualEffort: route.effort } });
    }
    onEvent?.({ type: "activity", activity: "连接 Codex App Server" });
    // Optional telemetry must never hold a completed result until the turn timeout.
    const telemetryOptions = { timeoutMs: 1500 };
    const accountUsagePromise = client.request("account/usage/read", {}, telemetryOptions).catch(() => null);
    const rateLimitsPromise = client.request("account/rateLimits/read", {}, telemetryOptions).catch(() => null);
    const model = String(route.model || settings.codexModel || "").trim();
    const effort = String(route.routed ? route.effort ?? "" : route.effort || settings.codexReasoningEffort || "").trim();
    const threadResult = await client.request("thread/start", {
      cwd: workingDirectory,
      approvalPolicy: "never",
      sandbox: writable ? "workspace-write" : "read-only",
      ephemeral: true,
      ...(writable ? { dynamicTools: [BROWSER_VERIFY_TOOL] } : {}),
      ...(model ? { model } : {})
    });
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw new Error("Codex thread/start 未返回 thread id。");
    activeThreadId = threadId;
    await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: codexPrompt(request, workspace, options, writable) }],
      approvalPolicy: "never",
      sandboxPolicy: writable
        ? { type: "workspaceWrite", writableRoots: [workspace], networkAccess: true }
        : { type: "readOnly", networkAccess: true },
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(request.responseSchema ? { outputSchema: request.responseSchema } : {})
    });

    const finalMessages = [];
    const deltas = new Map();
    let serverError = "";
    const itemErrors = [];
    let tokenUsage = null;
    while (true) {
      const message = await client.nextNotification();
      const params = message.params ?? {};
      if (message.method === "item/agentMessage/delta" && params.itemId && typeof params.delta === "string") {
        deltas.set(params.itemId, `${deltas.get(params.itemId) ?? ""}${params.delta}`);
        onEvent?.({ type: "heartbeat" });
      } else if (message.method === "item/started") {
        onEvent?.({ type: "activity", activity: activityForItem(params.item), item: params.item });
      } else if (message.method === "item/completed" && params.item) {
        const itemError = codexErrorDetail(params.item.error ?? (params.item.status === "failed" ? params.item : null));
        if (itemError) itemErrors.push(itemError);
        if (params.item.type === "agentMessage" && params.item.phase !== "commentary" && String(params.item.text || "").trim()) finalMessages.push(String(params.item.text));
        onEvent?.({ type: "activity", activity: activityForItem(params.item, true), item: params.item });
      } else if (["item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/commandExecution/outputDelta"].includes(message.method)) {
        // Record liveness without exposing reasoning or raw command output.
        onEvent?.({ type: "heartbeat" });
      } else if (message.method === "turn/plan/updated") {
        const current = params.plan?.find((entry) => entry.status === "inProgress");
        if (current?.step) onEvent?.({ type: "activity", activity: `正在执行：${compactText(current.step, 180)}` });
      } else if (message.method === "thread/tokenUsage/updated") {
        tokenUsage = params.tokenUsage ?? null;
        onEvent?.({ type: "metrics", metrics: metricsFromCodex(tokenUsage, null, null) });
      } else if (message.method === "error") {
        serverError = codexErrorDetail(params.error ?? params);
      } else if (message.method === "turn/completed") {
        if (params.turn?.status !== "completed") {
          const details = [codexErrorDetail(params.turn?.error), serverError, ...itemErrors].filter(Boolean);
          throw new Error([...new Set(details)].join("；").slice(0, 4_000) || `Codex 回合状态为 ${params.turn?.status || "未知"}。`);
        }
        const final = finalMessages.at(-1) || [...deltas.values()].at(-1) || "";
        if (!final.trim()) throw new Error("Codex 回合完成但没有 agentMessage 文本。");
        onEvent?.({ type: "activity", activity: "Codex 已返回结果，正在校验产物" });
        const [accountUsage, rateLimits] = await Promise.all([accountUsagePromise, rateLimitsPromise]);
        onEvent?.({ type: "metrics", metrics: metricsFromCodex(tokenUsage, accountUsage, rateLimits) });
        return final;
      }
    }
  } finally {
    browserLifetime.abort();
    client.close();
  }
}
