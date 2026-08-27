import { githubRepositoryURL } from "./learning-reference.js";

let session = null;
let selectedStepId = null;
let selectedSubprocessId = null;
let selectedDebugRecordId = null;
let previewTraceBusy = false;
let traceSourceDrawer = { open: false, loading: false, error: "", recordId: null, file: null };
let traceSourceDrawerReturnFocus = null;
let busy = false;
let busyProjectId = null;
let busySurface = null;
let capabilityItems = [];
let pluginCatalogItems = [];
let pendingPluginEnable = null;
let sidebarCollapsed = false;
let projectDocuments = null;
let conversationItems = [];
let appMode = "workflow";
let workspaceView = "mode";
let explorationThreadId = null;
let explorationBusy = false;
let explorationUseProject = true;
let explorationKind = "research";
let codexModels = [];
let codexModelsStatus = "idle";
let codexModelsError = "";
let executionBlock = null;
let runtimeStatus = null;
let runtimePollTimer = null;
let runtimePollInFlight = false;
let automaticRunProjectId = null;
let recoveredExecutionProjectId = null;
let recoveredExecutionSyncInFlight = false;
let previewGate = null;
let remoteUI = {
  open: false,
  status: null,
  pairing: null,
  pending: null,
  lastHandoff: null,
  pollTimer: null,
  refreshing: false
};
const directionDrafts = new Map();
function newLearningUI(projectId = null) { return {
  projectId, sources: [], sourceId: "project", files: [], workspace: "", file: null, module: "explanation", filter: "",
  repoQuery: "", repoResults: [], searching: false, importing: false,
  threadId: null, threadView: "active", threadMenu: null, materialId: null, shelfView: "active", selection: null, popup: null, loadingFiles: false, busy: false,
  traceSelection: null,
  materialAdding: false,
  repositoryOverview: null, repositoryOverviewLoading: false, repositoryOverviewBusy: false
}; }
let learningUI = newLearningUI();
const documentLearningModules = new Set(["data-structure", "flow"]);

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const formatBytes = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const formatTokenCount = (value) => !Number.isFinite(value) ? "—" : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K` : String(Math.round(value));
const highRisk = (step) => ["L2", "L3"].includes(step?.riskLevel);
const safeWebURL = (value) => { try { const url = new URL(String(value)); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } };
const pinterestSearchURL = (query) => {
  const normalized = String(query ?? "").trim().slice(0, 500);
  return normalized ? `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(normalized)}` : "";
};

function replaceThread(collection, thread) {
  const index = collection.findIndex((item) => item.id === thread.id);
  if (index >= 0) collection[index] = thread;
  else collection.unshift(thread);
}

function encodedTransferReference(reference) {
  return escapeHTML(encodeURIComponent(JSON.stringify({
    type: String(reference.type ?? "reference").slice(0, 40),
    title: String(reference.title ?? "未命名参考").slice(0, 240),
    url: String(reference.url ?? "").slice(0, 2_000),
    summary: String(reference.summary ?? reference.content ?? "").slice(0, 24_000),
    origin: String(reference.origin ?? appMode).slice(0, 80),
    mediaKind: reference.mediaKind === "image" ? "image" : "document",
    previewURL: String(reference.previewURL ?? "").slice(0, 2_000),
    creator: String(reference.creator ?? "").slice(0, 240),
    license: String(reference.license ?? "").slice(0, 240),
    licenseURL: String(reference.licenseURL ?? "").slice(0, 2_000),
    sourceName: String(reference.sourceName ?? "").slice(0, 240),
    width: Number.isInteger(Number(reference.width)) ? Number(reference.width) : null,
    height: Number.isInteger(Number(reference.height)) ? Number(reference.height) : null,
    visualDescription: String(reference.visualDescription ?? "").slice(0, 12_000)
  })));
}

function decodedTransferReference(value) {
  try { return JSON.parse(decodeURIComponent(String(value ?? ""))); } catch { return null; }
}

async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: { "Content-Type": "application/json", ...(session?.token ? { "X-LoopCanvas-Token": session.token } : {}), ...(options.headers ?? {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function activeProject() { return session?.state.projects.find((project) => project.id === session.state.activeProjectId) ?? null; }
function activeAgentLabel() { return session.state.settings.agentRuntime === "codex" ? "Codex" : "DeepSeek Harness"; }
function stepStatus(status) { return ({ locked: "需前置", ready: "可执行", running: "执行中", review: "待验收", approved: "已通过", stale: "需复核", error: "出错" })[status] ?? status; }
function subprocessStatus(status) { return ({ locked: "需前置", ready: "可执行", running: "执行中", review: "待验收", approved: "已通过", error: "出错" })[status] ?? status; }

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.setAttribute("role", error ? "alert" : "status");
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 4_500);
}

const remoteDeviceIcon = (kind) => kind === "phone"
  ? `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"></rect><path d="M10 5h4M11 18.5h2"></path></svg>`
  : `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"></rect><path d="M8 20h8M12 16v4"></path></svg>`;

function remoteDevices() {
  return Array.isArray(remoteUI.status?.devices) ? remoteUI.status.devices : [];
}

async function refreshRemoteStatus({ quiet = false } = {}) {
  if (remoteUI.refreshing) return;
  remoteUI.refreshing = true;
  try {
    const previousPending = remoteUI.status?.pendingCount ?? 0;
    remoteUI.status = (await api("/api/remote/status")).remote;
    renderRemotePanel();
    if (quiet && remoteUI.status.pendingCount > previousPending && !remoteUI.open) showToast(`收到 ${remoteUI.status.pendingCount - previousPending} 条 Remote 命令，等待本机批准。`);
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  } finally {
    remoteUI.refreshing = false;
    clearTimeout(remoteUI.pollTimer);
    if (remoteUI.status?.enabled) remoteUI.pollTimer = setTimeout(() => refreshRemoteStatus({ quiet: true }), 3_000);
  }
}

function renderRemotePanel() {
  const panel = $("#remote-panel");
  if (!panel) return;
  const status = remoteUI.status ?? { enabled: false, channels: {}, devices: [], commands: [], pendingCount: 0, transport: "unconfigured" };
  panel.classList.toggle("open", remoteUI.open);
  panel.setAttribute("aria-hidden", String(!remoteUI.open));
  $("#open-remote").classList.toggle("active", remoteUI.open || (status.enabled && (status.devices.length > 0 || status.pendingCount > 0)));
  $("#open-remote").setAttribute("aria-expanded", String(remoteUI.open));
  $("#create-remote-pairing").disabled = !status.enabled;
  const pairing = $("#remote-pairing-state");
  if (!status.enabled) pairing.innerHTML = `<p class="remote-empty">Remote 未启动。使用公共 HTTPS 地址显式启动后，才能生成二维码；管理 API 仍只监听本机。</p>`;
  else if (remoteUI.pairing) pairing.innerHTML = `<div class="remote-qr">${remoteUI.pairing.qrSVG}<div><strong>二维码 5 分钟内、且仅可使用一次</strong><small>${escapeHTML(remoteUI.pairing.url.replace(/#.*/, "#…"))}</small></div></div>`;
  else pairing.innerHTML = `<p class="remote-empty">尚无有效配对码。二维码密钥由本机生成，不经过第三方二维码服务。</p>`;
  $("#remote-channel-list").innerHTML = [
    { id: "wechat", name: "微信", icon: "微" },
    { id: "whatsapp", name: "WhatsApp", icon: "WA" }
  ].map((channel) => { const configured = status.channels?.[channel.id]?.configured; return `<div class="remote-channel ${configured ? "connected" : ""}" data-remote-channel="${channel.id}"><span class="remote-channel-icon">${channel.icon}</span><span><strong>${channel.name}</strong><small>${configured ? "已配置签名校验与发送者白名单" : channel.id === "wechat" ? "需服务号/测试号 Token 与 OpenID 白名单" : "需 Cloud API App Secret、验证 Token 与号码白名单"}</small></span></div>`; }).join("");
  $("#remote-device-list").innerHTML = remoteDevices().length ? remoteDevices().map((device) => `<div class="remote-device ${device.online ? "" : "disabled"}" data-remote-device="${escapeHTML(device.id)}" aria-disabled="${device.online ? "false" : "true"}" title="${device.online ? `把网页拖到 ${escapeHTML(device.name)}` : "设备最近 90 秒没有心跳"}" tabindex="${device.online ? "0" : "-1"}"><span class="remote-device-icon">${remoteDeviceIcon(device.kind)}</span><span class="remote-device-copy"><strong>${escapeHTML(device.name)}</strong><span>${device.capability === "loopcanvas-runtime" ? "可运行 LoopCanvas" : "浏览器控制器 · 只能接收网页"}</span></span><span class="remote-device-state ${device.online ? "online" : ""}">${device.online ? "在线" : "离线"}</span><button type="button" class="remote-device-revoke" data-revoke-remote-device="${escapeHTML(device.id)}" aria-label="撤销 ${escapeHTML(device.name)}">撤销</button></div>`).join("") : `<p class="remote-empty">没有已配对设备。生成二维码并用手机相机扫描。</p>`;
  const pendingCommands = (status.commands ?? []).filter((item) => item.status === "pending");
  $("#remote-command-count").textContent = `${pendingCommands.length} 条`;
  $("#remote-command-list").innerHTML = pendingCommands.length ? pendingCommands.map((item) => { const needsTarget = ["open_url", "handoff"].includes(item.command.type); return `<article class="remote-command"><div><strong>${escapeHTML(item.command.label)}</strong><small>${escapeHTML(item.channel)} · ${escapeHTML(item.sender)}</small>${item.command.url ? `<span>${escapeHTML(item.command.url)}</span>` : ""}</div>${needsTarget ? `<select data-remote-command-target="${escapeHTML(item.id)}" aria-label="目标设备"><option value="">选择目标设备</option>${remoteDevices().filter((device) => device.online).map((device) => `<option value="${escapeHTML(device.id)}">${escapeHTML(device.name)}</option>`).join("")}</select>` : ""}<div class="remote-command-actions"><button type="button" class="ghost compact" data-remote-command-decision="rejected" data-remote-command-id="${escapeHTML(item.id)}">拒绝</button><button type="button" class="primary compact" data-remote-command-decision="approved" data-remote-command-id="${escapeHTML(item.id)}">批准</button></div></article>`; }).join("") : `<p class="remote-empty">没有等待批准的消息命令。</p>`;
  const last = $("#remote-last-handoff");
  last.classList.toggle("hidden", !remoteUI.lastHandoff);
  if (remoteUI.lastHandoff) last.textContent = `最近一次已发送网页：${remoteUI.lastHandoff.title} → ${remoteUI.lastHandoff.device}`;
}

function setRemotePanel(open, { focus = false } = {}) {
  remoteUI.open = Boolean(open);
  renderRemotePanel();
  clearTimeout(remoteUI.pollTimer);
  if (remoteUI.open) refreshRemoteStatus({ quiet: true });
  if (remoteUI.open && focus) requestAnimationFrame(() => $("#remote-panel [data-remote-device]")?.focus({ preventScroll: true }));
  if (!remoteUI.open && focus) $("#open-remote")?.focus({ preventScroll: true });
}

function referenceFromDataTransfer(dataTransfer) {
  try {
    const internal = dataTransfer.getData("application/x-loopcanvas-reference");
    if (internal) return JSON.parse(internal);
  } catch {}
  const candidate = String(dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain") || "").split("\n").find((line) => line.trim() && !line.trim().startsWith("#"))?.trim();
  const url = safeWebURL(candidate);
  return url ? { type: "webpage", title: new URL(url).hostname, url, summary: "从浏览器拖入的网页", origin: "external" } : null;
}

function openRemoteRun(reference, deviceId, { needsURL = false } = {}) {
  const device = remoteDevices().find((item) => item.id === deviceId);
  if (!device?.online) return showToast("目标设备当前不在线。", true);
  remoteUI.pending = { reference, device };
  const resourceURL = safeWebURL(reference.url);
  $("#remote-run-content").innerHTML = `<div class="remote-resource"><span>发送到 ${escapeHTML(device.name)}</span><strong>${escapeHTML(reference.title || "未命名网页")}</strong>${resourceURL ? `<small>${escapeHTML(resourceURL)}</small>` : ""}</div>${needsURL ? `<label class="remote-link-field" for="remote-link-input">网页链接<input id="remote-link-input" name="remote-link" type="url" inputmode="url" autocomplete="url" placeholder="https://example.com" required autofocus></label>` : ""}<p class="remote-truth-note">目标设备收到后再选择“在本设备运行”或“在原设备运行”。当前目标是${device.capability === "loopcanvas-runtime" ? "可运行 LoopCanvas 的设备" : "浏览器控制器，只能选择在原设备运行 Agent"}。</p>`;
  $("#remote-run-dialog").showModal();
}

function syncBusyPresentation() {
  const layer = $("#busy-layer");
  const inline = $("#workflow-busy-inline");
  const backgroundExecution = busy && busySurface === "execute";
  const showInline = backgroundExecution && workspaceView === "mode" && appMode === "workflow" && activeProject()?.id === busyProjectId && Boolean(inline);
  layer.classList.toggle("hidden", !busy || backgroundExecution);
  layer.setAttribute("aria-hidden", String(!busy || backgroundExecution));
  if (inline) {
    inline.classList.toggle("hidden", !showInline);
    inline.setAttribute("aria-hidden", String(!showInline));
  }
  const status = runtimeStatus?.projectId === busyProjectId ? runtimeStatus : null;
  const activity = status?.activity || (busySurface === "execute" ? `${activeAgentLabel()} 正在执行当前子进程` : `${activeAgentLabel()} 正在处理`);
  const percent = Number.isFinite(status?.percent) ? Math.max(0, Math.min(100, status.percent)) : null;
  const inlineCopy = $("#workflow-busy-copy");
  if (inlineCopy) inlineCopy.textContent = `${activity}${percent != null ? ` · 本步骤 ${percent}%` : ""}`;
  if (busy && status) $("#busy-title").textContent = activity;
  const detail = $("#step-runtime-detail");
  const runningStepId = status?.stepId ?? activeProject()?.pendingAction?.stepId ?? null;
  const showDetail = Boolean(detail && busy && busySurface === "execute" && activeProject()?.id === busyProjectId && detail.dataset.stepId === runningStepId);
  if (detail) {
    detail.classList.toggle("hidden", !showDetail);
    detail.setAttribute("aria-hidden", String(!showDetail));
  }
  if (showDetail) {
    $("#step-runtime-activity").textContent = activity;
    $("#step-runtime-percent").textContent = percent == null ? "进行中 · 暂无可测百分比" : `${percent}%`;
    $("#step-runtime-progress").style.width = `${percent ?? 0}%`;
  }
  const lockOptions = busy && busySurface === "execute" && activeProject()?.id === busyProjectId;
  document.querySelectorAll('#workspace input[name="option"]').forEach((input) => {
    if (lockOptions && !input.disabled) {
      input.disabled = true;
      input.dataset.runtimeLocked = "true";
    } else if (!lockOptions && input.dataset.runtimeLocked === "true") {
      input.disabled = false;
      delete input.dataset.runtimeLocked;
    }
  });
}

function renderRuntimeFooter() {
  const project = activeProject();
  const status = project && runtimeStatus?.projectId === project.id ? runtimeStatus : null;
  const metrics = status?.metrics ?? null;
  const live = $("#runtime-footer .runtime-live");
  if (!live) return;
  live.classList.toggle("active", Boolean(status?.active));
  $("#runtime-activity").textContent = status?.activity ?? (project ? "等待自动执行" : "选择项目后显示运行状态");
  $("#runtime-step-percent").textContent = Number.isFinite(status?.percent)
    ? `本步骤 ${status.percent}%`
    : status?.active ? "本步骤进行中" : "—";
  $("#metric-cache-hit").textContent = Number.isFinite(metrics?.cacheHitRate) ? `${(metrics.cacheHitRate * 100).toFixed(1)}%` : "—";
  $("#metric-token-total").textContent = formatTokenCount(metrics?.cumulativeTokens);
  $("#metric-token-total").title = Number.isFinite(metrics?.cumulativeTokens) ? `${Math.round(metrics.cumulativeTokens).toLocaleString()} Token · ${metrics.source || "运行时"}` : "当前运行时尚未提供用量";
  $("#metric-context").textContent = Number.isFinite(metrics?.contextPercent)
    ? `${(metrics.contextPercent * 100).toFixed(1)}% · ${formatTokenCount(metrics.contextTokens)}/${formatTokenCount(metrics.contextWindow)}`
    : "—";
  $("#metric-remaining-label").textContent = metrics?.remainingLabel ?? (session?.state.settings.agentRuntime === "dsh" ? "DSH API 余额" : "Codex 额度剩余");
  $("#metric-remaining").textContent = metrics?.remainingText ?? (Number.isFinite(metrics?.remainingPercent) ? `${metrics.remainingPercent.toFixed(0)}%` : "—");
}

async function refreshRuntimeStatus(projectId, silent = true) {
  if (!projectId || runtimePollInFlight) return;
  runtimePollInFlight = true;
  try {
    const payload = await api(`/api/projects/${projectId}/runtime`);
    runtimeStatus = { ...payload.runtime, projectId };
    renderRuntimeFooter();
    syncBusyPresentation();
    if (recoveredExecutionProjectId === projectId && payload.runtime.active === false) {
      await synchronizeRecoveredExecution(projectId);
    }
  } catch (error) {
    if (!silent) showToast(error.message, true);
  } finally { runtimePollInFlight = false; }
}

async function synchronizeRecoveredExecution(projectId) {
  if (!projectId || recoveredExecutionProjectId !== projectId || recoveredExecutionSyncInFlight) return;
  recoveredExecutionSyncInFlight = true;
  try {
    const payload = await api("/api/bootstrap");
    const project = payload.state?.projects?.find((item) => item.id === projectId);
    if (!project || project.busy) return;
    recoveredExecutionProjectId = null;
    updateFromPayload(payload);
    setBusy(false, "执行已结束", projectId);
    if (["failed", "cancelled"].includes(project.pendingAction?.status)) {
      showToast(project.pendingAction.status === "cancelled" ? "执行已取消，已恢复最新状态。" : "执行未完成，已恢复错误状态。", project.pendingAction.status === "failed");
      return;
    }
    if (project.isPaused || project.phase === "complete") return;
    const reviewStep = project.steps.find((step) => step.status === "review");
    if (reviewStep && requiresMilestonePreview(reviewStep, resultForReview(reviewStep))) showAutomaticPreview(project, reviewStep);
    else queueAutomaticWorkflow(projectId);
  } catch (error) {
    showToast(`恢复执行结果失败：${error.message}`, true);
  } finally {
    recoveredExecutionSyncInFlight = false;
  }
}

function startRuntimePolling(projectId) {
  clearInterval(runtimePollTimer);
  refreshRuntimeStatus(projectId).catch(() => {});
  runtimePollTimer = setInterval(() => refreshRuntimeStatus(projectId).catch(() => {}), 650);
}

function stopRuntimePolling(projectId) {
  clearInterval(runtimePollTimer);
  runtimePollTimer = null;
  if (projectId) refreshRuntimeStatus(projectId).catch(() => {});
}

function setBusy(value, title = "正在处理", projectId = activeProject()?.id ?? null, surface = "global") {
  busy = value;
  busyProjectId = value ? projectId : null;
  busySurface = value ? surface : null;
  $("#busy-title").textContent = title;
  const project = session?.state.projects.find((item) => item.id === busyProjectId);
  $("#busy-context").textContent = project ? `“${project.title}”在后台运行，可继续浏览、学习或处理其他项目。` : "任务在后台运行，可以继续其他操作。";
  syncBusyPresentation();
  $("#app").setAttribute("aria-busy", "false");
  $("#pause-busy").classList.toggle("hidden", !busyProjectId);
  if (value && projectId) startRuntimePolling(projectId);
  else stopRuntimePolling(projectId);
}

function updateFromPayload(payload) {
  if (payload.state) session.state = payload.state;
  if (payload.installation) session.installation = payload.installation;
  render();
}

async function resynchronizeExecutionState(projectId) {
  const payload = await api("/api/bootstrap");
  updateFromPayload(payload);
  if (projectId) await refreshRuntimeStatus(projectId).catch(() => {});
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  try { localStorage.setItem("dshwf-sidebar-collapsed", sidebarCollapsed ? "1" : "0"); } catch {}
  renderSidebar();
}

function previewVersion(project) {
  if (!project?.artifact) return "";
  const substantialResults = (project.steps ?? []).filter((step) =>
    Array.isArray(step.result?.actualChanges) && step.result.actualChanges.some((item) => String(item).trim()) && requiresMilestonePreview(step, step.result)
  );
  if (!substantialResults.length) return "";
  const signature = substantialResults.map((step) => [
    step.id, step.revision ?? 1, step.result.summary ?? "", ...(step.result.actualChanges ?? []),
    step.result.artifact?.title ?? "", step.result.artifact?.filename ?? "", step.result.artifact?.kind ?? ""
  ].join("\u001f")).join("\u001e");
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function previewSeenVersion(projectId) {
  try { return localStorage.getItem(`dshwf-preview-seen:${projectId}`) ?? ""; } catch { return ""; }
}

function markPreviewSeen(project) {
  const version = previewVersion(project);
  if (!version) return;
  try { localStorage.setItem(`dshwf-preview-seen:${project.id}`, version); } catch {}
}

function reviewedSubprocess(step) {
  return (step?.subprocesses ?? []).find((item) => item.status === "review") ?? null;
}

function executableSubprocess(step) {
  return (step?.subprocesses ?? []).find((item) => item.status === "ready") ?? null;
}

function resultForReview(step) {
  return reviewedSubprocess(step)?.result ?? step?.result ?? null;
}

function requiresMilestonePreview(step, result) {
  if (!result?.artifact) return false;
  if (result.requiresPreview === true) return true;
  return result.requiresPreview == null && step?.kind === "deliver";
}

function hasBlockingVerification(step, result) {
  if (step?.kind !== "verify") return false;
  return result?.verificationPassed !== true || Boolean(result?.blockingIssues?.length);
}

function showAutomaticPreview(project, step) {
  const subprocess = reviewedSubprocess(step);
  previewGate = { projectId: project.id, stepId: step.id, subprocessId: subprocess?.id ?? null };
  selectedStepId = step.id;
  selectedSubprocessId = subprocess?.id ?? null;
  executionBlock = null;
  if (activeProject()?.id === project.id) {
    appMode = "workflow";
    workspaceView = "deliverable";
    render();
    showToast("检测到新预览：自动执行已暂停，等待检查或跳过。");
  }
}

function queueAutomaticWorkflow(projectId = activeProject()?.id) {
  if (!projectId || automaticRunProjectId === projectId) return;
  queueMicrotask(() => runAutomaticWorkflow(projectId).catch(async (error) => {
    await resynchronizeExecutionState(projectId).catch(() => {});
    showToast(error.message, true);
  }));
}

async function runAutomaticWorkflow(projectId) {
  if (!projectId || automaticRunProjectId) return;
  automaticRunProjectId = projectId;
  let calls = 0;
  try {
    while (calls < 100) {
      const project = session?.state.projects.find((item) => item.id === projectId);
      if (!project || project.isPaused || project.phase === "complete" || project.phase === "planning") return;

      if (project.executionMode === "adaptive-graph") {
        if (["awaiting_parallel_choice", "awaiting_direction", "failed"].includes(project.executionRun?.status)) return;
        calls += 1;
        setBusy(true, `正在执行：${project.title}`, project.id, "execute");
        try {
          updateFromPayload(await api(`/api/projects/${project.id}/run`, { method: "POST", body: JSON.stringify({ mode: "ask" }) }));
        } finally {
          setBusy(false);
        }
        continue;
      }

      if (project.executionMode === "continuous" && (!project.executionRun || project.executionRun.status === "cancelled")) {
        const risky = project.steps.find((step) => highRisk(step));
        if (risky) {
          selectedStepId = risky.id;
          selectedSubprocessId = null;
          if (activeProject()?.id === projectId) { workspaceView = "mode"; render(); }
          showToast(`“${risky.title}”需要明确风险确认，连续自动执行已暂停。`);
          return;
        }
        calls += 1;
        setBusy(true, `正在连续构建：${project.primaryArtifact?.filename || project.title}`, project.id, "execute");
        try {
          updateFromPayload(await api(`/api/projects/${project.id}/execute`, { method: "POST", body: JSON.stringify({ feedback: "" }) }));
        } finally {
          setBusy(false);
        }
        continue;
      }
      if (project.executionMode === "continuous" && project.executionRun?.status === "failed") return;

      const reviewStep = project.steps.find((step) => step.status === "review");
      if (reviewStep) {
        const result = resultForReview(reviewStep);
        if (hasBlockingVerification(reviewStep, result)) {
          selectedStepId = reviewStep.id;
          selectedSubprocessId = reviewedSubprocess(reviewStep)?.id ?? null;
          if (activeProject()?.id === projectId) { workspaceView = "mode"; render(); }
          showToast("验证结果需要处理，自动执行已暂停。", true);
          return;
        }
        if (requiresMilestonePreview(reviewStep, result)) {
          showAutomaticPreview(project, reviewStep);
          return;
        }
        const before = `${reviewStep.id}:${reviewedSubprocess(reviewStep)?.id ?? "step"}:${reviewStep.status}`;
        updateFromPayload(await api(`/api/projects/${project.id}/steps/${reviewStep.id}/approve`, { method: "POST", body: "{}" }));
        calls += 1;
        const refreshed = session.state.projects.find((item) => item.id === projectId)?.steps.find((item) => item.id === reviewStep.id);
        const after = `${refreshed?.id}:${reviewedSubprocess(refreshed)?.id ?? "step"}:${refreshed?.status}`;
        if (before === after) throw new Error("自动验收后状态没有前进，已停止以避免重复调用。");
        continue;
      }

      const step = project.steps.find((item) => ["ready", "stale"].includes(item.status));
      if (!step) return;
      const subprocess = executableSubprocess(step);
      selectedStepId = step.id;
      selectedSubprocessId = subprocess?.id ?? null;
      executionBlock = null;
      if (highRisk(step)) {
        if (activeProject()?.id === projectId) { workspaceView = "mode"; render(); }
        showToast(`“${step.title}”需要明确风险确认，自动执行已暂停。`);
        return;
      }

      const preflight = await api(`/api/projects/${project.id}/steps/${step.id}/execute/preflight`, { method: "POST", body: JSON.stringify({ subprocessId: subprocess?.id ?? null }) });
      if (!preflight.readiness.allowed) {
        executionBlock = preflight.readiness;
        if (activeProject()?.id === projectId) { workspaceView = "mode"; render(); }
        showToast(preflight.readiness.title, true);
        return;
      }

      calls += 1;
      setBusy(true, `正在执行：${step.title}${subprocess ? ` / ${subprocess.title}` : ""}`, project.id, "execute");
      try {
        updateFromPayload(await api(`/api/projects/${project.id}/steps/${step.id}/execute`, { method: "POST", body: JSON.stringify({ feedback: "", subprocessId: subprocess?.id ?? null }) }));
      } finally {
        setBusy(false);
      }
    }
    throw new Error("自动执行达到单轮 100 次安全上限，已暂停以避免意外循环。");
  } finally {
    automaticRunProjectId = null;
  }
}

const pinIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.5h6l-1.2 4 2.2 2.2v1H8.8V14l-.8 1-.8-1v-4.3H4v-1l2.2-2.2z"/></svg>`;

function projectProgressLabel(project) {
  if (project.isPaused) return "已暂停";
  if (project.phase === "complete") return "已完成";
  if (project.phase === "planning") return "规划中";
  return `${project.steps.filter((step) => step.status === "approved").length}/${project.steps.length || "待规划"}`;
}

function projectRow(project) {
  const title = project.title || "新需求";
  return `<div class="project-row ${project.pinnedAt ? "pinned" : ""}">
    <button class="project-button ${project.id === session.state.activeProjectId ? "active" : ""}" data-project="${escapeHTML(project.id)}" aria-current="${project.id === session.state.activeProjectId ? "page" : "false"}" title="${escapeHTML(title)}">
      <span class="project-avatar">${escapeHTML([...title][0] ?? "?")}</span>
      <span class="project-text"><strong>${escapeHTML(title)}</strong><span>${project.pinnedAt ? "已置顶 · " : ""}${escapeHTML(projectProgressLabel(project))}</span></span>
    </button>
    <span class="project-task-actions">
      <button class="pin-action ${project.pinnedAt ? "active" : ""}" aria-label="${project.pinnedAt ? "取消置顶" : "置顶"}：${escapeHTML(title)}" title="${project.pinnedAt ? "取消置顶" : "置顶"}" data-project-task-action="pin" data-project-id="${escapeHTML(project.id)}" data-pinned="${project.pinnedAt ? "true" : "false"}">${pinIcon}</button>
      <button class="archive-action" aria-label="归档：${escapeHTML(title)}" title="归档" data-project-task-action="archive" data-project-id="${escapeHTML(project.id)}"><span class="archive-box" aria-hidden="true"></span></button>
    </span>
  </div>`;
}

function archivedProjectRow(project) {
  const title = project.title || "未命名任务";
  const archivedAt = project.archivedAt ? new Date(project.archivedAt).toLocaleDateString() : "";
  return `<div class="archived-project-row">
    <span class="project-avatar">${escapeHTML([...title][0] ?? "?")}</span>
    <span class="archived-project-text"><strong title="${escapeHTML(title)}">${escapeHTML(title)}</strong><small>${escapeHTML(archivedAt ? `${archivedAt} 归档` : "已归档")}</small></span>
    <button class="restore-project" data-project-task-action="restore" data-project-id="${escapeHTML(project.id)}">恢复</button>
  </div>`;
}

function renderSidebar() {
  const projects = [...session.state.projects].sort((left, right) => {
    if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1;
    return left.pinnedAt && right.pinnedAt ? right.pinnedAt.localeCompare(left.pinnedAt) : 0;
  });
  const archivedProjects = [...session.state.archivedProjects].sort((left, right) => String(right.archivedAt ?? "").localeCompare(String(left.archivedAt ?? "")));
  $("#project-list").innerHTML = projects.length ? projects.map(projectRow).join("") : `<div class="muted small sidebar-empty">还没有工作项目</div>`;
  $("#archived-count").textContent = String(archivedProjects.length);
  $("#archived-project-list").innerHTML = archivedProjects.length ? archivedProjects.map(archivedProjectRow).join("") : `<div class="muted small sidebar-empty">还没有已归档任务</div>`;
  $("#open-settings").textContent = sidebarCollapsed ? "⚙" : "连接设置";
  $("#collapse-sidebar").textContent = sidebarCollapsed ? "»" : "« 折叠侧栏";
  $("#collapse-sidebar").title = sidebarCollapsed ? "展开侧栏" : "折叠侧栏";
  $("#collapse-sidebar").setAttribute("aria-expanded", String(!sidebarCollapsed));
  $("#local-state").innerHTML = `仅监听本机<br>${escapeHTML(session.runtime.address)}<br>状态保存在本机磁盘`;
  const project = activeProject();
  const version = previewVersion(project);
  const hasNewPreview = Boolean(version && previewSeenVersion(project.id) !== version);
  const previewToggle = $("#sidebar-preview-toggle");
  previewToggle.disabled = !project;
  previewToggle.classList.toggle("active", workspaceView === "deliverable");
  previewToggle.classList.toggle("has-update", hasNewPreview);
  previewToggle.setAttribute("aria-current", workspaceView === "deliverable" ? "page" : "false");
  previewToggle.setAttribute("aria-label", hasNewPreview ? "演示窗口，有新的预览可查看" : "演示窗口");
  previewToggle.title = hasNewPreview ? "有新的图形界面可查看" : "打开演示窗口";
  previewToggle.querySelector(".preview-notification").classList.toggle("hidden", !hasNewPreview);
}

function renderHarness() {
  const runtime = session.state.settings.agentRuntime === "codex" ? "codex" : "dsh";
  const active = session.installation?.[runtime];
  const detected = [session.installation?.dsh, session.installation?.codex].filter((agent) => agent?.found).length;
  const pill = $("#harness-pill");
  pill.className = `status-pill ${active?.found ? "ready" : "warning"}`;
  pill.textContent = active?.found ? `● ${runtime === "codex" ? "Codex" : "dsh"} 已选择` : `● ${runtime === "codex" ? "Codex" : "dsh"} 未检测到`;
  pill.title = `当前执行引擎：${runtime === "codex" ? "Codex App Server" : "DeepSeek Harness (dsh)"}；本机共检测到 ${detected}/2`;
}

function attachmentChips(items, removable = false) {
  if (!items?.length) return "";
  return `<div class="attachment-list">${items.map((item) => `<span class="attachment-chip">${item.kind === "image" ? `<img src="/api/attachments/${encodeURIComponent(item.id)}/content" alt="">` : `<span class="attachment-kind">${item.kind === "pdf" ? "PDF" : item.kind === "text" ? "TXT" : "FILE"}</span>`}<strong>${escapeHTML(item.name)}</strong><span>${formatBytes(item.byteCount)}</span>${item.kind === "text" && removable ? `<button data-restore-attachment="${item.id}" title="放回输入框并移除附件">↩</button>` : ""}${removable ? `<button data-remove-attachment="${item.id}" title="移除">×</button>` : ""}</span>`).join("")}</div>`;
}

function intakeTemplate(project = null) {
  const hasFixedGoal = Boolean(project?.goal);
  const fixedAttachments = project?.attachments ?? [];
  const draftAttachments = session.state.draftAttachments;
  return `<section class="intake"><div class="intake-card">
    <div class="eyebrow">START WITH AN OUTCOME</div>
    <h2>${project ? "确认目标并立即开始" : "今天想完成什么？"}</h2>
    <p>Harness 会先判断任务：简单任务在同一次调用中完成、审核并交付；复杂任务展示真实执行窗口，并按依赖自动推进。</p>
    ${project?.lastError ? `<div class="card error-card">上次规划失败：${escapeHTML(project.lastError)}${project.pendingAction?.type === "plan" ? `<div><button id="retry-plan" class="secondary compact">重新发送规划请求</button></div>` : ""}</div>` : ""}
    <textarea id="goal-input" class="goal-input" placeholder="描述目标、约束、已有材料和你最在意的结果……" ${hasFixedGoal ? "readonly" : ""}>${escapeHTML(project?.goal ?? "")}</textarea>
    ${attachmentChips(fixedAttachments)}${attachmentChips(draftAttachments, true)}${executionReferenceChips(project?.executionReferences, true)}
    <div class="intake-actions"><span class="safe-note">单文件 25 MiB · 单批 100 MiB · 全部保存在本机</span><div class="intake-action-group">
      <button id="attach-files" class="secondary">附件</button><button id="text-to-file" class="ghost">长文本转附件</button>
      <button id="submit-goal" class="primary">${project ? "开始执行" : "创建并执行"}</button>
    </div></div>
  </div></section>`;
}

function directiveChips(items) {
  return items?.length ? `<div class="directive-list">${items.map((item) => `<span class="directive-chip ${escapeHTML(item.strength)}">${escapeHTML(item.text)}</span>`).join("")}</div>` : "";
}

function visualReferenceUsage(project, referenceId) {
  const results = (project?.steps ?? []).flatMap((step) => [step.result, ...(step.subprocesses ?? []).map((item) => item.result)]).filter(Boolean).reverse();
  return results.flatMap((result) => result.visualReferencesUsed ?? []).find((usage) => usage.id === referenceId) ?? null;
}

function executionReferenceChips(items = [], removable = false) {
  const project = activeProject();
  return items.length ? `<div class="execution-references"><div class="small muted">跨模式执行参考</div>${items.map((item) => {
    const previewURL = safeWebURL(item.previewURL);
    const isVisual = item.visual?.mode === "metadata-only";
    const usage = isVisual ? visualReferenceUsage(project, item.id) : null;
    const status = usage ? "Agent 已回执使用" : isVisual ? "已转译 · 待执行回执" : "文本参考";
    const title = usage ? `${usage.appliedAs}\n证据：${usage.evidence}` : item.visual?.agentText || item.url || item.summary;
    return `<span class="execution-reference-chip ${isVisual ? "visual" : ""} ${usage ? "used" : ""}" draggable="true" data-transfer-reference="${encodedTransferReference(item)}" title="${escapeHTML(title)}">${previewURL ? `<img src="${escapeHTML(previewURL)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span class="execution-reference-copy"><span class="execution-reference-label">↗ ${escapeHTML(item.title)}</span><small>${escapeHTML(status)}</small></span>${removable ? `<button type="button" class="execution-reference-remove" draggable="false" data-remove-execution-reference="${escapeHTML(item.id)}" aria-label="移除执行参考：${escapeHTML(item.title)}" title="移除执行参考">×</button>` : ""}</span>`;
  }).join("")}</div>` : "";
}

function projectActions(project) {
  return `<div class="workflow-commandbar">
    <div class="workflow-state"><span class="status-dot ${project.isPaused ? "paused" : "active"}"></span><div><strong>${project.isPaused ? "任务已暂停" : "自动执行模式"}</strong><span>${project.isPaused ? "继续后从安全断点恢复" : "低风险步骤自动推进 · 有预览即暂停"}</span></div></div>
    <span class="automation-mode-label">自动执行</span>
    <button class="${project.isPaused ? "primary" : "secondary"}" data-project-action="${project.isPaused ? "resume" : "pause"}">${project.isPaused ? "▶ 继续任务" : "Ⅱ 暂停任务并交接"}</button>
    <details class="project-more"><summary aria-label="更多项目操作">•••</summary><div class="project-menu">
      <button class="ghost compact" data-project-action="checkpoint">创建检查点</button>
      <button class="ghost compact" data-project-action="checkpoints" ${project.checkpoints?.length ? "" : "disabled"}>回退到检查点（${project.checkpoints?.length ?? 0}）</button>
      ${project.handoff ? `<button class="ghost compact" data-project-action="handoff">查看交接</button>` : ""}
      <button class="ghost compact" data-project-action="rename">项目改名</button>
      <button class="ghost compact" data-project-action="workspace">工作目录</button>
      <button class="ghost compact" data-project-action="documents">项目规则</button>
      <button class="ghost compact" data-project-action="conversations">Agent 记录</button>
      <button class="ghost compact" data-project-action="reset">返回需求输入</button>
      <button class="danger compact" data-project-action="archive">归档项目</button>
    </div></details>
  </div>`;
}

function decisionLedger(project) {
  const entries = (project.decisionLog ?? []).slice(-8).reverse();
  return `<section class="card decision-ledger"><div class="card-header"><div><div class="eyebrow">DECISION LEDGER</div><h2>决策记录</h2></div><span class="ledger-clock">↻</span></div>
    <p class="small muted ledger-subtitle">方向不只存在于聊天上下文</p>
    <div class="ledger-list">${entries.length ? entries.map((entry) => `<article class="ledger-item"><span class="ledger-dot ${escapeHTML(entry.kind || "system")}"></span><div><strong>${escapeHTML(entry.title)}</strong><p>${escapeHTML(entry.detail)}</p><time>${entry.at ? escapeHTML(new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : ""}</time></div></article>`).join("") : `<p class="muted ledger-empty">还没有记录</p>`}</div>
  </section>`;
}

function subprocessRail(step, selected) {
  if (!step.subprocesses?.length) return "";
  return `<section class="subprocess-section"><div class="subprocess-heading"><div><span>STEP SUBPROCESSES</span><strong>本步骤子进程</strong></div><small>${step.subprocesses.filter((item) => item.status === "approved").length} / ${step.subprocesses.length} 已验收</small></div>
    <div class="subprocess-list">${step.subprocesses.map((item, index) => `<button class="subprocess-row ${escapeHTML(item.status)} ${item.id === selected?.id ? "selected" : ""}" data-subprocess="${escapeHTML(item.id)}" aria-pressed="${item.id === selected?.id}">
      <span class="subprocess-index">${String(index + 1).padStart(2, "0")}</span><span class="subprocess-copy"><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(item.purpose)}</small>${item.lastError ? `<em>${escapeHTML(item.lastError)}</em>` : ""}</span><span class="subprocess-status">${escapeHTML(subprocessStatus(item.status))}</span>
    </button>`).join("")}</div></section>`;
}

function debugConsoleTemplate(project, step) {
  if (!step) return "";
  const records = step.debugRecords ?? [];
  if (!records.some((item) => item.id === selectedDebugRecordId)) selectedDebugRecordId = records.at(-1)?.id ?? null;
  const record = records.find((item) => item.id === selectedDebugRecordId) ?? null;
  const process = record ? step.subprocesses?.find((item) => item.id === record.subprocessId) : null;
  const targetLabel = (item) => item.target?.label || item.target?.objectName || (item.element?.id ? `#${item.element.id}` : item.element?.tag) || "元素";
  const recordTabs = records.length ? `<div class="debug-record-tabs">${records.map((item, index) => `<button class="${item.id === record?.id ? "active" : ""}" data-debug-record="${escapeHTML(item.id)}">#${index + 1} · ${escapeHTML(targetLabel(item))}</button>`).join("")}</div>` : "";
  if (!record) return `<section class="card debug-console empty"><div class="debug-console-header"><div><div class="eyebrow">TRACE DEBUGGER</div><h2>调试台</h2></div><span class="badge">等待选中</span></div><div class="debug-empty"><strong>${previewTraceBusy ? "Agent 正在判断源码位置…" : "从预览直接回到当时的代码与步骤"}</strong><p>在演示窗口按住 ⌘/Ctrl 并左键点击界面元素。普通点击和拖动仍用于页面交互。LoopCanvas 优先按对象标识精确定位，缺少标识时才在当前产物范围内推断，并把记录归档到${project.executionMode === "continuous" ? "这个 Graph 检查点" : "这个步骤和子进程"}。</p></div></section>`;
  const appended = record.appendedRequirements?.length ? `<ul>${record.appendedRequirements.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>` : `<p class="muted">当时没有追加需求。</p>`;
  const logs = record.completionLogs?.length ? record.completionLogs.map((item) => `<li><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.detail)}</span></li>`).join("") : `<li><span>当时没有步骤日志。</span></li>`;
  const method = record.locationMethod || "inferred";
  const methodLabel = method === "exact" ? "精确定位" : method === "combined" ? "组合定位" : "推测定位";
  const confidence = Number.isFinite(record.confidence) ? `${Math.round(record.confidence * 100)}%` : "未评估";
  const evidence = record.locationEvidence?.length ? record.locationEvidence.join(" · ") : "旧记录未保存结构化证据";
  const snippetStart = Math.max(1, Number(record.source?.startLine) || 1);
  const snippetLines = String(record.source?.code || "").split("\n");
  const snippet = record.source?.code ? `<div class="debug-source-snippet" role="region" aria-label="命中的局部源码">${snippetLines.map((line, index) => `<div><span>${snippetStart + index}</span><code>${line ? escapeHTML(line) : "&nbsp;"}</code></div>`).join("")}</div>` : `<div class="debug-source-unavailable">这条旧记录没有保存局部源码，可以打开完整文件查看对应行。</div>`;
  return `<section class="card debug-console"><div class="debug-console-header"><div><div class="eyebrow">TRACE DEBUGGER · PERSISTED</div><h2>调试台</h2><p>${escapeHTML(step.title)}${process ? ` / ${escapeHTML(process.title)}` : ""}</p></div><span class="badge ${record.status === "feedback-recorded" ? "approved" : "review"}">${record.status === "feedback-recorded" ? "已记录意见" : "待反馈"}</span></div>
    ${recordTabs}<div class="debug-console-grid"><div class="debug-context-pane">
      <details open><summary>最开始要求</summary><p>${escapeHTML(record.initialRequirement)}</p></details>
      <details><summary>追加需求</summary>${appended}</details>
      <details open><summary>定位依据</summary><div class="debug-trace-status"><span class="trace-method ${escapeHTML(method)}">${methodLabel}</span><span>可信度 ${confidence}</span></div><p>${escapeHTML(record.agentDecisionSummary)}</p><p class="muted">证据：${escapeHTML(evidence)}</p><p class="muted">${escapeHTML(record.agentExecutionSummary)}</p></details>
      <details><summary>完成日志</summary><ul class="debug-log-list">${logs}</ul></details>
    </div><div class="debug-source-pane"><header><div><span>完成该界面组的代码</span><strong>${escapeHTML(record.source?.path || "未知文件")}</strong></div><small>L${record.source?.startLine ?? 1}–L${record.source?.endLine ?? 1}</small></header><div class="debug-source-route"><div><strong>命中片段</strong><p>这里只展示定位到的局部代码；修改意见仍会返回当前步骤处理。</p></div>${snippet}<button class="secondary compact" data-open-trace-source="${escapeHTML(record.id)}">显示全部代码</button></div>
      <label for="debug-feedback">修改意见</label><textarea id="debug-feedback" class="feedback" placeholder="描述这个界面元素需要怎样修改；提交后会返回对应检查点并自动执行修复。">${escapeHTML(record.feedback || "")}</textarea><div class="debug-feedback-actions"><span>${record.feedback ? `已持久化到${project.executionMode === "continuous" ? " Graph 检查点" : "步骤与子进程"}` : "提交后自动返修并再次等待预览"}</span><button id="submit-debug-feedback" class="primary" data-debug-record-id="${escapeHTML(record.id)}">提交并自动修改</button></div>
    </div></div></section>`;
}

function traceSourceDrawerTemplate(project) {
  if (!traceSourceDrawer.open) return "";
  const record = project.steps.flatMap((step) => step.debugRecords ?? []).find((item) => item.id === traceSourceDrawer.recordId);
  if (!record) return "";
  const startLine = Math.max(1, Number(record?.source?.startLine) || 1);
  const endLine = Math.max(startLine, Number(record?.source?.endLine) || startLine);
  const file = traceSourceDrawer.file;
  const body = traceSourceDrawer.loading
    ? `<div class="trace-drawer-state"><div class="mini-spinner"></div><strong>正在读取完整源码…</strong><span>只读打开，不会执行或修改文件。</span></div>`
    : traceSourceDrawer.error
      ? `<div class="trace-drawer-state error-card"><strong>无法打开完整源码</strong><span>${escapeHTML(traceSourceDrawer.error)}</span><button class="secondary compact" data-retry-trace-source>重试</button></div>`
      : file
        ? `<div class="trace-drawer-code" tabindex="0" aria-label="完整源码">${String(file.content ?? "").split("\n").map((line, index) => { const lineNumber = index + 1; const highlighted = lineNumber >= startLine && lineNumber <= endLine; return `<div class="${highlighted ? "highlighted" : ""}" data-trace-source-line="${lineNumber}"><span>${lineNumber}</span><code>${line ? escapeHTML(line) : "&nbsp;"}</code></div>`; }).join("")}</div>`
        : `<div class="trace-drawer-state"><strong>没有可显示的源码</strong></div>`;
  return `<div class="trace-source-drawer-layer" data-trace-drawer-backdrop><aside class="trace-source-drawer" role="dialog" aria-modal="true" aria-labelledby="trace-source-drawer-title"><header><div><span>完整源码 · 只读</span><strong id="trace-source-drawer-title">${escapeHTML(record?.source?.path || file?.path || "源码")}</strong><small>当前界面组：L${startLine}–L${endLine}</small></div><button class="ghost compact" data-close-trace-source aria-label="收起完整源码">收起</button></header>${body}</aside></div>`;
}

function planTemplate(project) {
  const steps = project.steps;
  if (!steps.some((step) => step.id === selectedStepId)) selectedStepId = project.selectedStepId ?? steps.find((step) => ["review", "ready", "stale", "running"].includes(step.status))?.id ?? steps[0]?.id ?? null;
  const selected = steps.find((step) => step.id === selectedStepId);
  const approved = steps.filter((step) => step.status === "approved").length;
  const allSubprocesses = steps.flatMap((step) => step.subprocesses ?? []);
  const approvedSubprocesses = allSubprocesses.filter((item) => item.status === "approved").length;
  const progress = allSubprocesses.length ? Math.round((approvedSubprocesses / allSubprocesses.length) * 100) : steps.length ? Math.round((approved / steps.length) * 100) : 0;
  const criteria = project.primaryArtifact?.acceptanceCriteria ?? [];
  const continuous = project.executionMode === "continuous";
  const adaptiveSingle = project.executionMode === "adaptive-single";
  const adaptiveGraph = project.executionMode === "adaptive-graph";
  return `<div class="workflow-stack">${projectActions(project)}
    <section class="card goal-overview"><div class="goal-main"><div class="eyebrow">CURRENT GOAL · 目标不会因局部返工而丢失</div><h2>${escapeHTML(project.goal || project.title)}</h2><p>${adaptiveSingle ? "Harness 判断可一步完成，已在同一次调用中实现、验证并交付。" : adaptiveGraph ? "这些窗口来自 Harness 实际执行节点；LoopCanvas 只负责依赖、暂停、并行选择和回退。" : continuous ? "同一个 Agent 会在固定项目目录中连续构建；Graph 节点只记录可追溯检查点。" : "这个历史项目保留逐步执行模式。"}</p><p class="small muted">项目目录：${escapeHTML(project.workspace || "待创建")}<br>主交付物：${escapeHTML(project.primaryArtifact?.filename || "由 Harness 判断")}${project.primaryArtifact?.entrypoint ? ` · 入口 ${escapeHTML(project.primaryArtifact.entrypoint)}` : ""}</p>${criteria.length ? `<details><summary>主交付物验收条件</summary>${listTemplate(criteria)}</details>` : ""}${directiveChips(project.directives)}${attachmentChips(project.attachments)}${executionReferenceChips(project.executionReferences)}</div>
      <div class="goal-progress"><div><span>总体进度</span><strong>${adaptiveSingle ? "已交付" : allSubprocesses.length ? `${approvedSubprocesses} / ${allSubprocesses.length} 子进程` : `${approved} / ${steps.length} 节点`}</strong></div><div class="progress-track"><i style="width:${progress}%"></i></div><div id="workflow-busy-inline" class="workflow-busy-inline hidden" role="status" aria-live="polite" aria-atomic="true" aria-hidden="true"><span class="spinner" aria-hidden="true"></span><strong id="workflow-busy-copy">正在执行</strong><button id="pause-inline-busy" class="danger compact">暂停</button></div><span>${escapeHTML(adaptiveSingle ? "一步直达" : selected?.title || "等待执行")}</span></div></section>
    ${project.isPaused ? `<section class="pause-banner"><span>Ⅱ</span><div><strong>任务已暂停</strong><p>活动 Agent 调用已取消。点击上方“继续任务”后会从当前安全断点恢复自动执行。</p></div></section>` : ""}
    ${project.lastError && !project.isPaused ? `<section class="card error-card">${escapeHTML(project.lastError)}${adaptiveGraph ? `<div class="action-row"><button data-adaptive-run="sequential" class="secondary compact">从失败节点继续</button></div>` : project.executionRun?.status === "failed" ? `<div class="action-row"><button id="recover-project-execution" class="primary compact">恢复已生成结果</button><button id="retry-project-execution" class="secondary compact">重新运行 Agent</button></div>` : ""}</section>` : ""}
    ${adaptiveGraph ? adaptiveGraphTemplate(project, steps) : adaptiveSingle ? "" : `<section class="card route-card"><div class="card-header"><div><div class="eyebrow">CHECKPOINT GRAPH</div><h2>成果路线</h2><p class="small muted">链条表示成果依赖；节点记录同一次连续执行中的上下文、修改和验证证据。</p></div><span class="muted small">${approved} / ${steps.length} 已验收</span></div>
      <div class="plan-rail">${steps.map((step, index) => `<div class="step-row ${escapeHTML(step.status)} ${step.id === selectedStepId ? "selected" : ""}" data-step="${escapeHTML(step.id)}">
        <div class="step-card-top"><span class="step-number">${String(index + 1).padStart(2, "0")}</span><span class="badge ${escapeHTML(step.status)}">${escapeHTML(stepStatus(step.status))}</span></div>
        <div class="step-title"><strong>${escapeHTML(step.title)}</strong><span>${escapeHTML(step.purpose)}</span></div>
        <div class="step-card-footer">${highRisk(step) ? `<span class="badge risk-high">${step.riskLevel}</span>` : `<span class="small muted">${step.subprocesses?.length ? `${step.subprocesses.filter((item) => item.status === "approved").length}/${step.subprocesses.length} 子进程` : escapeHTML(step.kind || "step")}</span>`}<div class="step-controls"><button aria-label="上移" data-move-step="${step.id}" data-direction="up" ${index === 0 ? "disabled" : ""}>←</button><button aria-label="下移" data-move-step="${step.id}" data-direction="down" ${index === steps.length - 1 ? "disabled" : ""}>→</button></div></div>
      </div>`).join("")}</div></section>`}
    ${adaptiveSingle || adaptiveGraph ? "" : `<div class="workflow-detail-grid"><div class="inspector-column">${stepInspector(project, selected)}</div>${decisionLedger(project)}</div>`}
    ${debugConsoleTemplate(project, selected)}
    ${artifactTemplate(project)}
    ${traceSourceDrawerTemplate(project)}
  </div>`;
}

function cautionLabel(level) { return ({ low: "快速", medium: "标准", high: "谨慎" })[level] ?? "继承全局"; }

function directionDraftKey(projectId, stepId) { return `${projectId}:${stepId}`; }

function directionDraftFor(project, step) {
  const key = directionDraftKey(project.id, step.id);
  if (!directionDrafts.has(key)) directionDrafts.set(key, {
    optionId: step.selectedDirectionOptionId ?? "",
    supplemental: step.directionSupplement ?? "",
    answer: ""
  });
  return directionDrafts.get(key);
}

function directionRequestTemplate(project, step) {
  const draft = directionDraftFor(project, step);
  const options = step.directionOptions ?? [];
  if (!options.length) return `<div class="direction-request legacy-direction"><strong>${escapeHTML(step.directionQuestion)}</strong><label class="direction-supplement"><span>执行方向</span><textarea data-direction-answer="${escapeHTML(step.id)}" placeholder="明确回复执行方向">${escapeHTML(draft.answer)}</textarea></label><button data-submit-direction="${escapeHTML(step.id)}" class="primary compact">确认方向并继续</button></div>`;
  return `<div class="direction-request"><fieldset><legend>${escapeHTML(step.directionQuestion)}</legend><div class="direction-option-list">${options.map((option) => `<label class="direction-option"><input type="radio" name="direction-${escapeHTML(step.id)}" value="${escapeHTML(option.id)}" data-direction-option="${escapeHTML(step.id)}" ${draft.optionId === option.id ? "checked" : ""}><span><strong>${escapeHTML(option.label)}</strong>${option.description ? `<small>${escapeHTML(option.description)}</small>` : ""}</span></label>`).join("")}</div></fieldset><label class="direction-supplement"><span>额外补充 <small>可选</small></span><textarea data-direction-supplement="${escapeHTML(step.id)}" placeholder="如有额外边界、偏好或注意事项，可在这里补充">${escapeHTML(draft.supplemental)}</textarea></label><button data-submit-direction="${escapeHTML(step.id)}" class="primary compact" ${draft.optionId ? "" : "disabled"}>按此方向继续</button></div>`;
}

function adaptiveGraphTemplate(project, steps) {
  const awaiting = new Set(project.executionRun?.awaitingStepIds ?? []);
  const status = project.executionRun?.status;
  const banner = status === "awaiting_parallel_choice"
    ? `<div class="execution-choice" role="status"><div><strong>这些节点可以并行</strong><p>${steps.filter((step) => awaiting.has(step.id)).map((step) => escapeHTML(step.title)).join("、")} 的依赖已满足，写入范围未发现冲突。</p></div><div class="action-row"><button data-adaptive-run="parallel" class="primary">并行开始</button><button data-adaptive-run="sequential" class="secondary">依次执行</button></div></div>`
    : status === "awaiting_direction" ? `<div class="execution-choice warning" role="status"><div><strong>需要你确认目标方向</strong><p>相关节点已暂停；答复后才会继续。</p></div></div>` : "";
  return `<section class="card adaptive-graph"><div class="card-header"><div><div class="eyebrow">HARNESS EXECUTION WINDOWS</div><h2>实际执行窗口</h2><p class="small muted">没有人为方案选择；依赖满足后自动执行，可安全并行时由你决定。</p></div><span class="muted small">${steps.filter((step) => step.status === "approved").length} / ${steps.length} 完成</span></div>${banner}
    <div class="execution-window-grid">${steps.map((step) => {
      const dependencies = (step.dependencies ?? []).map((id) => steps.find((item) => item.id === id)?.title ?? id);
      const needsDirection = step.requiresUserDirection && !step.directionAnswer;
      const level = step.cautionLevel ?? session.state.settings.cautionLevel ?? "medium";
      const actuallyRunning = step.status === "running" && project.busy === true && runtimeStatus?.active === true && runtimeStatus?.stepId === step.id;
      const displayStatus = step.status === "running" && !actuallyRunning ? "ready" : step.status;
      const interrupted = step.status === "running" && !actuallyRunning;
      return `<article class="execution-node-window ${escapeHTML(displayStatus)} ${step.id === selectedStepId ? "selected" : ""}" data-step="${escapeHTML(step.id)}">
        <header><div><span>${escapeHTML(step.kind || "node")} · REV ${step.revision ?? 1}</span><h3>${escapeHTML(step.title)}</h3></div><span class="badge ${escapeHTML(displayStatus)}">${escapeHTML(stepStatus(displayStatus))}</span></header>
        <p>${escapeHTML(step.purpose)}</p>
        <dl class="node-meta"><div><dt>依赖</dt><dd>${escapeHTML(dependencies.join("、") || "无")}</dd></div><div><dt>并行</dt><dd>${step.parallelSafe ? "可并行" : "保持串行"}</dd></div><div><dt>写入范围</dt><dd>${escapeHTML((step.writeScope ?? []).join("、") || "只读或未声明")}</dd></div></dl>
        <label class="node-caution">谨慎等级<select data-step-caution="${escapeHTML(step.id)}"><option value="inherit" ${step.cautionLevel ? "" : "selected"}>继承全局（${escapeHTML(cautionLabel(session.state.settings.cautionLevel))}）</option><option value="low" ${step.cautionLevel === "low" ? "selected" : ""}>快速</option><option value="medium" ${step.cautionLevel === "medium" ? "selected" : ""}>标准</option><option value="high" ${step.cautionLevel === "high" ? "selected" : ""}>谨慎</option></select></label>
        ${needsDirection ? directionRequestTemplate(project, step) : step.directionAnswer ? `<div class="direction-answer"><span>已确认方向</span><p>${escapeHTML(step.directionAnswer)}</p></div>` : ""}
        ${actuallyRunning ? `<div class="node-running"><span class="spinner" aria-hidden="true"></span><strong>${escapeHTML(runtimeStatus.activity)}</strong></div>` : ""}
        ${interrupted ? `<div class="node-error" role="status"><strong>上次执行已中断</strong><p>服务端没有检测到这个节点的活动 Agent 调用，可以重新执行。</p></div>` : ""}
        ${step.status === "error" ? `<div class="node-error" role="alert"><strong>节点执行失败</strong><p>${escapeHTML(step.lastError || project.lastError || "Agent 没有返回可用结果。")}</p></div>` : ""}
        ${displayStatus === "error" ? `<div class="node-execution-actions"><button data-adaptive-run="sequential" data-adaptive-run-step="${escapeHTML(step.id)}" class="secondary compact">重试此节点</button><button data-adaptive-rollback="${escapeHTML(step.id)}" class="ghost compact">${step.requiresUserDirection ? "重新选择方向" : "回退节点状态"}</button></div>` : displayStatus === "ready" && !needsDirection ? `<div class="node-execution-actions"><button data-adaptive-run="sequential" data-adaptive-run-step="${escapeHTML(step.id)}" class="primary compact">执行此节点</button></div>` : ""}
        ${step.result ? `<div class="node-result"><strong>${step.status === "error" ? "Agent 返回的失败结果：" : ""}${escapeHTML(step.result.summary)}</strong><details ${step.status === "error" ? "open" : ""}><summary>证据、阻断问题与回滚</summary>${resultDetails(step.result)}</details></div>` : ""}
        <footer><span>${escapeHTML(cautionLabel(level))}</span>${["approved", "stale"].includes(displayStatus) ? `<button data-adaptive-rollback="${escapeHTML(step.id)}" class="ghost compact">回退节点状态</button>` : ""}</footer>
      </article>`;
    }).join("")}</div></section>`;
}

function riskCard(step) {
  if (!highRisk(step)) return "";
  const impact = step.impactAnalysis ?? {};
  return `<div class="risk-card"><strong>${escapeHTML(step.riskLevel)} 高风险行为卡</strong><p>${escapeHTML(impact.surfaceProblem || step.purpose)}</p>
    <p>影响模块：${escapeHTML((impact.affectedModules ?? []).join("、") || "未明确")}<br>范围：${escapeHTML(impact.scope || "implement")} · 主流程变化：${impact.requiresMainFlowChange ? "是" : "否"}</p>
    <label class="risk-consent"><input id="risk-consent" type="checkbox">我已阅读影响范围，并同意执行这一具体步骤。</label></div>`;
}

function stepInspector(project, step) {
  if (!step) return `<section class="card"><p class="muted">选择一个步骤查看详情。</p></section>`;
  const stepAllowsOptionSelection = !["running", "approved"].includes(step.status) && !project.isPaused;
  if (step.subprocesses?.length && !step.subprocesses.some((item) => item.id === selectedSubprocessId)) selectedSubprocessId = step.selectedSubprocessId ?? step.subprocesses.find((item) => ["review", "ready", "error"].includes(item.status))?.id ?? step.subprocesses[0].id;
  const subprocess = step.subprocesses?.find((item) => item.id === selectedSubprocessId) ?? null;
  const optionOwner = subprocess ?? step;
  const activeOptions = Array.isArray(optionOwner.options) ? optionOwner.options : [];
  const activeSelectedOptionId = optionOwner.selectedOptionId ?? null;
  const canSelect = stepAllowsOptionSelection && !["running", "review", "approved"].includes(optionOwner.status);
  const awaitingContinuousRun = project.executionMode === "continuous" && project.primaryArtifact && !project.artifact;
  const canRequestExecution = !awaitingContinuousRun && (subprocess
    ? !["running", "review", "approved"].includes(subprocess.status)
    : !["running", "review", "approved"].includes(step.status));
  const activeBlock = executionBlock?.stepId === step.id && executionBlock.subprocessId === (subprocess?.id ?? null) ? executionBlock : null;
  const displayResult = subprocess ? subprocess.result : step.result;
  const displayStatus = subprocess?.status ?? step.status;
  const displayedOption = displayResult?.selectedOptionId ? activeOptions.find((option) => option.id === displayResult.selectedOptionId) : null;
  const runningPercent = runtimeStatus?.projectId === project.id && runtimeStatus?.stepId === step.id && Number.isFinite(runtimeStatus.percent)
    ? Math.max(0, Math.min(100, runtimeStatus.percent)) : null;
  const appliedDirectives = project.directives.filter((directive) => (step.appliedDirectiveIDs ?? []).includes(directive.id));
  return `<section class="card"><div class="card-header"><div><div class="eyebrow">CURRENT STEP · ${escapeHTML(step.kind)} · REV ${step.revision ?? 1}</div><h2>${escapeHTML(step.title)}</h2></div><span class="badge ${escapeHTML(step.status)}">${escapeHTML(stepStatus(step.status))}</span></div>
    <p class="muted">${escapeHTML(step.purpose)}</p>${subprocessRail(step, subprocess)}${appliedDirectives.length ? `<div class="small muted">本步骤落实约束</div>${directiveChips(appliedDirectives)}` : ""}${step.lastFeedback ? `<div class="card error-card small">上次反馈：${escapeHTML(step.lastFeedback)}</div>` : ""}
    ${step.dependencies.length ? `<p class="small muted">前置步骤：${step.dependencies.length} 个</p>` : ""}
    <div class="option-scope"><div><span>${subprocess ? "SUBPROCESS OPTIONS" : "STEP OPTIONS"}</span><strong>${escapeHTML(subprocess?.title ?? step.title)}</strong></div><small>${subprocess ? "仅影响当前子进程" : "仅影响当前步骤"}</small></div>
    ${activeOptions.length ? `<div class="option-list">${activeOptions.map((option) => `<label class="option ${option.id === activeSelectedOptionId ? "selected" : ""}"><div class="option-head"><input type="radio" name="option" data-subprocess-id="${escapeHTML(subprocess?.id ?? "")}" value="${escapeHTML(option.id)}" ${option.id === activeSelectedOptionId ? "checked" : ""} ${canSelect ? "" : "disabled"}><strong>${escapeHTML(option.title)}</strong>${option.origin === "userExplicit" ? `<span class="option-origin">用户明确</span>` : option.origin === "userInferred" ? `<span class="option-origin">用户推断</span>` : ""}${option.isRecommended ? `<span class="recommend">推荐</span>` : ""}</div><p>${escapeHTML(option.subtitle || option.technicalReason)}</p><details><summary>方案依据与取舍</summary><div class="option-details"><strong>技术理由</strong><p>${escapeHTML(option.technicalReason || "未提供")}</p><strong>优点</strong>${listTemplate(option.advantages)}<strong>取舍</strong>${listTemplate(option.tradeoffs)}<strong>后续影响</strong><p>${escapeHTML(option.downstreamImpact || "未提供")}</p>${option.rankReason ? `<strong>排序依据</strong><p>${escapeHTML(option.rankReason)}</p>` : ""}</div></details></label>`).join("")}</div>` : `<div class="option-migration-warning" role="status"><strong>${subprocess ? "旧计划缺少这个子进程的独立方案" : "当前步骤没有可用方案"}</strong><p>${subprocess ? "为避免误用其他子进程的方案，这里不再显示大步骤旧选项。可从项目菜单返回需求输入后重新生成路线；返回前会自动创建检查点。" : "请重新生成执行路线。"}</p></div>`}
    ${step.status === "locked" ? `<p class="muted small">内容已开放浏览；点击执行时会检查前置步骤与子进程。</p>` : ""}${step.status === "stale" ? `<div class="card error-card small">上游发生变化，本步骤需要重新执行或复核。</div>` : ""}
    ${awaitingContinuousRun ? project.executionRun?.status === "failed"
      ? `<div class="pending-action"><strong>已生成文件，但尚未登记主交付物</strong><div class="small muted">${escapeHTML(project.lastError || "上次连续构建失败。")}</div></div><button id="recover-project-execution-inline" class="primary wide">恢复并检查已生成结果</button><button id="retry-project-execution-inline" class="secondary wide">重新运行 Agent</button><p class="execution-preflight-note">恢复会重新校验已保存结果，不调用 Agent；仅在没有可恢复结果时才需要重新运行。</p>`
      : `<p class="execution-preflight-note">首次构建会由一个 Agent 连续完成全部检查点；完成后可从这里重新打开并定点修改。</p>`
      : canRequestExecution && !project.isPaused ? `${riskCard(step)}${project.pendingAction?.type === "execute" && project.pendingAction.stepId === step.id && (!subprocess || project.pendingAction.subprocessId === subprocess.id) ? `<div class="pending-action">上次请求${project.pendingAction.status === "cancelled" ? "已取消" : "失败"}，内容已保留，不会自动重复计费。${project.pendingAction.status === "failed" && project.pendingAction.error ? `<div class="small muted">重试会自动附带此纠错原因：${escapeHTML(project.pendingAction.error)}</div>` : ""}</div>` : ""}<textarea id="execute-feedback" class="feedback" placeholder="可选：补充这个检查点的具体要求或纠正意见">${escapeHTML(project.pendingAction?.type === "execute" && project.pendingAction.stepId === step.id && (!subprocess || project.pendingAction.subprocessId === subprocess.id) ? project.pendingAction.feedback : subprocess?.lastFeedback ?? "")}</textarea><button id="execute-step" class="primary wide">${highRisk(step) ? `确认后执行：${escapeHTML(subprocess?.title || step.title)}` : `定点修改：${escapeHTML(subprocess?.title || step.title)}`}</button><p class="execution-preflight-note">这会从当前 Graph 检查点修改，并继续维护同一个主交付物。</p>${activeBlock ? `<div class="execution-block" role="alert"><strong>${escapeHTML(activeBlock.title)}</strong>${listTemplate(activeBlock.reasons)}</div>` : ""}` : ""}
    ${project.isPaused ? `<p class="muted">任务已暂停，继续后才能执行。</p>` : ""}<div id="step-runtime-detail" class="step-runtime-detail ${step.status === "running" ? "" : "hidden"}" data-step-id="${escapeHTML(step.id)}" role="status" aria-live="polite" aria-atomic="true" aria-hidden="${step.status === "running" ? "false" : "true"}"><header><div><span>RUNNING NOW · 当前执行</span><strong>${escapeHTML(step.title)}${subprocess ? ` / ${escapeHTML(subprocess.title)}` : ""}</strong></div><strong id="step-runtime-percent">${runningPercent == null ? "等待可测进度" : `${runningPercent}%`}</strong></header><div class="step-runtime-activity"><span class="spinner" aria-hidden="true"></span><div><span>实时活动</span><strong id="step-runtime-activity">${escapeHTML(runtimeStatus?.activity || `${activeAgentLabel()} 正在执行当前子进程`)}</strong></div></div><div class="step-runtime-track" aria-hidden="true"><i id="step-runtime-progress" style="width:${runningPercent ?? 0}%"></i></div><div class="step-runtime-choice"><span>执行方案</span><strong>${escapeHTML(activeOptions.find((option) => option.id === activeSelectedOptionId)?.title || "等待确认")}</strong></div></div>
    ${displayResult ? resultTemplate({ ...step, status: displayStatus, result: displayResult }, { subprocessTitle: subprocess?.title ?? "", optionTitle: displayedOption?.title ?? "" }) : ""}${step.status === "approved" ? `<div class="action-row"><button id="reopen-step" class="secondary">重新打开并修改</button><button id="rollback-step" class="danger">回退本步</button></div>` : ""}
  </section>`;
}

function listTemplate(items) { return items?.length ? `<ul>${items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>` : `<p class="muted">未提供</p>`; }
function resultDetails(result) { return `<h4>实际改变</h4>${listTemplate(result.actualChanges)}<h4>验证证据</h4>${listTemplate(result.evidence)}${result.blockingIssues?.length ? `<h4>阻断问题</h4>${listTemplate(result.blockingIssues)}` : ""}<h4>偏差与回滚</h4><p>${escapeHTML(result.deviation)}\n${escapeHTML(result.rollback)}</p>`; }

function resultTemplate(step, { subprocessTitle = "", optionTitle = "" } = {}) {
  const result = step.result;
  const review = step.status === "review";
  const verificationFailed = step.kind === "verify" && (result.verificationPassed !== true || result.blockingIssues?.length);
  const executionMeta = optionTitle ? `<div class="result-execution-meta"><span>实际执行方案</span><strong>${escapeHTML(optionTitle)}</strong>${subprocessTitle ? `<small>${escapeHTML(subprocessTitle)}</small>` : ""}</div>` : "";
  const content = highRisk(step)
    ? `<div class="result-block risk-card"><strong>${step.riskLevel} 高风险结果卡</strong>${executionMeta}<h4>结果摘要</h4><p>${escapeHTML(result.summary)}</p>${resultDetails(result)}</div>`
    : `<div class="compact-result">${executionMeta}<strong>结果摘要</strong><p>${escapeHTML(result.summary)}</p><details><summary>查看执行详情</summary><div class="result-block">${resultDetails(result)}</div></details></div>`;
  if (!review) return content;
  return `${content}<textarea id="reject-feedback" class="feedback" placeholder="若不通过，请写明需要修改的地方"></textarea><div class="action-row">
    ${verificationFailed ? `<button id="return-to-repair" class="danger">验证不通过，返回修复</button><button id="rerun-step" class="secondary">重新运行检查</button>` : `<button id="approve-step" class="primary">${step.kind === "verify" ? "验证成功并继续" : "接受并继续"}</button><button id="reject-step" class="danger">要求修改</button>`}
    <button id="rollback-step" class="ghost">回退本步</button></div>`;
}

function artifactTemplate(project) {
  const artifact = project.artifact;
  if (!artifact) return "";
  const runtime = [artifact.entrypoint ? `入口：${artifact.entrypoint}` : "", artifact.dependencies?.length ? `依赖：${artifact.dependencies.join("；")}` : "", artifact.runCommands?.length ? `运行：${artifact.runCommands.join("；")}` : "", artifact.testCommands?.length ? `测试：${artifact.testCommands.join("；")}` : "", artifact.testResults?.length ? `结果：${artifact.testResults.join("；")}` : ""].filter(Boolean);
  return `<section class="card" draggable="true" data-transfer-reference="${encodedTransferReference({ type: "artifact", title: artifact.title, summary: [artifact.filename, artifact.content || "", ...runtime].filter(Boolean).join("\n"), origin: "workflow" })}"><div class="card-header"><div><div class="eyebrow">LATEST ARTIFACT · 可拖到学习或探索</div><h2>${escapeHTML(artifact.title)}</h2></div><span class="badge">${escapeHTML(artifact.kind)}</span></div><p class="small muted">${escapeHTML(artifact.projectRoot || "内联产物")} · ${escapeHTML(artifact.filename)}</p>${artifact.files?.length ? `<p class="small muted">${artifact.files.length} 个文件</p>` : ""}${runtime.length ? `<details class="artifact-runtime"><summary>入口、依赖与运行信息</summary><pre>${escapeHTML(runtime.join("\n"))}</pre></details>` : ""}<div class="artifact-preview-location"><span>在演示窗口中检查当前图形界面</span><div><button id="open-artifact-preview" class="secondary compact">打开演示窗口</button><button id="view-artifact-source" class="ghost compact">查看源码</button></div></div></section>`;
}

function artifactReadingPreview(artifact) {
  const content = String(artifact.content || "产物保存在本机目录；Agent 未返回内联内容。");
  if (artifact.kind !== "markdown") return `<div class="deliverable-reader deliverable-plain-text">${escapeHTML(content)}</div>`;
  return `<article class="deliverable-reader deliverable-markdown">${content.split(/\r?\n/).map((line) => {
    const escaped = escapeHTML(line).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
    if (/^###\s+/.test(line)) return `<h3>${escaped.replace(/^###\s+/, "")}</h3>`;
    if (/^##\s+/.test(line)) return `<h2>${escaped.replace(/^##\s+/, "")}</h2>`;
    if (/^#\s+/.test(line)) return `<h1>${escaped.replace(/^#\s+/, "")}</h1>`;
    if (/^[-*]\s+/.test(line)) return `<p class="deliverable-list-item">${escaped.replace(/^[-*]\s+/, "")}</p>`;
    return line.trim() ? `<p>${escaped}</p>` : `<div class="deliverable-reading-gap" aria-hidden="true"></div>`;
  }).join("")}</article>`;
}

function deliverableTemplate(project) {
  if (!project) return "";
  const artifact = project.artifact;
  const ready = project.phase === "complete" || Boolean(project.steps?.length && project.steps.every((step) => step.status === "approved"));
  const status = artifact ? (ready ? "可交付" : "制作中") : "等待产物";
  const gated = Boolean(artifact && previewGate?.projectId === project.id);
  const gate = gated ? `<div class="preview-gate" role="status"><div class="preview-gate-copy"><strong>自动执行已暂停，等待你检查预览</strong><span>${artifact.kind === "html" ? `按住 <span class="preview-key">⌘</span>/Ctrl 并左键点击元素，可锁定对应代码；普通拖动仍用于操作预览。` : "检查当前产物后，可跳过预览并继续自动执行。"}</span></div><div class="preview-gate-actions"><button id="skip-preview" class="primary compact">跳过预览并继续</button></div></div>` : "";
  const body = !artifact
    ? `<div class="deliverable-empty"><div class="deliverable-empty-mark" aria-hidden="true"></div><h2>还没有可演示产物</h2><p>完成包含实质改变的制作步骤后，图形界面会在这里出现。</p></div>`
    : `<div class="deliverable-artifact-bar"><div><strong>${escapeHTML(artifact.title || artifact.filename || "当前产物")}</strong><span>${escapeHTML(String(artifact.kind || "file").toUpperCase())} · ${escapeHTML(artifact.filename || "内联产物")}</span></div><div class="deliverable-actions">${artifact.kind === "html" ? `<button id="refresh-preview" class="secondary compact">刷新界面</button>` : ""}<button id="view-artifact-source" class="ghost compact">查看源码</button></div></div>
      <div class="deliverable-preview-stage">${artifact.kind === "html"
        ? `<iframe id="artifact-preview" class="deliverable-artifact-frame" sandbox="allow-scripts" src="/preview/${encodeURIComponent(project.id)}/" title="${escapeHTML(artifact.title || "图形界面预览")}"></iframe>`
        : artifactReadingPreview(artifact)}</div>`;
  return `<section class="deliverable-window"><header class="deliverable-window-header"><div class="deliverable-window-heading"><button id="return-from-preview" class="deliverable-exit ghost compact" aria-label="退出演示窗口并返回执行"><span aria-hidden="true">←</span><span class="deliverable-exit-label">退出</span></button><span class="deliverable-window-icon" aria-hidden="true"></span><div><div class="eyebrow">DELIVERABLE PREVIEW</div><h2>演示窗口</h2><p>${artifact ? "当前步骤累积出的最新可交付版本" : "制作步骤返回产物后会在这里更新"}</p></div></div><div class="deliverable-window-controls"><span class="deliverable-status ${ready ? "ready" : ""}">${gated ? "自动执行已暂停" : status}</span></div></header>${gate}${body}</section>`;
}

const learningModules = [
  ["explanation", "源码解释"], ["data-structure", "数据结构"], ["syntax", "语法"], ["flow", "运行流程"]
];

function learningMessageTemplate(message, thread = null) {
  const details = message.details ?? {};
  return `<article class="mode-message ${escapeHTML(message.role)}"><strong>${message.role === "assistant" ? "DeepSeek 导师" : "你"}</strong><p>${escapeHTML(message.text)}</p>
    ${details.keyPoints?.length ? `<details><summary>关键点</summary>${listTemplate(details.keyPoints)}</details>` : ""}
    ${details.concepts?.length ? `<div class="concept-list">${details.concepts.map((item) => `<span>${escapeHTML(item)}</span>`).join("")}</div>` : ""}
    ${thread && details.codeReferences?.length ? `<div class="message-code-references">${details.codeReferences.map((reference) => `<button class="ghost compact" data-jump-learning-code="${escapeHTML(thread.id)}" data-start-line="${reference.startLine}" data-end-line="${reference.endLine}">↗ ${escapeHTML(reference.label)} · L${reference.startLine}–L${reference.endLine}</button>`).join("")}</div>` : ""}
  </article>`;
}

function learningPopupTemplate() {
  const popup = learningUI.popup;
  if (!popup) return "";
  const popupWidth = Math.min(520, Math.max(360, window.innerWidth * .3), window.innerWidth - 32);
  const popupHeight = Math.min(460, window.innerHeight - 32);
  const style = `left:${Math.max(16, Math.min(popup.x, window.innerWidth - popupWidth - 16))}px;top:${Math.max(90, Math.min(popup.y, window.innerHeight - popupHeight - 16))}px`;
  if (popup.loading) return `<aside class="learning-popup" style="${style}"><div class="mini-spinner"></div><strong>正在解释选中代码…</strong><p>学习模式只读取这段代码，不会修改项目。</p></aside>`;
  if (popup.error) return `<aside class="learning-popup error-card" style="${style}"><button class="popup-close" data-close-learning-popup>×</button><strong>解释失败</strong><p>${escapeHTML(popup.error)}</p></aside>`;
  return `<aside class="learning-popup" style="${style}" draggable="true" data-learning-drag="${escapeHTML(popup.thread.id)}">
    <button class="popup-close" data-close-learning-popup>×</button><div class="eyebrow">拖到右侧继续追问</div>
    <strong>${escapeHTML(popup.thread.title)}</strong><p>${escapeHTML(popup.thread.messages.at(-1)?.text ?? "")}</p>
    <button class="secondary compact" data-open-learning-thread="${escapeHTML(popup.thread.id)}">放入右侧对话</button>
  </aside>`;
}

function learningThreadTabsTemplate(project) {
  const groups = {
    active: project.learningThreads ?? [],
    archived: project.archivedLearningThreads ?? [],
    deleted: project.deletedLearningThreads ?? []
  };
  const view = groups[learningUI.threadView] ? learningUI.threadView : "active";
  const items = groups[view];
  const labels = { active: "窗口", archived: "已归档", deleted: "最近删除" };
  const tabs = items.map((item) => `<button type="button" role="tab" aria-selected="${item.id === learningUI.threadId}" aria-haspopup="menu" data-open-learning-thread="${escapeHTML(item.id)}" data-learning-thread-view="${view}" data-learning-thread-tab="${escapeHTML(item.id)}" class="${item.id === learningUI.threadId ? "active" : ""}" title="${escapeHTML(item.title)} · 右键管理"><span>${escapeHTML(item.title.split("/").at(-1))}</span></button>`).join("");
  const menuThread = learningUI.threadMenu && items.find((item) => item.id === learningUI.threadMenu.threadId);
  const menu = menuThread ? `<div class="learning-thread-menu" role="menu" style="left:${learningUI.threadMenu.x}px;top:${learningUI.threadMenu.y}px" data-learning-thread-menu>
    <strong>${escapeHTML(menuThread.title.split("/").at(-1))}</strong>
    ${view === "active" ? `<button role="menuitem" data-learning-thread-action="archive" data-learning-thread-id="${escapeHTML(menuThread.id)}">归档窗口</button>` : `<button role="menuitem" data-learning-thread-action="${view === "deleted" ? "restore-deleted" : "restore"}" data-learning-thread-id="${escapeHTML(menuThread.id)}">恢复窗口</button>`}
    ${view !== "deleted" ? `<button role="menuitem" class="danger" data-learning-thread-action="delete" data-learning-thread-id="${escapeHTML(menuThread.id)}">删除窗口</button>` : ""}
  </div>` : "";
  return `<div class="learning-thread-toolbar" role="tablist" aria-label="代码讲解窗口视图">${Object.entries(labels).map(([id, label]) => `<button type="button" role="tab" aria-selected="${view === id}" data-learning-thread-view-select="${id}" class="${view === id ? "active" : ""}">${label} ${groups[id].length}</button>`).join("")}</div>
    <div class="learning-thread-tabs" role="tablist" aria-label="${labels[view]}">${tabs || `<span class="learning-thread-empty">${view === "active" ? "暂无代码讲解" : view === "archived" ? "没有已归档窗口" : "最近没有删除窗口"}</span>`}</div>${menu}`;
}

function documentLearningThread(project, module = learningUI.module, file = learningUI.file) {
  if (!documentLearningModules.has(module) || !file) return null;
  return (project.learningThreads ?? []).find((item) => item.scope === "document" && item.module === module
    && item.selection?.sourceId === learningUI.sourceId && item.selection?.filePath === file.path) ?? null;
}

function learningDocumentSectionsTemplate(thread) {
  const details = thread.messages.findLast((message) => message.role === "assistant")?.details ?? {};
  const sourceLines = String(thread.selection?.code ?? "").split("\n");
  const sourceStart = Number(thread.selection?.startLine) || 1;
  return `<div class="learning-document-overview">${thread.messages.map((message) => learningMessageTemplate(message, thread)).join("")}
    <div class="learning-document-sections">${(details.sections ?? []).map((section, index) => {
      const from = Math.max(0, section.startLine - sourceStart);
      const to = Math.max(from + 1, section.endLine - sourceStart + 1);
      const code = sourceLines.slice(from, to).join("\n");
      return `<article class="learning-document-section">
        <header><span>${index + 1}</span><div><strong>${escapeHTML(section.title)}</strong><small>L${section.startLine}–L${section.endLine}</small></div><button class="ghost compact" data-jump-learning-code="${escapeHTML(thread.id)}" data-start-line="${section.startLine}" data-end-line="${section.endLine}">跳到源码 ↗</button></header>
        <p>${escapeHTML(section.explanation)}</p>
        ${section.keyPoints?.length ? listTemplate(section.keyPoints) : ""}
        <details class="learning-code-match"><summary>对应代码 · L${section.startLine}–L${section.endLine}</summary><pre>${escapeHTML(code)}</pre></details>
      </article>`;
    }).join("")}</div>
  </div>`;
}

function learningThreadContentTemplate(thread) {
  if (thread.scope === "document") return learningDocumentSectionsTemplate(thread);
  const canJump = thread.selection?.sourceId && Number.isInteger(thread.selection?.startLine) && Number.isInteger(thread.selection?.endLine);
  return `<div class="snippet-context"><div><strong>${escapeHTML(thread.title)}</strong>${canJump ? `<button class="ghost compact" data-jump-learning-code="${escapeHTML(thread.id)}" data-start-line="${thread.selection.startLine}" data-end-line="${thread.selection.endLine}">跳到源码 L${thread.selection.startLine}–L${thread.selection.endLine} ↗</button>` : ""}</div><pre>${escapeHTML(thread.selection?.code ?? "")}</pre></div><div class="mode-messages">${thread.messages.map((message) => learningMessageTemplate(message, thread)).join("")}</div>`;
}

function activeLearningSource() {
  return learningUI.sources.find((source) => source.id === learningUI.sourceId) ?? null;
}

function activeLearningMaterial(project = activeProject()) {
  return (project?.learningMaterials ?? []).find((material) => material.id === learningUI.materialId) ?? null;
}

function learningShelfKey(kind, primary, secondary = "") {
  return kind === "file" ? `file:${encodeURIComponent(primary)}:${encodeURIComponent(secondary)}` : `material:${encodeURIComponent(primary)}`;
}

function learningFileShelfTemplate(project, files) {
  const materials = project.learningMaterials ?? [];
  const sourceId = learningUI.sourceId;
  const pinned = new Set(project.learningShelf?.pinned ?? []);
  const archived = new Set(project.learningShelf?.archived ?? []);
  const query = learningUI.filter.trim().toLowerCase();
  const entries = [
    ...materials.map((material) => ({
      key: learningShelfKey("material", material.id), kind: "material", title: material.title,
      detail: material.origin || material.url || "跨模式资料", badge: (material.type || "REF").slice(0, 5).toUpperCase(), material
    })),
    ...files.map((filePath) => ({
      key: learningShelfKey("file", sourceId, filePath), kind: "file", title: filePath.split("/").at(-1), detail: filePath,
      badge: filePath.split(".").at(-1)?.slice(0, 5).toUpperCase() || "CODE", filePath
    }))
  ];
  const archivedCount = entries.filter((entry) => archived.has(entry.key)).length;
  const activeCount = entries.length - archivedCount;
  const pinnedCount = entries.filter((entry) => pinned.has(entry.key) && !archived.has(entry.key)).length;
  const visible = entries.filter((entry) => (learningUI.shelfView === "archived") === archived.has(entry.key))
    .filter((entry) => !query || `${entry.title} ${entry.detail}`.toLowerCase().includes(query))
    .sort((left, right) => Number(pinned.has(right.key)) - Number(pinned.has(left.key)) || left.title.localeCompare(right.title, "zh-CN"));
  const itemTemplate = (entry) => {
    const isArchived = archived.has(entry.key);
    const isPinned = pinned.has(entry.key);
    const isActive = entry.kind === "file" ? learningUI.file?.path === entry.filePath && !learningUI.materialId : learningUI.materialId === entry.material.id;
    const dragData = entry.kind === "file" ? `draggable="true" data-learning-file="${escapeHTML(encodeURIComponent(JSON.stringify({ sourceId, filePath: entry.filePath })))}" data-source-file="${escapeHTML(entry.filePath)}"` : `draggable="true" data-learning-material="${escapeHTML(entry.material.id)}"`;
    const extractionLabels = { success: "已读取正文", provided: "已有完整内容", failed: "读取失败", "summary-only": "仅有简介" };
    const extractionStatus = entry.kind === "material" ? (entry.material.extractionStatus || "summary-only") : "";
    const extractionLabel = extractionLabels[extractionStatus] || "";
    const materialDetail = entry.kind === "material"
      ? `<small>${escapeHTML(entry.detail)}</small><small class="learning-source-status ${escapeHTML(extractionStatus)}" title="${escapeHTML(entry.material.extractionError || "")}">${escapeHTML(extractionLabel)}</small>`
      : `<small>${escapeHTML(entry.detail)}</small>`;
    const opener = isArchived
      ? `<div class="learning-shelf-open archived"><span>${escapeHTML(entry.badge)}</span><span><strong>${escapeHTML(entry.title)}</strong><small>${escapeHTML(entry.detail)}</small></span></div>`
      : `<button class="learning-shelf-open" ${dragData} title="打开或拖到中间：${escapeHTML(entry.detail)}"><span>${escapeHTML(entry.badge)}</span><span><strong>${escapeHTML(entry.title)}</strong>${materialDetail}</span></button>`;
    const actions = isArchived
      ? `<button class="learning-shelf-action" data-learning-shelf-action="restore" data-learning-shelf-key="${escapeHTML(entry.key)}" aria-label="恢复 ${escapeHTML(entry.title)}">恢复</button>`
      : `<button class="learning-shelf-action ${isPinned ? "active" : ""}" data-learning-shelf-action="${isPinned ? "unpin" : "pin"}" data-learning-shelf-key="${escapeHTML(entry.key)}" aria-label="${isPinned ? "取消置顶" : "置顶"} ${escapeHTML(entry.title)}">${isPinned ? "取消置顶" : "置顶"}</button><button class="learning-shelf-action" data-learning-shelf-action="archive" data-learning-shelf-key="${escapeHTML(entry.key)}" aria-label="归档 ${escapeHTML(entry.title)}">归档</button>`;
    return `<article class="learning-shelf-row ${isActive ? "active" : ""} ${isPinned ? "pinned" : ""}">${opener}<div class="learning-shelf-actions">${actions}</div></article>`;
  };
  const empty = learningUI.shelfView === "archived" ? "没有已归档文件" : query ? "没有匹配的文件" : "从探索/执行拖入资料，或在上方导入代码";
  return `<section id="learning-file-shelf" class="learning-file-shelf">
    <header><div><div class="eyebrow">LEARNING FILES</div><strong>文件栏</strong></div><span>${activeCount} 项 · ${pinnedCount} 置顶</span></header>
    <div class="learning-shelf-tabs" role="tablist" aria-label="文件栏视图"><button role="tab" aria-selected="${learningUI.shelfView === "active"}" data-learning-shelf-view="active" class="${learningUI.shelfView === "active" ? "active" : ""}">文件 ${activeCount}</button><button role="tab" aria-selected="${learningUI.shelfView === "archived"}" data-learning-shelf-view="archived" class="${learningUI.shelfView === "archived" ? "active" : ""}">已归档 ${archivedCount}</button></div>
    <input id="source-filter" class="source-filter" placeholder="筛选文件" aria-label="筛选学习文件" value="${escapeHTML(learningUI.filter)}">
    ${learningUI.materialAdding ? `<div class="learning-source-reading"><div class="mini-spinner"></div><span><strong>正在读取来源内容…</strong><small>会提取正文与代码，完成后再加入文件栏</small></span></div>` : ""}
    <div class="learning-shelf-list">${visible.length ? visible.map(itemTemplate).join("") : `<div class="learning-shelf-empty">${empty}</div>`}</div>
    <small class="learning-shelf-hint">点击打开，或拖到中间</small>
  </section>`;
}

function repositoryOverviewTemplate(source) {
  const status = learningUI.repositoryOverview;
  if (learningUI.repositoryOverviewLoading) return `<div class="repository-overview-empty"><div class="mini-spinner"></div><strong>正在读取仓库清单…</strong><p>这一步只读取本机仓库，不调用 Agent，不消耗模型 Token。</p></div>`;
  if (status?.error) return `<div class="repository-overview-empty error-card"><strong>无法读取仓库清单</strong><p>${escapeHTML(status.error)}</p></div>`;
  const documents = source.documentOverviews?.length ? source.documentOverviews : (status?.documents ?? []);
  if (documents.length) return `<div class="repository-document-browser"><div class="repository-overview-banner"><div><span>仓库文档概要</span><strong>${escapeHTML(source.title)}</strong></div><small>${documents.length} 个文档 · 选择一个继续分析</small></div>
    <div class="repository-document-list">${documents.map((document) => `<article draggable="true" data-learning-file="${escapeHTML(encodeURIComponent(JSON.stringify({ sourceId: source.id, filePath: document.path })))}"><div><span class="repository-language">${escapeHTML(document.language)}</span>${document.truncated ? `<span class="repository-truncated">摘录概要</span>` : ""}<small>${document.lineCount} 行</small></div><strong>${escapeHTML(document.path)}</strong><p>${escapeHTML(document.summary)}</p>${document.responsibilities?.length ? `<ul>${document.responsibilities.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>` : ""}${document.keySymbols?.length ? `<div class="concept-list">${document.keySymbols.map((item) => `<span>${escapeHTML(item)}</span>`).join("")}</div>` : ""}<button class="secondary compact" data-open-repository-document="${escapeHTML(document.path)}">选择这个文档分析</button></article>`).join("")}</div>
  </div>`;
  const estimate = status?.estimate;
  return `<div class="repository-overview-empty"><span class="repository-home-icon">⌘</span><div class="eyebrow">REPOSITORY FILES READY</div><strong>${escapeHTML(source.title)} · ${Number(estimate?.fileCount ?? learningUI.files.length).toLocaleString()} 个代码文件</strong><p>从左侧文件栏打开任意代码文件，拖选高亮一段代码后即可解释。生成仓库概要只是可选导航，不影响直接阅读源码。</p>
    ${estimate ? `<div class="repository-token-estimate"><div><strong>${estimate.fileCount}</strong><span>代码文档</span></div><div><strong>${formatBytes(estimate.includedBytes)}</strong><span>预计发送</span></div><div><strong>≈ ${Number(estimate.estimatedTokens).toLocaleString()}</strong><span>预估 Token</span></div><div><strong>${estimate.batches}</strong><span>Agent 批次</span></div></div>${estimate.truncatedFiles ? `<p class="repository-estimate-note">其中 ${estimate.truncatedFiles} 个大文件只用前 8 KiB 生成导航概要；选择具体文件后才能深入分析。</p>` : ""}` : ""}
    <div class="token-warning">⚠ 生成概要会调用 ${escapeHTML(activeAgentLabel())}，并计入模型 Token 消耗。</div>
    <button id="generate-repository-overview" class="secondary" ${!estimate || learningUI.repositoryOverviewBusy ? "disabled" : ""}>${learningUI.repositoryOverviewBusy ? "正在生成所有文档概要…" : "可选：生成仓库概要"}</button><small>导入、浏览文件和高亮选择本身不消耗模型 Token；请求解释时才调用 Agent</small></div>`;
}

function emptyLearningPanelTemplate() {
  if (learningUI.busy) return `<div class="learning-drop-zone learning-loading"><div class="mini-spinner"></div><strong>${documentLearningModules.has(learningUI.module) ? "正在生成整份讲解…" : "正在解析拖入的内容…"}</strong><p>${escapeHTML(activeAgentLabel())} 完成后会自动打开结果。</p></div>`;
  if (documentLearningModules.has(learningUI.module)) {
    const label = learningUI.module === "data-structure" ? "数据结构" : "运行流程";
    return `<div class="learning-document-prompt"><span class="learning-document-icon">${learningUI.module === "data-structure" ? "◇" : "↳"}</span><strong>生成当前文件的完整${label}讲解</strong>
      <p>${learningUI.file ? `将读取 ${escapeHTML(learningUI.file.path)} 全文，按章节匹配连续代码范围，并提供源码跳转。` : "请先从中间或左侧选择一个源码文件。"}</p>
      <button id="generate-learning-document" class="primary" ${learningUI.file ? "" : "disabled"}>确认并生成全部</button><small>只读分析，不修改或执行代码</small></div>`;
  }
  const material = activeLearningMaterial();
  if (material) {
    const statusText = material.extractionStatus === "success"
      ? `已从来源读取 ${Number(material.extractedContent?.length || 0).toLocaleString()} 个字符的正文/代码。`
      : material.extractionStatus === "provided" ? "已使用来源直接提供的完整内容。"
      : material.extractionStatus === "failed" ? `来源读取失败：${material.extractionError || "未知错误"} AI 只能依据现有简介。`
      : "当前来源只有简介，AI 无法看到原始正文或代码。";
    return `<div class="learning-document-prompt"><span class="learning-document-icon">↗</span><strong>解析「${escapeHTML(material.title)}」</strong><p>${escapeHTML(statusText)} 确认后才发送给 ${escapeHTML(activeAgentLabel())}，随后可在这里连续问答。</p><button id="analyze-learning-material" class="primary">开始 AI 解析</button><small>本步骤会产生模型 Token 消耗</small></div>`;
  }
  if (activeLearningSource()?.type === "github" && !learningUI.file) return `<div class="learning-drop-zone"><strong>从左侧文件栏选择代码文件</strong><p>打开文件后，直接拖选高亮一段代码即可获得解释。</p><span>仓库概要是可选导航，不是前置步骤</span></div>`;
  return `<div class="learning-drop-zone"><strong>把解释小窗拖到这里</strong><p>同一代码片段会成为独立对话，可连续追问多次。</p><span>也可以点击小窗中的“放入右侧对话”</span></div>`;
}

function visualLearningMaterialTemplate(material) {
  const previewURL = safeWebURL(material.previewURL);
  const sourceURL = safeWebURL(material.url);
  const licenseURL = safeWebURL(material.licenseURL);
  const dimensions = material.width && material.height ? `${material.width} × ${material.height}` : "未知";
  return `<article class="learning-visual-material">
    <div class="learning-visual-preview">${previewURL ? `<img src="${escapeHTML(previewURL)}" alt="${escapeHTML(material.title)}" loading="lazy" referrerpolicy="no-referrer">` : `<div class="learning-visual-placeholder"><span>IMAGE</span><strong>来源没有提供可直接显示的图片</strong></div>`}<span class="visual-truth-badge">元数据转译 · 未看像素</span></div>
    <div class="learning-visual-meta"><div><span>创作者</span><strong>${escapeHTML(material.creator || "未知")}</strong></div><div><span>来源</span><strong>${escapeHTML(material.sourceName || "未知")}</strong></div><div><span>尺寸</span><strong>${escapeHTML(dimensions)}</strong></div><div><span>许可</span><strong>${licenseURL ? `<a href="${escapeHTML(licenseURL)}" target="_blank" rel="noreferrer">${escapeHTML(material.license || "查看来源")}</a>` : escapeHTML(material.license || "未知，不代表可自由使用")}</strong></div></div>
    ${material.summary ? `<p class="learning-visual-summary">${escapeHTML(material.summary)}</p>` : ""}
    <section class="agent-readable-reference"><header><div><span>DSV4 AGENT INPUT</span><strong>Agent 实际读取的参考文本</strong></div><span>pixelAccess: false</span></header><pre>${escapeHTML(material.visual?.agentText || "没有可用的视觉转译文本。")}</pre></section>
    ${sourceURL ? `<a class="learning-visual-source" href="${escapeHTML(sourceURL)}" target="_blank" rel="noreferrer">打开原始来源 ↗</a>` : ""}
  </article>`;
}

function learningTemplate(project) {
  if (!project) return `<section class="mode-empty"><div class="mode-empty-icon">⌁</div><h2>学习模式需要一个项目</h2><p>先从左侧选择项目，并在“工作目录”中指向包含源码的目录。</p></section>`;
  if (learningUI.projectId !== project.id) {
    learningUI = newLearningUI(project.id);
  }
  const material = activeLearningMaterial(project);
  const materialContent = material ? [material.title, material.url, material.summary].filter(Boolean).join("\n\n") : "";
  const lines = (learningUI.file?.content ?? materialContent).split("\n").filter((line, index, items) => items.length > 1 || line);
  const selected = learningUI.selection;
  const selectedSource = activeLearningSource();
  const repositoryHome = selectedSource?.type === "github" && !learningUI.file && !material;
  const threadGroups = { active: project.learningThreads ?? [], archived: project.archivedLearningThreads ?? [], deleted: project.deletedLearningThreads ?? [] };
  let thread = (threadGroups[learningUI.threadView] ?? threadGroups.active).find((item) => item.id === learningUI.threadId);
  if (learningUI.threadView === "active" && documentLearningModules.has(learningUI.module) && (!thread || thread.scope !== "document" || thread.module !== learningUI.module)) {
    thread = documentLearningThread(project);
    learningUI.threadId = thread?.id ?? null;
  }
  return `<div class="learning-shell ${thread?.scope === "document" ? "has-document-thread" : ""}">
    <aside class="source-sidebar">
      <div class="mode-panel-title"><div><div class="eyebrow">LEARNING MODULES</div><strong>学习模块</strong></div><button id="refresh-source-files" class="ghost compact">刷新</button></div>
      <div class="learning-modules">${learningModules.map(([id, label]) => `<button data-learning-module="${id}" class="${learningUI.module === id ? "active" : ""}">${label}</button>`).join("")}</div>
      <div class="learning-source-manager">
        <label>源码来源<select id="learning-source-select">${learningUI.sources.map((source) => `<option value="${escapeHTML(source.id)}" ${source.id === learningUI.sourceId ? "selected" : ""}>${source.type === "github" ? "GitHub · " : source.type === "local" ? "本机 · " : source.type === "upload" ? "导入 · " : ""}${escapeHTML(source.title)}</option>`).join("")}</select></label>
        <div class="learning-source-actions"><button id="pick-learning-files" class="ghost compact">选择文件</button><button id="pick-learning-folder" class="ghost compact">选择文件夹</button></div>
      </div>
      <div id="learning-import-drop" class="learning-import-drop ${learningUI.importing ? "is-importing" : ""}"><strong>${learningUI.importing ? "正在导入源码…" : "拖入桌面文件或文件夹"}</strong><span>${learningUI.importing ? "全部完成后会自动切换来源" : "原文件不会被修改，也不会执行代码"}</span></div>
      <form id="github-learning-search" class="github-learning-search"><input id="github-learning-query" placeholder="搜索 GitHub 仓库" value="${escapeHTML(learningUI.repoQuery)}"><button class="secondary compact" ${learningUI.searching ? "disabled" : ""}>${learningUI.searching ? "搜索中" : "搜索"}</button></form>
      ${learningUI.repoResults.length ? `<div class="github-search-results">${learningUI.repoResults.map((source) => `<article><strong>${escapeHTML(source.title)}</strong><span>${escapeHTML(source.credibilityReason || source.summary)}</span><button data-import-github="${escapeHTML(source.url)}" class="ghost compact">导入仓库</button></article>`).join("")}</div>` : ""}
      ${learningUI.workspace ? `<p class="source-root" title="${escapeHTML(learningUI.workspace)}">${escapeHTML(learningUI.workspace)}</p>` : ""}
      ${learningFileShelfTemplate(project, learningUI.files)}
    </aside>
    <section id="learning-document-stage" class="code-stage">
      ${learningUI.traceSelection ? `<div class="trace-source-banner" role="status"><div><strong>${escapeHTML(learningUI.traceSelection.label || "预览界面组")}</strong><span>来自预览选择 · ${escapeHTML(learningUI.traceSelection.methodLabel)} · L${learningUI.traceSelection.startLine}–L${learningUI.traceSelection.endLine}</span></div><button class="ghost compact" data-return-trace-preview>返回演示窗口</button></div>` : ""}
      <header><div><div class="eyebrow">${repositoryHome ? "GITHUB REPOSITORY" : material ? "LEARNING MATERIAL" : "READ-ONLY SOURCE"}</div><strong>${escapeHTML(repositoryHome ? selectedSource.title : material?.title ?? learningUI.file?.path ?? "从左侧文件栏打开文档")}</strong></div><span>${learningUI.file ? `${learningUI.file.lineCount} 行 · ${escapeHTML(learningUI.file.language)}` : material ? "跨模式资料" : repositoryHome ? "仓库已打开" : "拖入或点击打开"}</span></header>
      <div id="source-code" class="source-code ${repositoryHome ? "repository-home" : ""} ${material ? "material-document" : ""}">${repositoryHome ? repositoryOverviewTemplate(selectedSource) : material?.visual?.mode === "metadata-only" ? visualLearningMaterialTemplate(material) : lines.length ? lines.map((line, index) => {
        const lineNumber = index + 1; const highlighted = selected && lineNumber >= selected.startLine && lineNumber <= selected.endLine;
        return `<div class="code-line ${highlighted ? "highlighted" : ""}" data-line="${lineNumber}"><span class="line-number">${lineNumber}</span><code>${line ? escapeHTML(line) : "&nbsp;"}</code></div>`;
      }).join("") : `<div class="source-placeholder"><strong>选择代码，获得逐段解释</strong><span>拖动高亮一段代码后，${escapeHTML(activeAgentLabel())} 会在小窗中解释。</span></div>`}</div>
    </section>
    <aside id="learning-chat-drop" class="learning-chat ${thread ? "has-thread" : ""}">
      <header><div><div class="eyebrow">${documentLearningModules.has(learningUI.module) ? "WHOLE-FILE LEARNING" : "SAME-SNIPPET DIALOGUE"}</div><strong>${documentLearningModules.has(learningUI.module) ? (learningUI.module === "data-structure" ? "完整数据结构" : "完整运行流程") : "代码对话"}</strong></div>${thread ? `<button data-close-learning-thread class="ghost compact">收起</button>` : ""}</header>
      ${learningThreadTabsTemplate(project)}
      ${thread ? `${learningThreadContentTemplate(thread)}
        ${learningUI.threadView === "active" ? `<form id="learning-chat-form" class="mode-composer"><textarea id="learning-question" placeholder="${thread.scope === "document" ? "针对整份讲解继续提问…" : "针对同一段代码继续提问…"}" ${learningUI.busy ? "disabled" : ""}></textarea><button class="primary" ${learningUI.busy ? "disabled" : ""}>${learningUI.busy ? "思考中…" : "继续提问"}</button></form>` : `<div class="learning-thread-readonly">${learningUI.threadView === "archived" ? "此窗口已归档。右键窗口名可恢复并继续提问。" : "此窗口在最近删除中。右键窗口名可恢复。"}</div>`}` : emptyLearningPanelTemplate()}
    </aside>
    ${learningPopupTemplate()}
  </div>`;
}

function explorationSourcesTemplate(sources = []) {
  if (!sources.length) return "";
  const labels = { high: "高可信", medium: "中可信", low: "低可信" };
  return `<div class="research-sources">${sources.map((source) => {
    const url = safeWebURL(source.url);
    const previewURL = safeWebURL(source.previewURL);
    return `<article class="${previewURL ? "has-visual-preview" : ""}" draggable="true" data-transfer-reference="${encodedTransferReference({ ...source, url, origin: "exploration" })}">${previewURL ? `<div class="research-source-preview"><img src="${escapeHTML(previewURL)}" alt="${escapeHTML(source.title)}" loading="lazy" referrerpolicy="no-referrer"><span>拖入学习预览 / 执行参考</span></div>` : ""}<div><span class="credibility ${escapeHTML(source.credibility)}">${labels[source.credibility] ?? "待核查"}</span><span>${escapeHTML(source.type)}</span><span class="drag-hint">拖到其他模式 ↗</span></div><strong>${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noreferrer">${escapeHTML(source.title)}</a>` : escapeHTML(source.title)}</strong><p>${escapeHTML(source.summary)}</p>${source.creator || source.license ? `<div class="research-source-attribution"><span>${escapeHTML(source.creator || "创作者未知")}</span><span>${escapeHTML(source.license || "许可未知")}</span></div>` : ""}<small>可信度：${escapeHTML(source.credibilityReason)}<br>项目相关性：${escapeHTML(source.projectRelevance)}</small></article>`;
  }).join("")}</div>`;
}

function explorationMessageTemplate(message, kind = "research") {
  const details = message.details ?? {};
  const assistantLabel = kind === "art" ? "艺术研究员" : "研究员";
  return `<article class="mode-message ${escapeHTML(message.role)}"><strong>${message.role === "assistant" ? assistantLabel : "你"}</strong><p>${escapeHTML(message.text)}</p>
    ${explorationSourcesTemplate(details.sources)}
    ${details.unknowns?.length ? `<details><summary>仍未验证</summary>${listTemplate(details.unknowns)}</details>` : ""}
  </article>`;
}

function explorationTemplate(project) {
  const scopedProject = project && explorationUseProject ? project : null;
  const threads = scopedProject ? (scopedProject.explorationThreads ?? []) : (session.state.explorationThreads ?? []);
  const thread = threads.find((item) => item.id === explorationThreadId);
  const kind = thread?.kind === "art" ? "art" : explorationKind;
  const isArt = kind === "art";
  const visibleThreads = threads.filter((item) => (item.kind === "art" ? "art" : "research") === kind);
  const scopeDescription = scopedProject
    ? `会优先研究与「${escapeHTML(scopedProject.title || "当前项目")}」相关的${isArt ? "视觉语言与艺术方向" : "信息"}，也允许探索无关主题。`
    : isArt ? "不绑定项目，可研究公开网络中的艺术、风格、构图与视觉文化。" : "不绑定项目，可研究公开网络中的任意技术主题。";
  return `<div class="exploration-shell">
    <aside class="research-history"><div class="mode-panel-title"><div><div class="eyebrow">${isArt ? "ART SEARCH HISTORY" : "TECH SEARCH HISTORY"}</div><strong>${isArt ? "艺术搜索记录" : "技术搜索记录"}</strong></div><button id="new-exploration" class="secondary compact">新搜索</button></div>
      <div class="exploration-kind-switch" aria-label="探索类型">
        <button data-exploration-kind="research" class="${isArt ? "" : "active"}" aria-pressed="${String(!isArt)}">技术搜索</button>
        <button data-exploration-kind="art" class="${isArt ? "active" : ""}" aria-pressed="${String(isArt)}">艺术搜索</button>
      </div>
      ${project ? `<div class="scope-switch"><button data-exploration-scope="project" class="${explorationUseProject ? "active" : ""}">项目优先</button><button data-exploration-scope="global" class="${explorationUseProject ? "" : "active"}">全局</button></div>` : ""}
      <div class="research-scope"><span>${scopedProject ? "项目优先" : "全局探索"} · ${isArt ? "艺术" : "技术"}</span><p>${scopeDescription}</p></div>
      <div class="research-thread-list">${visibleThreads.length ? visibleThreads.map((item) => `<button data-exploration-thread="${escapeHTML(item.id)}" class="${item.id === explorationThreadId ? "active" : ""}"><strong>${escapeHTML(item.title)}</strong><span>${isArt ? "艺术" : "技术"} · ${escapeHTML(new Date(item.updatedAt).toLocaleString())}</span></button>`).join("") : `<p class="muted small">还没有${isArt ? "艺术" : "技术"}搜索记录。</p>`}</div>
    </aside>
    <section class="research-stage"><header><div><div class="eyebrow">${isArt ? "VISUAL ART RESEARCH" : "TRUSTED PUBLIC RESEARCH"}</div><h2>${thread ? escapeHTML(thread.title) : isArt ? "从视觉方向开始艺术探索" : "从可信来源开始探索"}</h2></div><span class="read-only-badge">只研究 · 不改项目</span></header>
      <div class="research-principles">${isArt ? "<span>风格与语境</span><span>构图与色彩</span><span>追溯原作者</span><span>尊重版权</span>" : "<span>优先官方资料</span><span>优先官方仓库</span><span>关键结论附 URL</span><span>明确未知项</span>"}</div>
      <div class="research-scope" role="note"><span>网页检索 · 必须返回可核查来源</span><p>探索会要求当前 Agent 先调用网页搜索；DSH 请求会临时启用 web_search。工具不可用或没有来源时，本次搜索会失败且不会保存记录。</p></div>
      ${isArt ? `<div class="pinterest-bridge" role="note"><div><strong>Pinterest 视觉搜索</strong><span>外部搜索 · 未连接账户 · LoopCanvas 不读取 Pinterest 数据</span></div><a id="open-pinterest-search" class="secondary compact" href="https://www.pinterest.com/" target="_blank" rel="noreferrer">在 Pinterest 搜索</a></div>` : ""}
      <div class="mode-messages research-messages">${thread ? thread.messages.map((message) => explorationMessageTemplate(message, kind)).join("") : `<div class="research-welcome"><strong>${isArt ? "探索风格、构图、色彩与视觉文化" : "可以搜索 GitHub、文章、论文和仓库"}</strong><p>${isArt ? `${escapeHTML(activeAgentLabel())} 会整理出处、视觉特征和检索词；Pinterest 用于发现灵感，不作为权威来源。` : `${escapeHTML(activeAgentLabel())} 会按来源可信度排序；在项目内开启时，会优先结合项目目标和技术栈。`}</p></div>`}</div>
      <form id="exploration-form" class="mode-composer research-composer"><textarea id="exploration-query" placeholder="${isArt ? "例如：探索粗野主义海报的构图、字体、配色与代表作品…" : "例如：查找适合这个项目的本地代码高亮库，并比较维护状态和许可证…"}" ${explorationBusy ? "disabled" : ""}></textarea><button class="primary" ${explorationBusy ? "disabled" : ""}>${explorationBusy ? "检索中…" : thread ? "继续探索" : "开始探索"}</button></form>
    </section>
  </div>`;
}

function renderModeSwitch() {
  document.querySelectorAll("[data-app-mode]").forEach((button) => {
    const active = workspaceView === "mode" && button.dataset.appMode === appMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderWorkspace() {
  const project = activeProject();
  if (workspaceView === "deliverable" && project) {
    $("#page-title").textContent = `演示窗口 · ${project.title || "新需求"}`;
    $("#workspace").innerHTML = deliverableTemplate(project);
  } else if (appMode === "learning") {
    $("#page-title").textContent = project ? `学习 · ${project.title || "新需求"}` : "学习模式";
    $("#workspace").innerHTML = learningTemplate(project);
  } else if (appMode === "exploration") {
    $("#page-title").textContent = project && explorationUseProject ? `探索 · ${project.title || "新需求"}` : "全局探索";
    $("#workspace").innerHTML = explorationTemplate(project);
  } else if (!project) {
    $("#page-title").textContent = "把需求变成可验收的执行路线";
    $("#workspace").innerHTML = intakeTemplate();
  }
  else if (["intake", "planning"].includes(project.phase) && project.steps.length === 0) $("#workspace").innerHTML = intakeTemplate(project);
  else {
    $("#page-title").textContent = project.title || "新需求";
    $("#workspace").innerHTML = planTemplate(project);
  }
  renderModeSwitch();
}

function renderInstallationGuide() {
  const settings = session.state.settings;
  const installation = session.installation;
  const agentRow = (name, role, agent) => {
    const state = agent?.ready === true ? ["能力已验证", "verified"] : agent?.found ? ["已检测到", "found"] : ["未检测到", ""];
    const detail = agent?.version ? `版本 ${agent.version}` : role;
    return `<div class="agent-detection-row"><strong>${escapeHTML(name)}</strong><span class="agent-state ${state[1]}">${state[0]}</span><small>${escapeHTML(detail)}</small>${agent?.path ? `<code>${escapeHTML(agent.path)}</code>` : ""}${agent?.error ? `<small class="agent-error">${escapeHTML(agent.error)}</small>` : ""}</div>`;
  };
  $("#install-guide").innerHTML = `<div class="agent-detection-list">
    ${agentRow("DeepSeek Harness (dsh)", settings.agentRuntime === "codex" ? "可选执行引擎" : "当前执行引擎", installation?.dsh)}
    ${agentRow("Codex App Server", settings.agentRuntime === "codex" ? "当前执行引擎" : "可选执行引擎", installation?.codex)}
    ${installation?.dsh?.found ? "" : `<div class="agent-install-help">未找到 dsh 时，可由你本人在终端运行：<code>npx @deepseek-ai/dsh web</code><button type="button" id="copy-install-command" class="ghost compact">复制命令</button></div>`}
    <small>首次加载只发现本机路径；点击“检测本机 Agents”后再验证版本与能力。Node.js ${escapeHTML(installation?.node?.version ?? "未知")}</small>
  </div>`;
}

function renderCodexEfforts(preferred = "") {
  const model = codexModels.find((item) => item.model === $("#setting-codex-model").value);
  const effort = $("#setting-codex-effort");
  const options = model?.supportedReasoningEfforts ?? [];
  const selected = preferred || effort.value || session.state.settings.codexReasoningEffort || model?.defaultReasoningEffort || "";
  effort.innerHTML = options.length
    ? options.map((item) => `<option value="${escapeHTML(item.reasoningEffort)}">${escapeHTML(item.reasoningEffort)}</option>`).join("")
    : `<option value="">由模型决定</option>`;
  effort.disabled = !options.length;
  effort.value = options.some((item) => item.reasoningEffort === selected) ? selected : model?.defaultReasoningEffort || options[0]?.reasoningEffort || "";
}

function renderRuntimeSettings({ reset = false } = {}) {
  const settings = session.state.settings;
  const runtime = $("#setting-runtime").value === "codex" ? "codex" : "dsh";
  $("#dsh-runtime-fields").classList.toggle("hidden", runtime !== "dsh");
  $("#codex-runtime-fields").classList.toggle("hidden", runtime !== "codex");
  $("#runtime-choice-note").innerHTML = runtime === "codex"
    ? "<strong>Codex 已选为执行引擎。</strong>后续请求通过本机 stdio App Server；失败时可切回 dsh 重试。"
    : "<strong>DeepSeek Harness 已选为执行引擎。</strong>继续使用现有成熟的 dsh headless 流程。";

  const modelSelect = $("#setting-codex-model");
  const previousModel = reset ? settings.codexModel : modelSelect.value || settings.codexModel;
  const status = $("#codex-model-status");
  status.classList.toggle("error", codexModelsStatus === "error");
  if (codexModelsStatus === "ready" && codexModels.length) {
    modelSelect.innerHTML = codexModels.map((item) => `<option value="${escapeHTML(item.model)}">${escapeHTML(item.displayName)} · ${escapeHTML(item.model)}</option>`).join("");
    const selected = codexModels.some((item) => item.model === previousModel) ? previousModel : codexModels.find((item) => item.isDefault)?.model || codexModels[0].model;
    modelSelect.value = selected;
    modelSelect.disabled = false;
    status.textContent = `已从本机 Codex 读取 ${codexModels.length} 个可选模型；推理强度按当前模型能力显示。`;
    renderCodexEfforts(reset ? settings.codexReasoningEffort : "");
  } else {
    modelSelect.innerHTML = `<option value="">${codexModelsStatus === "loading" ? "正在读取模型目录…" : codexModelsStatus === "error" ? "模型目录不可用" : "选择 Codex 后加载"}</option>`;
    modelSelect.disabled = true;
    $("#setting-codex-effort").innerHTML = `<option value="">由模型决定</option>`;
    $("#setting-codex-effort").disabled = true;
    status.textContent = codexModelsStatus === "loading" ? "正在通过本机 App Server 读取模型目录，不会提交模型任务。" : codexModelsStatus === "error" ? codexModelsError : "切换到 Codex 后读取模型目录。";
  }
  $("#save-settings").disabled = runtime === "codex" && (codexModelsStatus !== "ready" || !modelSelect.value);
}

async function loadCodexModels(force = false) {
  if (codexModelsStatus === "loading" || (!force && codexModelsStatus === "ready")) return;
  codexModelsStatus = "loading";
  codexModelsError = "";
  renderRuntimeSettings();
  try {
    const payload = await api("/api/codex/models", { method: "POST", body: "{}" });
    codexModels = Array.isArray(payload.models) ? payload.models : [];
    if (!codexModels.length) throw new Error("本机 Codex 没有返回可选模型；请先确认登录与账号模型权限。");
    codexModelsStatus = "ready";
  } catch (error) {
    codexModels = [];
    codexModelsStatus = "error";
    codexModelsError = error.message;
  }
  renderRuntimeSettings();
}

function renderSettings() {
  const settings = session.state.settings;
  $("#setting-runtime").value = settings.agentRuntime === "codex" ? "codex" : "dsh";
  $("#setting-dsh").value = settings.dshPath;
  $("#setting-workspace").value = settings.workspace;
  $("#setting-model").value = settings.model;
  $("#setting-effort").value = settings.reasoningEffort;
  $("#setting-caution").value = settings.cautionLevel ?? "medium";
  renderInstallationGuide();
  renderRuntimeSettings({ reset: true });
}

function render() { renderSidebar(); renderHarness(); renderWorkspace(); renderSettings(); renderRuntimeFooter(); renderRemotePanel(); syncBusyPresentation(); }
async function bootstrap() {
  session = await api("/api/bootstrap");
  remoteUI.status = session.remote;
  try {
    sidebarCollapsed = localStorage.getItem("dshwf-sidebar-collapsed") === "1";
    const savedMode = localStorage.getItem("dshwf-app-mode");
    if (["workflow", "learning", "exploration"].includes(savedMode)) appMode = savedMode;
    document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  } catch {}
  const recoveredProject = activeProject();
  const recoveredExecution = recoveredProject?.busy && ["execute", "execute_project", "adaptive_run"].includes(recoveredProject.pendingAction?.type);
  recoveredExecutionProjectId = recoveredExecution ? recoveredProject.id : null;
  if (recoveredExecution) {
    selectedStepId = recoveredProject.pendingAction.stepId ?? selectedStepId;
    selectedSubprocessId = recoveredProject.pendingAction.subprocessId ?? selectedSubprocessId;
  }
  render();
  clearTimeout(remoteUI.pollTimer);
  if (remoteUI.status?.enabled) remoteUI.pollTimer = setTimeout(() => refreshRemoteStatus({ quiet: true }), 3_000);
  if (recoveredProject?.busy) {
    const execute = ["execute", "execute_project", "adaptive_run"].includes(recoveredProject.pendingAction?.type);
    setBusy(true, execute ? `${activeAgentLabel()} 正在执行` : `${activeAgentLabel()} 正在处理`, recoveredProject.id, execute ? "execute" : "global");
  }
  if (appMode === "learning" && activeProject()) await loadSourceFiles();
  if (!recoveredProject?.busy) queueAutomaticWorkflow();
}

async function loadSourceFile(filePath, { reveal = false } = {}) {
  const project = activeProject();
  if (!project || !filePath) return;
  const payload = await api(`/api/projects/${project.id}/source?sourceId=${encodeURIComponent(learningUI.sourceId)}&path=${encodeURIComponent(filePath)}`);
  learningUI.materialId = null;
  learningUI.file = payload.file;
  learningUI.selection = null;
  learningUI.popup = null;
  if (documentLearningModules.has(learningUI.module)) {
    learningUI.threadId = documentLearningThread(activeProject(), learningUI.module, payload.file)?.id ?? null;
  }
  render();
  if (reveal) requestAnimationFrame(() => {
    const sourceCode = $("#source-code");
    if (sourceCode) { sourceCode.scrollTop = 0; sourceCode.scrollLeft = 0; }
    $("#learning-document-stage")?.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
  });
}

async function openLearningFile(sourceId, filePath) {
  if (!sourceId || !filePath) return;
  learningUI.materialId = null;
  learningUI.threadId = null;
  learningUI.traceSelection = null;
  if (learningUI.sourceId !== sourceId) {
    learningUI.sourceId = sourceId; learningUI.file = null; learningUI.files = [];
    await loadSourceFiles();
  }
  await loadSourceFile(filePath, { reveal: true });
}

function openLearningMaterial(materialId) {
  const material = (activeProject()?.learningMaterials ?? []).find((item) => item.id === materialId);
  if (!material) throw new Error("学习资料不存在。");
  learningUI.materialId = material.id;
  learningUI.file = null;
  learningUI.selection = null;
  learningUI.popup = null;
  learningUI.threadId = (activeProject()?.learningThreads ?? []).find((thread) => thread.reference?.id === material.id)?.id ?? null;
  learningUI.module = "explanation";
  render();
}

async function addLearningMaterial(reference) {
  const project = activeProject();
  if (!project) throw new Error("学习资料需要先选择一个项目。");
  if (learningUI.materialAdding) throw new Error("已有一个来源正在读取，请稍候。");
  learningUI.materialAdding = true;
  render();
  try {
    const payload = await api(`/api/projects/${project.id}/learning/materials`, { method: "POST", body: JSON.stringify({ reference }) });
    session.state = payload.state;
    openLearningMaterial(payload.material.id);
    const message = payload.material.extractionStatus === "success"
      ? `已读取「${payload.material.title}」的正文/代码并加入文件栏，尚未调用 AI。`
      : payload.material.extractionStatus === "failed"
        ? `已加入文件栏，但来源读取失败：${payload.material.extractionError}`
        : `已把「${payload.material.title}」加入文件栏，当前只有来源提供的内容。`;
    showToast(message, payload.material.extractionStatus === "failed");
  } finally {
    learningUI.materialAdding = false;
    render();
  }
}

async function updateLearningShelf(key, action) {
  const project = activeProject();
  if (!project) return;
  const payload = await api(`/api/projects/${project.id}/learning/shelf`, { method: "POST", body: JSON.stringify({ key, action }) });
  if (action === "archive") {
    const currentFileKey = learningUI.file ? learningShelfKey("file", learningUI.sourceId, learningUI.file.path) : "";
    const currentMaterialKey = learningUI.materialId ? learningShelfKey("material", learningUI.materialId) : "";
    if (key === currentFileKey || key === currentMaterialKey) {
      learningUI.file = null; learningUI.materialId = null; learningUI.selection = null; learningUI.threadId = null; learningUI.popup = null;
    }
  }
  session.state = payload.state;
  render();
  const labels = { pin: "已置顶", unpin: "已取消置顶", archive: "已归档，可在“已归档”中恢复", restore: "已恢复到文件栏" };
  showToast(labels[action]);
}

async function updateLearningThread(threadId, action) {
  const project = activeProject();
  if (!project || !threadId) return;
  if (action === "delete" && !confirm("删除这个代码讲解窗口？\n\n窗口会移到“最近删除”，仍可通过右键恢复。")) return;
  const payload = await api(`/api/projects/${project.id}/learning/threads/${encodeURIComponent(threadId)}`, { method: "POST", body: JSON.stringify({ action }) });
  session.state = payload.state;
  learningUI.threadMenu = null;
  learningUI.threadView = action === "archive" ? "archived" : action === "delete" ? "deleted" : "active";
  learningUI.threadId = threadId;
  render();
  const labels = { archive: "窗口已归档，可在“已归档”中恢复。", restore: "窗口已恢复。", delete: "窗口已移到“最近删除”。", "restore-deleted": "窗口已从最近删除中恢复。" };
  showToast(labels[action]);
}

function openLearningThreadMenu(button, x, y) {
  const menuWidth = 210;
  const menuHeight = 132;
  learningUI.threadView = button.dataset.learningThreadView || "active";
  learningUI.threadMenu = {
    threadId: button.dataset.learningThreadTab,
    x: Math.max(12, Math.min(x, window.innerWidth - menuWidth - 12)),
    y: Math.max(12, Math.min(y, window.innerHeight - menuHeight - 12))
  };
  render();
  requestAnimationFrame(() => document.querySelector("[data-learning-thread-menu] button")?.focus());
}

async function analyzeLearningMaterial() {
  const project = activeProject();
  const material = activeLearningMaterial(project);
  if (!project || !material || learningUI.busy) return;
  if (!confirm(`开始用 ${activeAgentLabel()} 解析「${material.title}」？\n\n本步骤会产生模型 Token 消耗。`)) return;
  learningUI.busy = true;
  render();
  try {
    const payload = await api(`/api/projects/${project.id}/learning/reference`, { method: "POST", body: JSON.stringify({ materialId: material.id }) });
    if (payload.state) session.state = payload.state;
    learningUI.threadId = payload.thread.id;
    learningUI.threadView = "active";
    learningUI.module = payload.thread.module;
    showToast(`已解析「${material.title}」，可以在右侧继续提问。`);
  } catch (error) { showToast(error.message, true); }
  finally { learningUI.busy = false; render(); }
}

async function loadSourceFiles() {
  const project = activeProject();
  if (!project) return;
  if (learningUI.projectId !== project.id) learningUI = newLearningUI(project.id);
  learningUI.loadingFiles = true;
  render();
  try {
    const payload = await api(`/api/projects/${project.id}/source?sourceId=${encodeURIComponent(learningUI.sourceId)}`);
    learningUI.files = payload.files;
    learningUI.workspace = payload.workspace;
    learningUI.sources = payload.sources;
    const selectedSource = payload.sources.find((source) => source.id === learningUI.sourceId);
    if (selectedSource?.type === "github") {
      learningUI.file = null;
      learningUI.selection = null;
      learningUI.popup = null;
      learningUI.loadingFiles = false;
      render();
      await loadRepositoryOverview();
      return;
    }
    const nextFile = learningUI.file && payload.files.includes(learningUI.file.path) ? learningUI.file.path : payload.files[0];
    learningUI.loadingFiles = false;
    if (nextFile) await loadSourceFile(nextFile);
    else render();
  } catch (error) {
    learningUI.loadingFiles = false;
    render();
    showToast(error.message, true);
  }
}

async function loadRepositoryOverview() {
  const project = activeProject();
  const source = activeLearningSource();
  if (!project || source?.type !== "github") return;
  learningUI.repositoryOverviewLoading = true;
  learningUI.repositoryOverview = null;
  render();
  try {
    learningUI.repositoryOverview = await api(`/api/projects/${project.id}/learning/sources/${source.id}/overview`);
  } catch (error) { learningUI.repositoryOverview = { error: error.message }; }
  finally { learningUI.repositoryOverviewLoading = false; render(); }
}

async function generateRepositoryOverview() {
  const project = activeProject();
  const source = activeLearningSource();
  const estimate = learningUI.repositoryOverview?.estimate;
  if (!project || source?.type !== "github" || !estimate || learningUI.repositoryOverviewBusy) return;
  const confirmed = confirm(`将调用 ${activeAgentLabel()}，为 ${estimate.fileCount} 个代码文档生成概要。\n预计约 ${Number(estimate.estimatedTokens).toLocaleString()} Token，分 ${estimate.batches} 个批次，实际消耗以模型计费为准。\n\n确认开始解析？`);
  if (!confirmed) return;
  learningUI.repositoryOverviewBusy = true;
  render();
  try {
    const payload = await api(`/api/projects/${project.id}/learning/sources/${source.id}/overview`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
    if (payload.state) session.state = payload.state;
    await loadSourceFiles();
    showToast(`已生成 ${payload.documents.length} 个代码文档概要，请选择具体文档分析。`);
  } catch (error) { showToast(error.message, true); }
  finally { learningUI.repositoryOverviewBusy = false; render(); }
}

async function explainLearningSelection(startLine, endLine, x, y) {
  const project = activeProject();
  if (!project || !learningUI.file || learningUI.busy) return;
  learningUI.selection = { startLine, endLine };
  learningUI.popup = { x, y, loading: true };
  learningUI.busy = true;
  render();
  try {
    const payload = await api(`/api/projects/${project.id}/learning/explain`, {
      method: "POST",
      body: JSON.stringify({ sourceId: learningUI.sourceId, filePath: learningUI.file.path, startLine, endLine, module: learningUI.module })
    });
    if (payload.state) session.state = payload.state;
    learningUI.popup = { x, y, loading: false, thread: payload.thread };
  } catch (error) {
    learningUI.popup = { x, y, loading: false, error: error.message };
  } finally {
    learningUI.busy = false;
    render();
  }
}

async function submitLearningQuestion(question) {
  const project = activeProject();
  if (!project || !learningUI.threadId || learningUI.busy) return;
  learningUI.busy = true;
  render();
  try {
    const payload = await api(`/api/projects/${project.id}/learning/chat`, { method: "POST", body: JSON.stringify({ threadId: learningUI.threadId, question }) });
    if (payload.state) session.state = payload.state;
  } catch (error) { showToast(error.message, true); }
  finally { learningUI.busy = false; render(); }
}

async function generateLearningDocument() {
  const project = activeProject();
  if (!project || !learningUI.file || !documentLearningModules.has(learningUI.module) || learningUI.busy) return;
  const sourceId = learningUI.sourceId;
  const filePath = learningUI.file.path;
  const module = learningUI.module;
  learningUI.threadId = null;
  learningUI.busy = true;
  render();
  try {
    const payload = await api(`/api/projects/${project.id}/learning/document`, { method: "POST", body: JSON.stringify({ sourceId, filePath, module }) });
    if (payload.state) session.state = payload.state;
    learningUI.threadId = payload.thread.id;
    learningUI.threadView = "active";
    showToast(`已生成 ${filePath} 的完整${module === "data-structure" ? "数据结构" : "运行流程"}讲解。`);
  } catch (error) { showToast(error.message, true); }
  finally { learningUI.busy = false; render(); }
}

async function jumpToLearningCode(threadId, startLine, endLine) {
  const project = activeProject();
  const thread = [...(project?.learningThreads ?? []), ...(project?.archivedLearningThreads ?? []), ...(project?.deletedLearningThreads ?? [])].find((item) => item.id === threadId);
  if (!thread?.selection?.filePath) return;
  const sourceId = thread.selection.sourceId || "project";
  learningUI.module = thread.module;
  learningUI.threadId = thread.id;
  if (learningUI.sourceId !== sourceId) {
    learningUI.sourceId = sourceId; learningUI.file = null; learningUI.files = [];
    await loadSourceFiles();
  }
  if (learningUI.file?.path !== thread.selection.filePath) await loadSourceFile(thread.selection.filePath);
  learningUI.selection = { startLine, endLine };
  render();
  requestAnimationFrame(() => {
    const container = document.querySelector("#source-code");
    const target = container?.querySelector(`[data-line="${startLine}"]`);
    if (!container || !target) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const centeredTop = container.scrollTop + targetRect.top - containerRect.top - Math.max(0, (container.clientHeight - targetRect.height) / 2);
    container.scrollTop = Math.max(0, centeredTop);
  });
}

function revealSourceSelection(startLine) {
  requestAnimationFrame(() => {
    const container = document.querySelector("#source-code");
    const target = container?.querySelector(`[data-line="${startLine}"]`);
    if (!container || !target) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    container.scrollTop = Math.max(0, container.scrollTop + targetRect.top - containerRect.top - Math.max(0, (container.clientHeight - targetRect.height) / 2));
    target.focus?.({ preventScroll: true });
  });
}

function focusTraceRecord(record) {
  const project = activeProject();
  if (!project || !record?.stepId) throw new Error("这条界面分组没有可返回的完成步骤。");
  appMode = "workflow";
  workspaceView = "mode";
  try { localStorage.setItem("dshwf-app-mode", appMode); } catch {}
  selectedStepId = record.stepId;
  selectedSubprocessId = record.subprocessId ?? null;
  selectedDebugRecordId = record.id;
  traceSourceDrawer = { open: false, loading: false, error: "", recordId: null, file: null };
  render();
  requestAnimationFrame(() => {
    const consolePanel = document.querySelector(".debug-console");
    consolePanel?.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
    consolePanel?.querySelector("[data-open-trace-source]")?.focus({ preventScroll: true });
  });
}

async function openTraceSourceDrawer(record) {
  const project = activeProject();
  if (!project || !record?.source?.path) throw new Error("这条界面分组没有可打开的源码位置。");
  const projectId = project.id;
  traceSourceDrawer = { open: true, loading: true, error: "", recordId: record.id, file: null };
  render();
  requestAnimationFrame(() => document.querySelector("[data-close-trace-source]")?.focus());
  try {
    const payload = await api(`/api/projects/${projectId}/source?sourceId=project&path=${encodeURIComponent(record.source.path)}`);
    if (activeProject()?.id !== projectId || traceSourceDrawer.recordId !== record.id) return;
    traceSourceDrawer = { open: true, loading: false, error: "", recordId: record.id, file: payload.file };
    render();
    requestAnimationFrame(() => {
      const target = document.querySelector(`[data-trace-source-line="${Math.max(1, Number(record.source.startLine) || 1)}"]`);
      target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      document.querySelector("[data-close-trace-source]")?.focus({ preventScroll: true });
    });
  } catch (error) {
    if (activeProject()?.id !== projectId || traceSourceDrawer.recordId !== record.id) return;
    traceSourceDrawer = { open: true, loading: false, error: error.message, recordId: record.id, file: null };
    render();
  }
}

function closeTraceSourceDrawer() {
  const recordId = traceSourceDrawer.recordId;
  traceSourceDrawer = { open: false, loading: false, error: "", recordId: null, file: null };
  render();
  requestAnimationFrame(() => {
    const fallback = recordId ? document.querySelector(`[data-open-trace-source="${CSS.escape(recordId)}"]`) : null;
    (traceSourceDrawerReturnFocus?.isConnected ? traceSourceDrawerReturnFocus : fallback)?.focus?.();
    traceSourceDrawerReturnFocus = null;
  });
}

async function submitExploration(query) {
  const project = explorationUseProject ? activeProject() : null;
  if (explorationBusy) return;
  explorationBusy = true;
  render();
  try {
    const payload = await api("/api/explore", { method: "POST", body: JSON.stringify({ projectId: project?.id ?? null, threadId: explorationThreadId, kind: explorationKind, query }) });
    const collection = project ? (project.explorationThreads ??= []) : (session.state.explorationThreads ??= []);
    replaceThread(collection, payload.thread);
    explorationThreadId = payload.thread.id;
    explorationKind = payload.thread.kind === "art" ? "art" : "research";
  } catch (error) { showToast(error.message, true); }
  finally { explorationBusy = false; render(); }
}

async function searchLearningRepositories(query) {
  const project = activeProject();
  if (!project || !query || learningUI.searching) return;
  learningUI.searching = true;
  learningUI.repoQuery = query;
  render();
  try {
    const researchQuery = `只搜索与以下需求相关的公开 GitHub 源码仓库，并优先官方或维护活跃的仓库：${query}。sources 只返回仓库主页 URL。`;
    const payload = await api("/api/explore", { method: "POST", body: JSON.stringify({ projectId: project.id, threadId: null, query: researchQuery }) });
    project.explorationThreads ??= [];
    replaceThread(project.explorationThreads, payload.thread);
    const details = [...payload.thread.messages].reverse().find((message) => message.role === "assistant")?.details;
    learningUI.repoResults = (details?.sources ?? []).map((source) => ({ ...source, url: githubRepositoryURL(source.url) })).filter((source) => source.url).slice(0, 8);
    if (!learningUI.repoResults.length) showToast("这次没有找到可直接导入的 GitHub 仓库，可换个关键词再试。", true);
  } catch (error) { showToast(error.message, true); }
  finally { learningUI.searching = false; render(); }
}

async function addLocalLearningSource(folderPath) {
  const project = activeProject();
  if (!project) return;
  const payload = await api(`/api/projects/${project.id}/learning/sources/local`, { method: "POST", body: JSON.stringify({ folderPath }) });
  session.state = payload.state;
  learningUI.sourceId = payload.source.id;
  learningUI.file = null;
  await loadSourceFiles();
}

async function importGitHubLearningSource(url) {
  const project = activeProject();
  if (!project || learningUI.importing) return;
  learningUI.importing = true;
  render();
  try {
    const payload = await api(`/api/projects/${project.id}/learning/sources/github`, { method: "POST", body: JSON.stringify({ url }) });
    session.state = payload.state;
    learningUI.sourceId = payload.source.id;
    learningUI.file = null;
    learningUI.repoResults = [];
    await loadSourceFiles();
    showToast(`已导入并展开 ${payload.source.title} 的 ${learningUI.files.length} 个代码文件。请从左侧打开文件，再拖选高亮代码进行解释。`);
  } catch (error) { showToast(error.message, true); }
  finally { learningUI.importing = false; render(); }
}

const learningSourceExtensions = new Set(["c", "cc", "cpp", "cs", "css", "dart", "ex", "exs", "go", "h", "hpp", "html", "java", "js", "jsx", "json", "kt", "kts", "lua", "md", "mjs", "php", "py", "rb", "rs", "scala", "sh", "sql", "svelte", "swift", "toml", "ts", "tsx", "vue", "xml", "yaml", "yml", "zsh"]);
const learningSpecialSourceNames = new Set(["Dockerfile", "Gemfile", "Makefile", "Package.swift", "Rakefile"]);
const ignoredLearningDropDirectories = new Set([".git", ".hg", ".svn", ".build", ".next", ".nuxt", ".turbo", "build", "coverage", "dist", "node_modules", "Pods", "DerivedData", "target", "vendor"]);

function supportedLearningFile(name) {
  const filename = String(name ?? "");
  return learningSpecialSourceNames.has(filename) || learningSourceExtensions.has(filename.split(".").at(-1)?.toLowerCase());
}

function selectedLearningEntries(files) {
  return [...files].map((file) => ({ file, path: file.webkitRelativePath || file.name })).filter((entry) => supportedLearningFile(entry.file.name));
}

async function readDirectoryEntries(reader) {
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return entries;
    entries.push(...batch);
  }
}

async function walkLearningDropEntry(entry, prefix = "") {
  if (!entry) return [];
  const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (!supportedLearningFile(entry.name)) return [];
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [{ file, path: relative }];
  }
  if (!entry.isDirectory || ignoredLearningDropDirectories.has(entry.name)) return [];
  const children = await readDirectoryEntries(entry.createReader());
  return (await Promise.all(children.map((child) => walkLearningDropEntry(child, relative)))).flat();
}

async function droppedLearningEntries(dataTransfer) {
  const roots = [...(dataTransfer.items ?? [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (roots.length) return (await Promise.all(roots.map((entry) => walkLearningDropEntry(entry)))).flat();
  return selectedLearningEntries(dataTransfer.files ?? []);
}

function learningImportTitle(entries) {
  const roots = entries.map((entry) => entry.path.split("/")[0]);
  if (roots.length && roots.every((item) => item === roots[0]) && entries.some((entry) => entry.path.includes("/"))) return roots[0];
  if (entries.length === 1) return entries[0].file.name;
  return `桌面导入 · ${entries.length} 个文件`;
}

async function importLearningEntries(rawEntries) {
  const project = activeProject();
  if (!project || learningUI.importing) return;
  const unique = new Map();
  for (const entry of rawEntries) if (entry?.file && supportedLearningFile(entry.file.name) && !unique.has(entry.path)) unique.set(entry.path, entry);
  const entries = [...unique.values()];
  if (!entries.length) throw new Error("没有找到支持的源码文件。");
  if (entries.length > 500) throw new Error("一次最多导入 500 个源码文件。");
  if (entries.some((entry) => entry.file.size > 1024 * 1024)) throw new Error("单个学习源码不能超过 1 MiB。");
  if (entries.reduce((total, entry) => total + entry.file.size, 0) > 20 * 1024 * 1024) throw new Error("一次导入的源码总量不能超过 20 MiB。");
  learningUI.importing = true;
  render();
  let importId = null;
  try {
    const started = await api(`/api/projects/${project.id}/learning/sources/import`, { method: "POST", body: JSON.stringify({ title: learningImportTitle(entries) }) });
    importId = started.importId;
    for (const entry of entries) {
      const response = await fetch(`/api/projects/${project.id}/learning/sources/import/${importId}/file`, {
        method: "POST", headers: { "X-LoopCanvas-Token": session.token, "X-Learning-Path": encodeURIComponent(entry.path), "Content-Type": "application/octet-stream" }, body: entry.file
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `导入 ${entry.path} 失败。`);
    }
    const completed = await api(`/api/projects/${project.id}/learning/sources/import/${importId}`, { method: "POST", body: "{}" });
    importId = null;
    session.state = completed.state;
    learningUI.sourceId = completed.source.id;
    learningUI.file = null; learningUI.files = [];
    await loadSourceFiles();
    showToast(`已导入 ${completed.source.fileCount} 个源码文件，原文件未修改。`);
  } catch (error) {
    if (importId) await api(`/api/projects/${project.id}/learning/sources/import/${importId}`, { method: "DELETE", body: "{}" }).catch(() => {});
    throw error;
  } finally {
    learningUI.importing = false;
    render();
  }
}

async function ingestLearningReference(reference) {
  const repositoryURL = githubRepositoryURL(reference?.url);
  if (repositoryURL) {
    await importGitHubLearningSource(repositoryURL);
    return;
  }
  await addLearningMaterial(reference);
}

async function routeReferenceToMode(mode, reference) {
  let project = activeProject();
  if (mode === "workflow") {
    if (!project) {
      const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ goal: `参考「${reference.title}」临摹一个同类实现。` }) });
      updateFromPayload(created);
      project = activeProject();
    }
    const payload = await api(`/api/projects/${project.id}/references`, { method: "POST", body: JSON.stringify({ reference }) });
    session.state = payload.state;
    appMode = "workflow";
    render();
    showToast(reference.mediaKind === "image" ? `已把「${reference.title}」转成 DSV4 可读参考；执行后以 Agent 回执为准。` : `已把「${reference.title}」加入执行参考。`);
    return;
  }
  if (!project) throw new Error("学习解析需要先选择一个项目。");
  if (mode === "learning") {
    appMode = "learning";
    if (learningUI.projectId !== project.id) learningUI = newLearningUI(project.id);
    render();
    await ingestLearningReference(reference);
    return;
  }
  if (mode === "exploration") {
    appMode = "exploration";
    explorationUseProject = true;
    explorationThreadId = null;
    render();
    await submitExploration(`继续研究这份参考资料，补充可信来源、相关仓库和可借鉴点：\n标题：${reference.title}\n链接：${reference.url || "无"}\n摘要：${reference.summary}`);
  }
}

async function uploadFiles(files, source = "Web 文件选择器") {
  const draftText = $("#goal-input")?.value ?? null;
  for (const file of files) {
    const response = await fetch("/api/attachments", { method: "POST", headers: { "X-LoopCanvas-Token": session.token, "X-File-Name": encodeURIComponent(file.name), "X-Attachment-Source": encodeURIComponent(source), "Content-Type": file.type || "application/octet-stream" }, body: file });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `附件 ${file.name} 上传失败。`);
    updateFromPayload(payload);
    if (draftText != null && $("#goal-input") && !$("#goal-input").readOnly) $("#goal-input").value = draftText;
  }
}

async function performProjectAction(action) {
  const project = activeProject();
  if (!project) return;
  if (["handoff", "workspace", "documents", "conversations", "checkpoints"].includes(action)) return showInfo(action);
  if (action === "rename") {
    const title = prompt("新的项目标题：", project.title || "");
    if (title == null) return;
    if (!title.trim()) throw new Error("项目标题不能为空。");
    updateFromPayload(await api(`/api/projects/${project.id}/rename`, { method: "POST", body: JSON.stringify({ title }) }));
    showToast("项目已改名。");
    return;
  }
  if (action === "archive") return performProjectLifecycleAction(project.id, action);
  if (action === "reset" && !confirm("返回需求输入？当前状态会先自动建立检查点。")) return;
  const routes = { pause: "pause", resume: "resume", checkpoint: "checkpoints", reset: "reset" };
  updateFromPayload(await api(`/api/projects/${project.id}/${routes[action]}`, { method: "POST", body: action === "checkpoint" ? JSON.stringify({ reason: "手动检查点" }) : "{}" }));
  if (action === "pause") previewGate = null;
  if (action === "resume") queueAutomaticWorkflow(project.id);
  showToast(({ pause: "任务已暂停并生成交接。", resume: "任务已恢复，自动执行将从当前状态继续。", checkpoint: "检查点已创建。", reset: "已返回需求输入。" })[action]);
  if (action === "pause") showInfo("handoff");
}

async function performProjectLifecycleAction(projectId, action, pinned = false) {
  const project = session.state.projects.find((item) => item.id === projectId)
    ?? session.state.archivedProjects.find((item) => item.id === projectId);
  if (!project) throw new Error("任务不存在或状态已经改变。");
  if (action === "archive" && !confirm(`归档任务“${project.title || "新需求"}”？归档会停止这个任务正在运行的 Agent，之后可从“已归档”恢复。`)) return;
  const request = action === "pin"
    ? api(`/api/projects/${projectId}/pin`, { method: "POST", body: JSON.stringify({ pinned }) })
    : api(`/api/projects/${projectId}/${action}`, { method: "POST", body: "{}" });
  const payload = await request;
  if (action === "archive" && session.state.activeProjectId === projectId) {
    selectedStepId = null;
    selectedSubprocessId = null;
    selectedDebugRecordId = null;
    explorationThreadId = null;
  }
  updateFromPayload(payload);
  showToast(action === "pin" ? (pinned ? "任务已置顶。" : "已取消置顶。") : action === "archive" ? "任务已移到已归档。" : "任务已恢复到工作项目。");
}

function timeline(items, type) {
  return `<div class="timeline">${items.length ? items.slice().reverse().map((item) => `<article class="timeline-item"><header><strong>${escapeHTML(type === "context" ? item.author || item.kind : item.title || item.name)}</strong><span>${escapeHTML(item.at ? new Date(item.at).toLocaleString() : item.status || "")}</span></header><p>${escapeHTML(type === "log" ? item.detail : item.content || (item.notes ?? []).join("\n"))}</p></article>`).join("") : `<p class="muted">暂无记录。</p>`}</div>`;
}

function showInfo(kind) {
  const project = activeProject();
  if (!project) return showToast("请先选择项目。", true);
  const titles = { context: "共享上下文", log: "决策记录", agents: "Agent 对话", handoff: "暂停交接", workspace: "项目工作目录", documents: "项目规则", conversations: "完整 Agent 调用记录", checkpoints: "选择回退检查点" };
  $("#info-title").textContent = titles[kind]; $("#info-actions").innerHTML = "";
  if (kind === "context") $("#info-content").innerHTML = timeline(project.context, "context");
  if (kind === "log") $("#info-content").innerHTML = timeline(project.decisionLog, "log");
  if (kind === "agents") {
    const agents = project.agents ?? [];
    const conversations = project.steps.flatMap((step) => (step.conversation ?? []).map((message) => ({ ...message, name: `${step.title} · ${message.role}`, notes: [message.text] })));
    $("#info-content").innerHTML = timeline([...agents, ...conversations], "agents");
  }
  if (kind === "handoff") {
    if (!project.handoff) return showToast("当前项目还没有交接文档。", true);
    $("#info-content").innerHTML = `<div class="capability-tabs"><button data-handoff-version="model" class="secondary">Agent 版</button><button data-handoff-version="technical" class="ghost">技术版</button></div><pre id="handoff-text" class="artifact-content">${escapeHTML(project.handoff.model)}</pre>`;
    $("#info-actions").innerHTML = `<button id="copy-handoff" class="secondary">复制文本</button><button id="download-handoff" class="primary">下载 .md</button>`;
  }
  if (kind === "checkpoints") {
    const checkpoints = [...(project.checkpoints ?? [])].reverse();
    $("#info-content").innerHTML = `<div class="checkpoint-note"><strong>检查点是固定的工作流坐标</strong><p>系统只在每一步决策前和重要执行前保存一次。回退只切换状态，不会新建、删除或消耗检查点，因此可以在已有坐标间反复切换；工作目录里的文件不会自动还原。</p></div><div class="conversation-list checkpoint-list">${checkpoints.length ? checkpoints.map((checkpoint) => {
      const snapshot = checkpoint.snapshot ?? {};
      const stepId = checkpoint.stepId ?? snapshot.selectedStepId;
      const step = (snapshot.steps ?? []).find((item) => item.id === stepId);
      const completed = (snapshot.steps ?? []).filter((item) => item.status === "approved").length;
      const total = (snapshot.steps ?? []).length;
      const kindLabel = checkpoint.kind === "decision" ? "决策前" : checkpoint.kind === "execution" ? "重要执行前" : "手动";
      return `<div class="conversation-item checkpoint-item"><div class="conversation-meta"><strong>${escapeHTML(checkpoint.reason || "未命名检查点")}</strong><span><span class="checkpoint-kind">${escapeHTML(kindLabel)}</span>${escapeHTML(checkpoint.at ? new Date(checkpoint.at).toLocaleString() : "未知时间")} · ${escapeHTML(step ? `目标节点：${step.title}` : `进度：${completed}/${total}`)}</span></div><button class="secondary compact" data-restore-checkpoint="${escapeHTML(checkpoint.id)}">回退到这里</button></div>`;
    }).join("") : `<p class="muted">当前还没有检查点。</p>`}</div>`;
  }
  if (kind === "workspace") {
    $("#info-content").innerHTML = `<div class="workspace-form"><p class="small muted">每个项目使用独立工作目录，Agent 会话、文件与产物相互隔离。</p>
      <label>工作目录<input id="project-workspace-input" value="${escapeHTML(project.workspace ?? "")}"></label>
      <p class="hint">留空表示使用自动派生目录：&lt;全局工作目录&gt;/&lt;项目名&gt;-&lt;短ID&gt;。显式路径必须已经存在且是文件夹。</p></div>`;
    $("#info-actions").innerHTML = `<button id="save-project-workspace" class="primary">保存工作目录</button>`;
  }
  if (kind === "documents") {
    $("#info-content").innerHTML = `<p class="muted">正在读取项目规则…</p>`;
    $("#info-dialog").showModal();
    loadProjectDocuments().catch((error) => showToast(error.message, true));
    return;
  }
  if (kind === "conversations") {
    $("#info-content").innerHTML = `<p class="muted">正在读取对话记录…</p>`;
    $("#info-dialog").showModal();
    loadConversationList().catch((error) => showToast(error.message, true));
    return;
  }
  $("#info-dialog").showModal();
}

async function loadProjectDocuments() {
  const payload = await api(`/api/projects/${activeProject().id}/documents`);
  projectDocuments = payload.documents;
  renderDocumentEditor("AGENTS.md");
}

function renderDocumentEditor(name) {
  const document = projectDocuments[name === "AGENTS.md" ? "agents" : "constitution"];
  $("#info-content").innerHTML = `
    <div class="capability-tabs"><button data-project-doc="AGENTS.md" class="${name === "AGENTS.md" ? "secondary" : "ghost"}">AGENTS.md</button><button data-project-doc="宪法.md" class="${name === "宪法.md" ? "secondary" : "ghost"}">宪法.md</button></div>
    <p class="small muted">${escapeHTML(document?.path ?? "")}</p>
    <textarea id="project-doc-editor" class="documents-editor">${escapeHTML(document?.content ?? "")}</textarea>`;
  $("#info-actions").innerHTML = `<button id="save-project-doc" class="primary" data-doc-name="${name}">保存</button>`;
}

async function loadConversationList() {
  const payload = await api(`/api/projects/${activeProject().id}/conversations`);
  conversationItems = payload.items;
  if (!conversationItems.length) {
    $("#info-content").innerHTML = `<p class="muted">还没有完整的 Agent 调用记录。执行规划或节点后会自动保存 request 与原始输出（脱敏）。</p>`;
    return;
  }
  $("#info-content").innerHTML = `<div class="conversation-list">${conversationItems.map((item) => `
    <div class="conversation-item"><div class="conversation-meta"><strong>${escapeHTML(operationLabel(item.operation))} · ${escapeHTML(item.status === "failed" ? "失败" : "成功")}</strong>
      <span>${escapeHTML(agentRuntimeLabel(item.runtime))} · ${escapeHTML(item.capturedAt ? new Date(item.capturedAt).toLocaleString() : "未知时间")} · ${escapeHTML(formatBytes(item.sizeBytes ?? 0))}</span>${item.error ? `<div class="conversation-error">${escapeHTML(item.error)}</div>` : ""}</div>
      <button data-conversation-view="${escapeHTML(item.id)}" class="secondary compact">查看</button></div>`).join("")}</div>`;
}

function agentRuntimeLabel(runtime) {
  if (runtime === "codex") return "Codex";
  if (runtime === "dsh") return "DeepSeek Harness";
  return "引擎未记录";
}

function operationLabel(operation) {
  return ({
    "route-project": "判断并开始执行",
    "execute-node": "执行节点",
    "execute-project": "连续执行项目",
    execute: "执行步骤",
    "recover-execution": "恢复执行结果",
    explore: "联网探索",
    "learning-explain": "学习解析",
    "learning-chat": "学习对话",
    "learning-document": "生成学习文档",
    "learning-reference": "解析学习参考",
    "learning-repository-overview": "生成仓库概览",
    "preview-trace": "预览追踪"
  })[operation] ?? operation ?? "未知操作";
}

async function showConversationRecord(recordId) {
  const payload = await api(`/api/projects/${activeProject().id}/conversations/${encodeURIComponent(recordId)}`);
  const record = payload.record;
  $("#info-actions").innerHTML = `<button id="back-conversations" class="ghost">返回列表</button><button id="download-conversation" class="primary" data-conversation-file="${escapeHTML(recordId)}">下载 JSON</button>`;
  $("#info-content").innerHTML = `<pre class="conversation-record">${escapeHTML(JSON.stringify({ capturedAt: record.capturedAt, runtime: record.runtime ?? "unknown", operation: record.operation, status: record.status, error: record.error, request: record.request, output: record.output }, null, 2))}</pre>`;
}

async function showCapabilities(kind = "agents") {
  $("#capability-dialog").showModal();
  $("#capability-content").innerHTML = `<p class="muted">正在读取本机${kind}…</p>`;
  if (kind === "agents") {
    const payload = await api("/api/capabilities/agents");
    const document = payload.document;
    $("#capability-content").innerHTML = document.path ? `<p class="small muted">${escapeHTML(document.path)}</p><textarea id="agents-editor" class="agents-editor">${escapeHTML(document.content)}</textarea><div class="action-row"><button id="reload-agents" class="secondary">重新载入</button><button id="save-agents" class="primary" data-path="${escapeHTML(document.path)}">保存</button></div>` : `<p class="muted">当前工作目录链中未找到 AGENTS.md。此处不会无意创建错误作用域。</p>`;
  } else if (kind === "plugins") {
    await loadPluginsTab();
  } else {
    capabilityItems = (await api(kind === "diagnostics" ? "/api/diagnostics" : `/api/capabilities?kind=${kind}`)).items;
    $("#capability-content").innerHTML = `<div class="capability-layout"><div class="capability-list">${capabilityItems.map((item, index) => `<button data-capability-item="${index}">${escapeHTML(item.name ?? item.filename ?? "未命名")}</button>`).join("") || `<p class="muted small">未找到</p>`}</div><pre id="capability-detail" class="capability-detail">选择一项查看只读内容。</pre></div>`;
  }
}

const pluginCategoryLabels = {
  "agent-preset": "官方 Agent 模式", shell: "Shell 与命令", filesystem: "文件与编辑", retrieval: "检索与信息",
  execution: "执行与控制", delegation: "委派与协作", planning: "计划与目标", context: "上下文与压缩",
  identity: "身份与指令", presentation: "工具呈现", framework: "框架与运行时"
};

function pluginCard(item) {
  const manifest = item.manifest;
  const runtime = item.runtime;
  const status = ({ inherited: "继承 dsh profile", enabled: "已同步开启", disabled: "已同步关闭", unsupported: "不可同步" })[runtime.state] ?? runtime.state;
  const enabled = runtime.state === "enabled";
  const targetEnabled = !enabled;
  const action = enabled ? "同步关闭" : "同步开启";
  return `<article class="plugin-card ${enabled ? "enabled" : ""} ${runtime.supported ? "" : "unsupported"}">
    <div class="plugin-card-head">
      <div><strong class="plugin-name">${escapeHTML(manifest.name)}</strong><span class="plugin-package">${escapeHTML(manifest.package)} · v${escapeHTML(manifest.version)}</span></div>
      <div class="plugin-runtime-control"><span class="plugin-runtime-status ${escapeHTML(runtime.state)}">${escapeHTML(status)}</span><button class="${enabled ? "ghost" : "secondary"} compact" data-plugin-sync="${escapeHTML(manifest.id)}" data-enabled="${targetEnabled}" ${runtime.supported ? "" : "disabled"}>${runtime.supported ? action : "不可同步"}</button></div>
    </div>
    <p class="plugin-description">${escapeHTML(manifest.description)}</p>
    ${runtime.reason ? `<p class="plugin-runtime-reason">${escapeHTML(runtime.reason)}</p>` : ""}
    <details class="plugin-details"><summary>解决什么问题 · 推荐使用人群</summary>
      <p><strong>解决什么问题：</strong>${escapeHTML(manifest.problem)}</p>
      <p><strong>推荐使用人群：</strong>${escapeHTML(manifest.audience)}</p>
      ${manifest.usage ? `<p><strong>在哪里生效：</strong>${escapeHTML(manifest.usage)}</p>` : ""}
      <p class="small muted">来源：${escapeHTML(manifest.source)}${manifest.license ? ` · ${escapeHTML(manifest.license)}` : ""}${manifest.defaultEnabled ? " · 官方默认启用" : " · 官方默认关闭"}</p>
    </details>
  </article>`;
}

async function loadPluginsTab() {
  const [catalogResult, legacyResult] = await Promise.allSettled([
    api("/api/plugins"),
    api("/api/capabilities?kind=plugins")
  ]);
  const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : { items: [] };
  const legacy = legacyResult.status === "fulfilled" ? legacyResult.value : { items: [] };
  const errors = [
    catalogResult.status === "rejected" ? `LoopCanvas 插件目录读取失败：${catalogResult.reason?.message ?? "未知错误"}` : null,
    legacyResult.status === "rejected" ? `本机 Codex 插件读取失败：${legacyResult.reason?.message ?? "未知错误"}` : null
  ].filter(Boolean);
  capabilityItems = legacy.items;
  pluginCatalogItems = catalog.items;
  const groups = new Map();
  for (const item of catalog.items) {
    if (!item.manifest) continue;
    const key = item.manifest.category || "其他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const sections = [...groups.entries()].map(([category, group]) => `
    <section class="plugin-group"><h3 class="plugin-group-title">${escapeHTML(pluginCategoryLabels[category] ?? category)}<span class="plugin-count">${group.length}</span></h3>
      <div class="plugin-list">${group.map(pluginCard).join("")}</div>
    </section>`).join("");
  $("#capability-content").innerHTML = `
    ${errors.map((message) => `<div class="card error-card small">${escapeHTML(message)}</div>`).join("")}
    <div class="plugin-intro"><strong>LoopCanvas 插件目录</strong><span>内置 DeepSeek Harness 官方插件 ${catalog.items.length} 个。同步状态会注入后续 LoopCanvas dsh headless 调用，不改写 ~/.dsh profile；开启前会显示插件功能并要求确认。</span></div>
    ${sections || `<p class="muted">${catalogResult.status === "rejected" ? "目录暂不可用；本机 Codex 插件仍可在下方查看。" : "没有可用插件。"}</p>`}
    ${legacy.items.length ? `<details class="plugin-legacy"><summary>本机 Codex 插件（${legacy.items.length}，只读）</summary><div class="capability-layout"><div class="capability-list">${legacy.items.map((item, index) => `<button data-capability-item="${index}">${escapeHTML(item.name ?? "未命名")}</button>`).join("")}</div><pre id="capability-detail" class="capability-detail">选择一项查看只读内容。</pre></div></details>` : ""}`;
}

function showPluginEnableConfirmation(item) {
  const manifest = item.manifest;
  pendingPluginEnable = item;
  $("#plugin-confirm-title").textContent = `确认开启「${manifest.name}」`;
  $("#plugin-confirm-content").innerHTML = `
    <div class="plugin-confirm-summary">
      <p class="plugin-description">${escapeHTML(manifest.description)}</p>
      <dl class="plugin-confirm-details">
        <div><dt>功能 / 解决什么问题</dt><dd>${escapeHTML(manifest.problem)}</dd></div>
        <div><dt>推荐使用人群</dt><dd>${escapeHTML(manifest.audience)}</dd></div>
        ${manifest.usage ? `<div><dt>在哪里生效</dt><dd>${escapeHTML(manifest.usage)}</dd></div>` : ""}
      </dl>
      <p class="plugin-confirm-notice">确认后，此插件会同步到后续 LoopCanvas 发起的 dsh ${escapeHTML(item.runtime.dshVersion)} headless 调用。不会改写你的 ~/.dsh profile。</p>
    </div>`;
  $("#plugin-confirm-dialog").showModal();
}

function closePluginEnableConfirmation() {
  pendingPluginEnable = null;
  $("#plugin-confirm-dialog").close();
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

$("#new-project").addEventListener("click", async () => {
  try {
    const payload = await api("/api/projects/draft", { method: "POST", body: "{}" });
    workspaceView = "mode";
    selectedStepId = null;
    explorationThreadId = null;
    updateFromPayload(payload);
    showToast("已创建独立的新项目，需求会保存在这里。");
  } catch (error) { showToast(error.message, true); }
});
document.querySelectorAll("[data-app-mode]").forEach((button) => button.addEventListener("click", async () => {
  traceSourceDrawer = { open: false, loading: false, error: "", recordId: null, file: null };
  appMode = button.dataset.appMode;
  workspaceView = "mode";
  try { localStorage.setItem("dshwf-app-mode", appMode); } catch {}
  render();
  if (appMode === "learning" && activeProject() && !learningUI.files.length && !learningUI.loadingFiles) await loadSourceFiles();
}));
document.querySelectorAll("[data-transfer-mode]").forEach((target) => {
  target.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes("application/x-loopcanvas-reference")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    target.classList.add("drop-ready");
  });
  target.addEventListener("dragleave", () => target.classList.remove("drop-ready"));
  target.addEventListener("drop", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    target.classList.remove("drop-ready");
    document.body.classList.remove("reference-dragging");
    $("#transfer-dock").setAttribute("aria-hidden", "true");
    let reference = null;
    try { reference = JSON.parse(event.dataTransfer.getData("application/x-loopcanvas-reference") || "null"); } catch {}
    if (!reference) return;
    try { await routeReferenceToMode(target.dataset.transferMode, reference); } catch (error) { showToast(error.message, true); }
  });
});
$("#open-settings").addEventListener("click", () => { renderSettings(); $("#settings-dialog").showModal(); if (session.installation?.codex?.found) loadCodexModels().catch(() => {}); });
$("#open-remote").addEventListener("click", () => setRemotePanel(!remoteUI.open, { focus: !remoteUI.open }));
$("#close-remote").addEventListener("click", () => setRemotePanel(false, { focus: true }));
$("#create-remote-pairing").addEventListener("click", async () => {
  try {
    const payload = await api("/api/remote/pairings", { method: "POST", body: JSON.stringify({ label: "手机浏览器" }) });
    remoteUI.pairing = payload.pairing;
    remoteUI.status = payload.remote;
    renderRemotePanel();
  } catch (error) { showToast(error.message, true); }
});
$("#remote-panel").addEventListener("click", async (event) => {
  const revoke = event.target.closest("[data-revoke-remote-device]");
  if (revoke) {
    event.stopPropagation();
    try { remoteUI.status = (await api(`/api/remote/devices/${encodeURIComponent(revoke.dataset.revokeRemoteDevice)}/revoke`, { method: "POST", body: "{}" })).remote; renderRemotePanel(); showToast("设备会话已撤销。"); }
    catch (error) { showToast(error.message, true); }
    return;
  }
  const decision = event.target.closest("[data-remote-command-decision]");
  if (decision) {
    const id = decision.dataset.remoteCommandId;
    const targetDeviceId = document.querySelector(`[data-remote-command-target="${CSS.escape(id)}"]`)?.value ?? "";
    try {
      const payload = await api(`/api/remote/commands/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify({ decision: decision.dataset.remoteCommandDecision, targetDeviceId }) });
      if (payload.state) session.state = payload.state;
      remoteUI.status = payload.remote;
      render();
      showToast(decision.dataset.remoteCommandDecision === "approved" ? "Remote 命令已批准并执行受限动作。" : "Remote 命令已拒绝。");
    } catch (error) { showToast(error.message, true); }
    return;
  }
  const device = event.target.closest("[data-remote-device]");
  if (device) {
    if (device.getAttribute("aria-disabled") === "true") return showToast("目标设备当前不在线。", true);
    openRemoteRun({ type: "webpage", title: "粘贴网页链接", url: "", summary: "手动输入的网页", origin: "manual" }, device.dataset.remoteDevice, { needsURL: true });
  }
});
$("#remote-panel").addEventListener("dragover", (event) => {
  const device = event.target.closest("[data-remote-device]");
  if (!device || device.getAttribute("aria-disabled") === "true") return;
  if (![...(event.dataTransfer?.types ?? [])].some((type) => ["application/x-loopcanvas-reference", "text/uri-list", "text/plain"].includes(type))) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  device.classList.add("drop-ready");
});
$("#remote-panel").addEventListener("dragleave", (event) => {
  const device = event.target.closest("[data-remote-device]");
  if (device && !device.contains(event.relatedTarget)) device.classList.remove("drop-ready");
});
$("#remote-panel").addEventListener("drop", (event) => {
  const device = event.target.closest("[data-remote-device]");
  if (!device || device.getAttribute("aria-disabled") === "true") return;
  event.preventDefault();
  event.stopPropagation();
  device.classList.remove("drop-ready");
  const reference = referenceFromDataTransfer(event.dataTransfer);
  if (!reference) return showToast("没有识别到可投放的网页或参考内容。", true);
  openRemoteRun(reference, device.dataset.remoteDevice);
});
$("#cancel-remote-run").addEventListener("click", () => { remoteUI.pending = null; $("#remote-run-dialog").close(); });
$("#remote-run-dialog").addEventListener("close", () => { remoteUI.pending = null; });
$("#remote-run-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "confirm") return;
  event.preventDefault();
  if (!remoteUI.pending) return $("#remote-run-dialog").close();
  const linkInput = $("#remote-link-input");
  if (linkInput) {
    const url = safeWebURL(linkInput.value.trim());
    if (!url) return showToast("请输入有效的 http 或 https 网页链接。", true);
    remoteUI.pending.reference = { ...remoteUI.pending.reference, title: new URL(url).hostname, url };
  }
  try {
    const pending = remoteUI.pending;
    const payload = await api("/api/remote/handoffs", { method: "POST", body: JSON.stringify({ url: pending.reference.url, title: pending.reference.title, targetDeviceId: pending.device.id }) });
    remoteUI.status = payload.remote;
    remoteUI.lastHandoff = { title: String(pending.reference.title || "未命名网页").slice(0, 240), device: pending.device.name, at: new Date().toISOString() };
    remoteUI.pending = null;
    $("#remote-run-dialog").close();
    renderRemotePanel();
    showToast(`网页已发送到 ${pending.device.name}，等待目标设备选择运行位置。`);
  } catch (error) { showToast(error.message, true); }
});
$("#collapse-sidebar").addEventListener("click", toggleSidebar);
$("#sidebar-preview-toggle").addEventListener("click", () => {
  const project = activeProject();
  if (!project) return;
  markPreviewSeen(project);
  workspaceView = "deliverable";
  render();
  requestAnimationFrame(() => {
    const preview = $(".deliverable-window");
    preview?.setAttribute("tabindex", "-1");
    preview?.focus({ preventScroll: true });
  });
});
$("#project-list").addEventListener("click", async (event) => {
  const actionButton = event.target.closest("[data-project-task-action]");
  if (actionButton) {
    try {
      const action = actionButton.dataset.projectTaskAction;
      await performProjectLifecycleAction(actionButton.dataset.projectId, action, action === "pin" && actionButton.dataset.pinned !== "true");
    } catch (error) { showToast(error.message, true); }
    return;
  }
  const button = event.target.closest("[data-project]");
  if (!button) return;
  try { const payload = await api(`/api/projects/${button.dataset.project}/activate`, { method: "POST", body: "{}" }); selectedStepId = null; selectedSubprocessId = null; selectedDebugRecordId = null; traceSourceDrawer = { open: false, loading: false, error: "", recordId: null, file: null }; explorationThreadId = null; previewGate = null; updateFromPayload(payload); if (appMode === "learning") await loadSourceFiles(); queueAutomaticWorkflow(button.dataset.project); } catch (error) { showToast(error.message, true); }
});
$("#archived-project-list").addEventListener("click", async (event) => {
  const button = event.target.closest('[data-project-task-action="restore"]');
  if (!button) return;
  try { await performProjectLifecycleAction(button.dataset.projectId, "restore"); } catch (error) { showToast(error.message, true); }
});
window.addEventListener("message", async (event) => {
  const frame = $("#artifact-preview");
  if (!frame || event.source !== frame.contentWindow || event.data?.type !== "loopcanvas:preview-select" || ![1, 2, 3].includes(event.data?.version)) return;
  const project = activeProject();
  const target = event.data.version >= 2 ? event.data.target : { kind: "dom", element: event.data.element };
  if (!project || !target || typeof target !== "object" || JSON.stringify(target).length > 6_000 || previewTraceBusy) return;
  previewTraceBusy = true;
  showToast(target.traceId ? "正在按对象标识定位源码…" : "Agent 正在当前产物范围内判断源码位置…");
  try {
    const payload = await api(`/api/projects/${project.id}/debug/locate`, { method: "POST", body: JSON.stringify({ target }) });
    session.state = payload.state;
    selectedStepId = payload.record.stepId;
    selectedSubprocessId = payload.record.subprocessId;
    selectedDebugRecordId = payload.record.id;
    previewGate = null;
    const methodLabel = payload.record.locationMethod === "exact" ? "精确定位" : payload.record.locationMethod === "combined" ? "组合定位" : "推测定位";
    focusTraceRecord(payload.record);
    showToast(`${methodLabel}并已返回完成步骤 · ${payload.record.source.path} L${payload.record.source.startLine}–L${payload.record.source.endLine}`);
  } catch (error) { showToast(error.message, true); }
  finally { previewTraceBusy = false; }
});
window.addEventListener("keydown", (event) => {
  if (!traceSourceDrawer.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeTraceSourceDrawer();
    return;
  }
  if (event.key !== "Tab") return;
  const drawer = document.querySelector(".trace-source-drawer");
  const focusable = [...(drawer?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$("#attachment-input").addEventListener("change", async (event) => { try { await uploadFiles([...event.target.files], "文件选择器"); showToast("附件已暂存在本机。"); } catch (error) { showToast(error.message, true); } finally { event.target.value = ""; } });
$("#learning-file-input").addEventListener("change", async (event) => { try { await importLearningEntries(selectedLearningEntries(event.target.files)); } catch (error) { showToast(error.message, true); } finally { event.target.value = ""; } });
$("#learning-folder-input").addEventListener("change", async (event) => { try { await importLearningEntries(selectedLearningEntries(event.target.files)); } catch (error) { showToast(error.message, true); } finally { event.target.value = ""; } });

$("#workspace").addEventListener("click", async (event) => {
  const openTraceSource = event.target.closest("[data-open-trace-source]");
  if (openTraceSource) {
    const project = activeProject();
    const record = project?.steps.flatMap((step) => step.debugRecords ?? []).find((item) => item.id === openTraceSource.dataset.openTraceSource);
    if (record) {
      traceSourceDrawerReturnFocus = openTraceSource;
      await openTraceSourceDrawer(record).catch((error) => showToast(error.message, true));
    }
    return;
  }
  if (event.target.closest("[data-close-trace-source]") || event.target.matches("[data-trace-drawer-backdrop]")) {
    closeTraceSourceDrawer();
    return;
  }
  if (event.target.closest("[data-retry-trace-source]")) {
    const project = activeProject();
    const record = project?.steps.flatMap((step) => step.debugRecords ?? []).find((item) => item.id === traceSourceDrawer.recordId);
    if (record) await openTraceSourceDrawer(record).catch((error) => showToast(error.message, true));
    return;
  }
  if (event.target.closest("[data-return-trace-preview]")) {
    learningUI.traceSelection = null;
    appMode = "workflow";
    workspaceView = "deliverable";
    try { localStorage.setItem("dshwf-app-mode", appMode); } catch {}
    render();
    return;
  }
  if (event.target.closest("#return-from-preview")) {
    appMode = "workflow";
    workspaceView = "mode";
    try { localStorage.setItem("dshwf-app-mode", appMode); } catch {}
    render();
    requestAnimationFrame(() => { const heading = $("#page-title"); heading.setAttribute("tabindex", "-1"); heading.focus({ preventScroll: true }); });
    return;
  }
  if (event.target.closest("#skip-preview")) {
    const gate = previewGate;
    const project = activeProject();
    if (!gate || !project || gate.projectId !== project.id) return;
    markPreviewSeen(project);
    updateFromPayload(await api(`/api/projects/${project.id}/steps/${gate.stepId}/approve`, { method: "POST", body: "{}" }));
    previewGate = null;
    workspaceView = "mode";
    render();
    showToast("已跳过本次预览，自动执行继续。");
    queueAutomaticWorkflow(project.id);
    return;
  }
  if (event.target.closest("#open-artifact-preview")) { const project = activeProject(); if (project) markPreviewSeen(project); workspaceView = "deliverable"; render(); return; }
  if (appMode === "learning") {
    if (learningUI.threadMenu && !event.target.closest("[data-learning-thread-menu]") && !event.target.closest("[data-learning-thread-tab]")) {
      learningUI.threadMenu = null;
      document.querySelector("[data-learning-thread-menu]")?.remove();
    }
    const threadAction = event.target.closest("[data-learning-thread-action]");
    if (threadAction) { await updateLearningThread(threadAction.dataset.learningThreadId, threadAction.dataset.learningThreadAction).catch((error) => showToast(error.message, true)); return; }
    const threadView = event.target.closest("[data-learning-thread-view-select]");
    if (threadView) {
      const view = threadView.dataset.learningThreadViewSelect;
      const groups = { active: activeProject()?.learningThreads ?? [], archived: activeProject()?.archivedLearningThreads ?? [], deleted: activeProject()?.deletedLearningThreads ?? [] };
      learningUI.threadView = view; learningUI.threadId = groups[view]?.[0]?.id ?? null; learningUI.threadMenu = null; render(); return;
    }
    const shelfAction = event.target.closest("[data-learning-shelf-action]");
    if (shelfAction) { await updateLearningShelf(shelfAction.dataset.learningShelfKey, shelfAction.dataset.learningShelfAction).catch((error) => showToast(error.message, true)); return; }
    const shelfView = event.target.closest("[data-learning-shelf-view]");
    if (shelfView) { learningUI.shelfView = shelfView.dataset.learningShelfView; learningUI.filter = ""; render(); return; }
    const sourceFile = event.target.closest("[data-source-file]");
    if (sourceFile) { await openLearningFile(learningUI.sourceId, sourceFile.dataset.sourceFile).catch((error) => showToast(error.message, true)); return; }
    const shelfMaterial = event.target.closest("[data-learning-material]");
    if (shelfMaterial) { try { openLearningMaterial(shelfMaterial.dataset.learningMaterial); } catch (error) { showToast(error.message, true); } return; }
    const moduleButton = event.target.closest("[data-learning-module]");
    if (moduleButton) {
      learningUI.module = moduleButton.dataset.learningModule;
      learningUI.popup = null; learningUI.selection = null;
      learningUI.threadId = documentLearningModules.has(learningUI.module) ? documentLearningThread(activeProject())?.id ?? null : null;
      render(); return;
    }
    const threadButton = event.target.closest("[data-open-learning-thread]");
    if (threadButton) {
      const view = threadButton.dataset.learningThreadView || "active";
      const groups = { active: activeProject()?.learningThreads ?? [], archived: activeProject()?.archivedLearningThreads ?? [], deleted: activeProject()?.deletedLearningThreads ?? [] };
      const selectedThread = groups[view].find((item) => item.id === threadButton.dataset.openLearningThread);
      learningUI.threadView = view; learningUI.threadId = threadButton.dataset.openLearningThread; learningUI.module = selectedThread?.module ?? learningUI.module; learningUI.popup = null; learningUI.threadMenu = null; render(); return;
    }
    const jumpButton = event.target.closest("[data-jump-learning-code]");
    if (jumpButton) { await jumpToLearningCode(jumpButton.dataset.jumpLearningCode, Number(jumpButton.dataset.startLine), Number(jumpButton.dataset.endLine)).catch((error) => showToast(error.message, true)); return; }
    if (event.target.closest("#generate-learning-document")) { await generateLearningDocument(); return; }
    if (event.target.closest("#analyze-learning-material")) { await analyzeLearningMaterial(); return; }
    if (event.target.closest("#generate-repository-overview")) { await generateRepositoryOverview(); return; }
    const repositoryDocument = event.target.closest("[data-open-repository-document]");
    if (repositoryDocument) { await openLearningFile(learningUI.sourceId, repositoryDocument.dataset.openRepositoryDocument).catch((error) => showToast(error.message, true)); return; }
    if (event.target.closest("[data-close-learning-thread]")) { learningUI.threadId = null; render(); return; }
    if (event.target.closest("[data-close-learning-popup]")) { learningUI.popup = null; render(); return; }
    if (event.target.closest("#refresh-source-files")) { await loadSourceFiles(); return; }
    if (event.target.closest("#pick-learning-files")) { $("#learning-file-input").click(); return; }
    if (event.target.closest("#pick-learning-folder")) { $("#learning-folder-input").click(); return; }
    const githubImport = event.target.closest("[data-import-github]");
    if (githubImport) {
      if (confirm(`把公开仓库 ${githubImport.dataset.importGithub} 克隆到当前项目的只读学习目录？\n\n这一步只打开仓库，不会解析代码，也不会消耗模型 Token。`)) await importGitHubLearningSource(githubImport.dataset.importGithub);
      return;
    }
  }
  if (appMode === "exploration") {
    if (event.target.closest("#new-exploration")) { explorationThreadId = null; render(); return; }
    const kindButton = event.target.closest("[data-exploration-kind]");
    if (kindButton) { explorationKind = kindButton.dataset.explorationKind === "art" ? "art" : "research"; explorationThreadId = null; render(); return; }
    const scopeButton = event.target.closest("[data-exploration-scope]");
    if (scopeButton) { explorationUseProject = scopeButton.dataset.explorationScope === "project"; explorationThreadId = null; render(); return; }
    const threadButton = event.target.closest("[data-exploration-thread]");
    if (threadButton) {
      explorationThreadId = threadButton.dataset.explorationThread;
      const project = explorationUseProject ? activeProject() : null;
      const collection = project ? (project.explorationThreads ?? []) : (session.state.explorationThreads ?? []);
      explorationKind = collection.find((item) => item.id === explorationThreadId)?.kind === "art" ? "art" : "research";
      render(); return;
    }
    const pinterestLink = event.target.closest("#open-pinterest-search");
    if (pinterestLink) {
      const project = explorationUseProject ? activeProject() : null;
      const collection = project ? (project.explorationThreads ?? []) : (session.state.explorationThreads ?? []);
      const thread = collection.find((item) => item.id === explorationThreadId);
      const query = $("#exploration-query")?.value.trim() || thread?.title || "";
      const url = pinterestSearchURL(query);
      if (!url) { event.preventDefault(); showToast("先输入要在 Pinterest 搜索的艺术方向。", true); return; }
      pinterestLink.href = url;
      showToast("已把同一关键词交给 Pinterest 搜索；LoopCanvas 未读取你的账户数据。");
      return;
    }
  }
  const adaptiveRun = event.target.closest("[data-adaptive-run]");
  if (adaptiveRun) {
    const project = activeProject();
    if (!project) return;
    const requestedStepId = adaptiveRun.dataset.adaptiveRunStep || "";
    try {
      setBusy(true, requestedStepId ? "正在执行所选节点" : adaptiveRun.dataset.adaptiveRun === "parallel" ? "正在并行执行就绪节点" : "正在依次执行就绪节点", project.id, "execute");
      updateFromPayload(await api(`/api/projects/${project.id}/run`, { method: "POST", body: JSON.stringify({ mode: adaptiveRun.dataset.adaptiveRun, stepId: requestedStepId || null }) }));
      if (!requestedStepId) queueAutomaticWorkflow(project.id);
    } catch (error) {
      await resynchronizeExecutionState(project.id).catch(() => {});
      showToast(error.message, true);
    }
    finally { setBusy(false); }
    return;
  }
  const directionSubmit = event.target.closest("[data-submit-direction]");
  if (directionSubmit) {
    const project = activeProject();
    const stepId = directionSubmit.dataset.submitDirection;
    const step = project?.steps.find((item) => item.id === stepId);
    const optionId = document.querySelector(`[data-direction-option="${CSS.escape(stepId)}"]:checked`)?.value ?? "";
    const supplemental = document.querySelector(`[data-direction-supplement="${CSS.escape(stepId)}"]`)?.value.trim() ?? "";
    const answer = document.querySelector(`[data-direction-answer="${CSS.escape(stepId)}"]`)?.value.trim() ?? "";
    if (step?.directionOptions?.length && !optionId) { showToast("请先选择一个执行方向。", true); return; }
    if (!step?.directionOptions?.length && !answer) { showToast("请先明确回复目标方向。", true); return; }
    try {
      updateFromPayload(await api(`/api/projects/${project.id}/steps/${stepId}/direction`, { method: "POST", body: JSON.stringify({ optionId, supplemental, answer }) }));
      directionDrafts.delete(directionDraftKey(project.id, stepId));
      showToast("方向已确认，继续执行。");
      queueAutomaticWorkflow(project.id);
    } catch (error) { showToast(error.message, true); }
    return;
  }
  if (event.target.closest(".direction-request")) return;
  const adaptiveRollback = event.target.closest("[data-adaptive-rollback]");
  if (adaptiveRollback) {
    const project = activeProject();
    selectedStepId = adaptiveRollback.dataset.adaptiveRollback;
    try {
      updateFromPayload(await api(`/api/projects/${project.id}/steps/${selectedStepId}/rollback`, { method: "POST", body: "{}" }));
      showToast("节点执行状态已回退；工作目录文件没有自动恢复，请按节点回滚说明处理。");
    } catch (error) { showToast(error.message, true); }
    return;
  }
  if (event.target.closest("[data-step-caution]")) return;
  const actionButton = event.target.closest("[data-project-action]"); if (actionButton) { try { await performProjectAction(actionButton.dataset.projectAction); } catch (error) { showToast(error.message, true); } return; }
  const moveButton = event.target.closest("[data-move-step]");
  if (moveButton) {
    const project = activeProject(); const index = project.steps.findIndex((step) => step.id === moveButton.dataset.moveStep); const direction = moveButton.dataset.direction;
    const beforeStepId = direction === "up" ? project.steps[index - 1]?.id : project.steps[index + 2]?.id ?? null;
    try { updateFromPayload(await api(`/api/projects/${project.id}/steps/${moveButton.dataset.moveStep}/move`, { method: "POST", body: JSON.stringify({ beforeStepId }) })); } catch (error) { showToast(error.message, true); }
    return;
  }
  const subprocessButton = event.target.closest("[data-subprocess]");
  if (subprocessButton) { selectedSubprocessId = subprocessButton.dataset.subprocess; executionBlock = null; render(); return; }
  const debugRecordButton = event.target.closest("[data-debug-record]");
  if (debugRecordButton) { selectedDebugRecordId = debugRecordButton.dataset.debugRecord; render(); return; }
  const stepRow = event.target.closest("[data-step]"); if (stepRow) { selectedStepId = stepRow.dataset.step; selectedSubprocessId = null; selectedDebugRecordId = null; executionBlock = null; render(); return; }
  const project = activeProject();
  let startedAgentCall = false;
  try {
    if (busy && ["submit-goal", "retry-plan", "recover-project-execution", "recover-project-execution-inline", "retry-project-execution", "retry-project-execution-inline", "execute-step"].includes(event.target.id)) throw new Error("已有任务正在后台执行；你可以继续其他操作，或先暂停当前调用。");
    if (["recover-project-execution", "recover-project-execution-inline"].includes(event.target.id)) {
      if (!project) throw new Error("当前没有可恢复的项目。");
      startedAgentCall = true;
      setBusy(true, `正在重新校验已生成结果：${project.primaryArtifact?.filename || project.title}`, project.id, "execute");
      updateFromPayload(await api(`/api/projects/${project.id}/execution/recover`, { method: "POST", body: "{}" }));
      setBusy(false);
      startedAgentCall = false;
      showToast("已恢复生成结果，正在打开预览。");
      queueAutomaticWorkflow(project.id);
      return;
    }
    if (["retry-project-execution", "retry-project-execution-inline"].includes(event.target.id)) {
      if (!project) throw new Error("当前没有可重新执行的项目。");
      startedAgentCall = true;
      setBusy(true, `正在重新连续构建：${project.primaryArtifact?.filename || project.title}`, project.id, "execute");
      updateFromPayload(await api(`/api/projects/${project.id}/execute`, { method: "POST", body: JSON.stringify({ feedback: project.lastError || "重新连续执行项目" }) }));
      setBusy(false);
      startedAgentCall = false;
      queueAutomaticWorkflow(project.id);
      return;
    }
    if (event.target.id === "attach-files") return $("#attachment-input").click();
    if (event.target.id === "text-to-file") { const text = $("#goal-input").value; if (!text.trim()) throw new Error("输入框没有可转换的文本。"); await uploadFiles([new File([text], `粘贴文本-${Date.now()}.txt`, { type: "text/plain" })], "用户手动转换"); $("#goal-input").value = "请按附件中的完整需求执行。"; return; }
    const remove = event.target.closest("[data-remove-attachment]"); if (remove) { const draftText = $("#goal-input")?.value ?? ""; updateFromPayload(await api(`/api/attachments/${remove.dataset.removeAttachment}`, { method: "DELETE", body: "{}" })); if ($("#goal-input") && !$("#goal-input").readOnly) $("#goal-input").value = draftText; return; }
    const removeReference = event.target.closest("[data-remove-execution-reference]");
    if (removeReference) {
      if (!project) throw new Error("当前没有可删除参考的项目。");
      removeReference.disabled = true;
      updateFromPayload(await api(`/api/projects/${project.id}/references/${encodeURIComponent(removeReference.dataset.removeExecutionReference)}`, { method: "DELETE", body: "{}" }));
      showToast("执行参考已移除；原学习或探索内容仍保留。");
      return;
    }
    const restore = event.target.closest("[data-restore-attachment]"); if (restore) { const draftText = $("#goal-input")?.value ?? ""; const payload = await api(`/api/attachments/${restore.dataset.restoreAttachment}/text`); const removed = await api(`/api/attachments/${restore.dataset.restoreAttachment}`, { method: "DELETE", body: "{}" }); session.state = removed.state; render(); $("#goal-input").value = `${draftText ? `${draftText}\n` : ""}${payload.text}`; return; }
    if (["submit-goal", "retry-plan"].includes(event.target.id)) {
      const typedGoal = $("#goal-input").value.trim();
      const hasAttachments = (project?.attachments?.length ?? 0) + session.state.draftAttachments.length > 0;
      const goal = typedGoal || (hasAttachments ? "请按附件中的完整需求执行。" : "");
      if (!goal) throw new Error("请先输入目标或添加附件。");
      let targetProject = project;
      if (!targetProject) {
        const payload = await api("/api/projects", { method: "POST", body: JSON.stringify({ goal, attachmentIds: session.state.draftAttachments.map((item) => item.id) }) });
        updateFromPayload(payload);
        targetProject = activeProject();
      }
      startedAgentCall = true;
      setBusy(true, `${activeAgentLabel()} 正在判断并开始执行`, targetProject.id);
      updateFromPayload(await api(`/api/projects/${targetProject.id}/plan`, { method: "POST", body: JSON.stringify({ goal, attachmentIds: session.state.draftAttachments.map((item) => item.id) }) }));
      queueAutomaticWorkflow(targetProject.id);
    }
    if (event.target.id === "refresh-preview") { const frame = $("#artifact-preview"); if (frame) frame.src = `/preview/${encodeURIComponent(project.id)}/?refresh=${Date.now()}`; return; }
    if (event.target.id === "view-artifact-source") { $("#info-title").textContent = "产物源码"; $("#info-actions").innerHTML = ""; $("#info-content").innerHTML = `<pre class="artifact-content">${escapeHTML(project.artifact.content || "产物位于本机目录；内联源码为空。")}</pre>`; $("#info-dialog").showModal(); return; }
    if (event.target.id === "pause-inline-busy") { $("#pause-busy").click(); return; }
    if (event.target.id === "execute-step") {
      const step = project.steps.find((item) => item.id === selectedStepId);
      const subprocess = step.subprocesses?.find((item) => item.id === selectedSubprocessId);
      const preflight = await api(`/api/projects/${project.id}/steps/${step.id}/execute/preflight`, { method: "POST", body: JSON.stringify({ subprocessId: subprocess?.id ?? null }) });
      if (!preflight.readiness.allowed) {
        executionBlock = preflight.readiness;
        render();
        showToast(preflight.readiness.title, true);
        return;
      }
      executionBlock = null;
      if (highRisk(step) && !$("#risk-consent")?.checked) throw new Error("高风险步骤需要先阅读行为卡并明确同意。");
      startedAgentCall = true;
      setBusy(true, `正在执行：${step.title}${subprocess ? ` / ${subprocess.title}` : ""}`, project.id, "execute");
      updateFromPayload(await api(`/api/projects/${project.id}/steps/${step.id}/execute`, { method: "POST", body: JSON.stringify({ feedback: $("#execute-feedback")?.value ?? "", subprocessId: subprocess?.id ?? null }) }));
      queueAutomaticWorkflow(project.id);
    }
    if (event.target.id === "approve-step") { selectedSubprocessId = null; updateFromPayload(await api(`/api/projects/${project.id}/steps/${selectedStepId}/approve`, { method: "POST", body: "{}" })); showToast("已验收，自动执行将继续。"); queueAutomaticWorkflow(project.id); }
    if (["reject-step", "rerun-step"].includes(event.target.id)) { const feedback = $("#reject-feedback")?.value.trim() || (event.target.id === "rerun-step" ? "重新运行检查。" : ""); if (!feedback) throw new Error("请先说明需要修改的地方。"); selectedSubprocessId = null; updateFromPayload(await api(`/api/projects/${project.id}/steps/${selectedStepId}/reject`, { method: "POST", body: JSON.stringify({ feedback }) })); }
    if (event.target.id === "reopen-step") { selectedSubprocessId = null; updateFromPayload(await api(`/api/projects/${project.id}/steps/${selectedStepId}/reopen`, { method: "POST", body: JSON.stringify({ feedback: "用户重新打开已通过步骤。" }) })); }
    if (event.target.id === "rollback-step") { selectedSubprocessId = null; updateFromPayload(await api(`/api/projects/${project.id}/steps/${selectedStepId}/rollback`, { method: "POST", body: "{}" })); }
    if (event.target.id === "return-to-repair") { updateFromPayload(await api(`/api/projects/${project.id}/steps/${selectedStepId}/return-to-repair`, { method: "POST", body: JSON.stringify({ feedback: $("#reject-feedback")?.value ?? "" }) })); }
    if (event.target.id === "submit-debug-feedback") {
      const feedback = $("#debug-feedback")?.value.trim();
      if (!feedback) throw new Error("请先填写修改意见。");
      const payload = await api(`/api/projects/${project.id}/steps/${selectedStepId}/debug/${event.target.dataset.debugRecordId}`, { method: "POST", body: JSON.stringify({ feedback }) });
      selectedDebugRecordId = payload.record.id;
      updateFromPayload(payload);
      showToast(payload.repairQueued ? "修改意见已锁定到代码，正在自动返修。" : "修改意见已保存；继续任务后会自动返修。");
      if (payload.repairQueued) queueAutomaticWorkflow(project.id);
    }
  } catch (error) { showToast(error.message, true); await bootstrap().catch(() => {}); } finally { if (startedAgentCall) setBusy(false); }
});

$("#workspace").addEventListener("change", async (event) => {
  if (event.target.id === "learning-source-select") {
    learningUI.sourceId = event.target.value; learningUI.file = null; learningUI.materialId = null; learningUI.files = [];
    await loadSourceFiles(); return;
  }
  if (event.target.matches("[data-step-caution]")) {
    const project = activeProject();
    try {
      updateFromPayload(await api(`/api/projects/${project.id}/steps/${event.target.dataset.stepCaution}/caution`, { method: "POST", body: JSON.stringify({ cautionLevel: event.target.value }) }));
      showToast("节点谨慎等级已更新。");
    } catch (error) { render(); showToast(error.message, true); }
    return;
  }
  if (event.target.matches("[data-direction-option]")) {
    const project = activeProject();
    const stepId = event.target.dataset.directionOption;
    const key = directionDraftKey(project.id, stepId);
    const draft = directionDrafts.get(key) ?? { optionId: "", supplemental: "", answer: "" };
    directionDrafts.set(key, { ...draft, optionId: event.target.value });
    document.querySelector(`[data-submit-direction="${CSS.escape(stepId)}"]`)?.removeAttribute("disabled");
    return;
  }
  if (event.target.name !== "option") return;
  const project = activeProject();
  if (busy && busyProjectId === project?.id) {
    render();
    showToast("当前方案已经开始执行，本次改选未保存。请暂停或在结果返回后重新打开修改。", true);
    return;
  }
  try {
    executionBlock = null;
    updateFromPayload(await api(`/api/projects/${project.id}/steps/${selectedStepId}/select`, { method: "POST", body: JSON.stringify({ optionId: event.target.value, subprocessId: event.target.dataset.subprocessId || null }) }));
  } catch (error) {
    render();
    showToast(`方案未更改：${error.message}`, true);
  }
});
$("#workspace").addEventListener("input", (event) => {
  if (event.target.matches("[data-direction-supplement], [data-direction-answer]")) {
    const project = activeProject();
    const stepId = event.target.dataset.directionSupplement ?? event.target.dataset.directionAnswer;
    const key = directionDraftKey(project.id, stepId);
    const draft = directionDrafts.get(key) ?? { optionId: "", supplemental: "", answer: "" };
    directionDrafts.set(key, event.target.matches("[data-direction-supplement]") ? { ...draft, supplemental: event.target.value } : { ...draft, answer: event.target.value });
    return;
  }
  if (event.target.id === "source-filter") { learningUI.filter = event.target.value; render(); $("#source-filter")?.focus(); }
});
$("#workspace").addEventListener("submit", async (event) => {
  if (event.target.id === "github-learning-search") {
    event.preventDefault();
    const query = $("#github-learning-query")?.value.trim();
    if (!query) return showToast("请输入要搜索的 GitHub 仓库方向。", true);
    await searchLearningRepositories(query); return;
  }
  if (event.target.id === "learning-chat-form") {
    event.preventDefault();
    const question = $("#learning-question")?.value.trim();
    if (!question) return showToast("请输入你还没理解的问题。", true);
    await submitLearningQuestion(question);
  }
  if (event.target.id === "exploration-form") {
    event.preventDefault();
    const query = $("#exploration-query")?.value.trim();
    if (!query) return showToast("请输入要探索的问题。", true);
    await submitExploration(query);
  }
});
$("#workspace").addEventListener("mouseup", (event) => {
  if (appMode !== "learning" || learningUI.materialId || documentLearningModules.has(learningUI.module) || !event.target.closest("#source-code")) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
  const elementFor = (node) => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.("[data-line]");
  const anchor = elementFor(selection.anchorNode);
  const focus = elementFor(selection.focusNode);
  if (!anchor || !focus) return;
  const first = Number(anchor.dataset.line); const last = Number(focus.dataset.line);
  const rangeRect = selection.getRangeAt(0).getBoundingClientRect();
  const stageRect = event.target.closest("#learning-document-stage").getBoundingClientRect();
  const popupWidth = Math.min(520, Math.max(360, window.innerWidth * .3), window.innerWidth - 32);
  const right = rangeRect.right + 14;
  const x = right + popupWidth <= window.innerWidth - 16 ? right : Math.max(stageRect.left + 16, rangeRect.left - popupWidth - 14);
  const y = Math.max(stageRect.top + 16, rangeRect.top - 10);
  explainLearningSelection(Math.min(first, last), Math.max(first, last), x, y);
});
$("#workspace").addEventListener("contextmenu", (event) => {
  if (appMode !== "learning") return;
  const threadTab = event.target.closest("[data-learning-thread-tab]");
  if (!threadTab) return;
  event.preventDefault();
  openLearningThreadMenu(threadTab, event.clientX, event.clientY);
});
$("#workspace").addEventListener("keydown", (event) => {
  if (appMode !== "learning" || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
  const threadTab = event.target.closest("[data-learning-thread-tab]");
  if (!threadTab) return;
  event.preventDefault();
  const rect = threadTab.getBoundingClientRect();
  openLearningThreadMenu(threadTab, rect.left, rect.bottom + 6);
});
$("#workspace").addEventListener("dragstart", (event) => {
  if (event.target.closest("[data-remove-execution-reference]")) { event.preventDefault(); return; }
  const learningFile = event.target.closest("[data-learning-file]");
  if (learningFile) event.dataTransfer.setData("application/x-loopcanvas-learning-file", decodeURIComponent(learningFile.dataset.learningFile));
  const learningMaterial = event.target.closest("[data-learning-material]");
  if (learningMaterial) event.dataTransfer.setData("application/x-loopcanvas-learning-material", learningMaterial.dataset.learningMaterial);
  const transferable = event.target.closest("[data-transfer-reference]");
  if (transferable) {
    const reference = decodedTransferReference(transferable.dataset.transferReference);
    if (reference) {
      event.dataTransfer.setData("application/x-loopcanvas-reference", JSON.stringify(reference));
      event.dataTransfer.effectAllowed = "copy";
      document.body.classList.add("reference-dragging");
      $("#transfer-dock").setAttribute("aria-hidden", "false");
      setRemotePanel(true);
    }
  }
  const popup = event.target.closest("[data-learning-drag]");
  if (popup) event.dataTransfer.setData("application/x-loopcanvas-learning-thread", popup.dataset.learningDrag);
});
$("#workspace").addEventListener("dragend", () => {
  document.body.classList.remove("reference-dragging");
  $("#transfer-dock").setAttribute("aria-hidden", "true");
  document.querySelectorAll("[data-transfer-mode].drop-ready").forEach((target) => target.classList.remove("drop-ready"));
  document.querySelectorAll("[data-remote-device].drop-ready").forEach((target) => target.classList.remove("drop-ready"));
});
$("#workspace").addEventListener("dragover", (event) => {
  event.preventDefault();
  const documentStage = event.target.closest("#learning-document-stage");
  const fileShelf = event.target.closest("#learning-file-shelf");
  const types = [...(event.dataTransfer?.types ?? [])];
  if (documentStage && (types.includes("application/x-loopcanvas-learning-file") || types.includes("application/x-loopcanvas-learning-material"))) documentStage.classList.add("drop-ready");
  if (fileShelf && types.includes("application/x-loopcanvas-reference")) fileShelf.classList.add("drop-ready");
  const importDrop = event.target.closest("#learning-import-drop");
  if (appMode === "learning" && importDrop && [...(event.dataTransfer?.types ?? [])].includes("Files")) {
    event.dataTransfer.dropEffect = "copy";
    importDrop.classList.add("drop-ready");
  }
});
$("#workspace").addEventListener("dragleave", (event) => {
  const documentStage = event.target.closest("#learning-document-stage");
  if (documentStage && !documentStage.contains(event.relatedTarget)) documentStage.classList.remove("drop-ready");
  const fileShelf = event.target.closest("#learning-file-shelf");
  if (fileShelf && !fileShelf.contains(event.relatedTarget)) fileShelf.classList.remove("drop-ready");
  const importDrop = event.target.closest("#learning-import-drop");
  if (importDrop && !importDrop.contains(event.relatedTarget)) importDrop.classList.remove("drop-ready");
});
$("#workspace").addEventListener("drop", async (event) => {
  event.preventDefault();
  const documentStage = event.target.closest("#learning-document-stage");
  if (appMode === "learning" && documentStage) {
    documentStage.classList.remove("drop-ready");
    const rawFile = event.dataTransfer.getData("application/x-loopcanvas-learning-file");
    const materialId = event.dataTransfer.getData("application/x-loopcanvas-learning-material");
    if (rawFile) { try { const file = JSON.parse(rawFile); await openLearningFile(file.sourceId, file.filePath); } catch (error) { showToast(error.message, true); } return; }
    if (materialId) { try { openLearningMaterial(materialId); } catch (error) { showToast(error.message, true); } return; }
  }
  const fileShelf = event.target.closest("#learning-file-shelf");
  const shelfReference = event.dataTransfer.getData("application/x-loopcanvas-reference");
  if (appMode === "learning" && fileShelf && shelfReference) {
    fileShelf.classList.remove("drop-ready");
    try { await ingestLearningReference(JSON.parse(shelfReference)); } catch (error) { showToast(error.message, true); }
    return;
  }
  const importDrop = event.target.closest("#learning-import-drop");
  if (appMode === "learning" && importDrop && [...(event.dataTransfer?.types ?? [])].includes("Files")) {
    importDrop.classList.remove("drop-ready");
    try { await importLearningEntries(await droppedLearningEntries(event.dataTransfer)); } catch (error) { showToast(error.message, true); }
    return;
  }
  if (appMode === "learning" && event.target.closest("#learning-chat-drop")) {
    const threadId = event.dataTransfer.getData("application/x-loopcanvas-learning-thread");
    if (threadId) {
      const openedAnotherWindow = Boolean(learningUI.threadId && learningUI.threadId !== threadId);
      learningUI.threadId = threadId; learningUI.threadView = "active"; learningUI.threadMenu = null; learningUI.popup = null; render();
      showToast(openedAnotherWindow ? "已自动打开新的代码对话窗口，原窗口仍保留。" : "已打开代码对话窗口。");
    }
    return;
  }
  const rawReference = event.dataTransfer.getData("application/x-loopcanvas-reference");
  if (rawReference) return;
  if (appMode !== "workflow") return;
  if (activeProject()?.steps.length) return showToast("附件只能在需求输入阶段添加。", true);
  try { await uploadFiles([...event.dataTransfer.files], "拖放"); } catch (error) { showToast(error.message, true); }
});

$("#workspace").addEventListener("paste", async (event) => {
  if (event.target.id !== "goal-input") return;
  const images = [...(event.clipboardData?.items ?? [])].filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
  if (images.length) {
    event.preventDefault();
    try { await uploadFiles(images.map((file, index) => new File([file], `粘贴图片-${Date.now()}-${index + 1}.${file.type.split("/")[1] || "png"}`, { type: file.type })), "剪贴板图片"); showToast("剪贴板图片已暂存在本机。"); } catch (error) { showToast(error.message, true); }
    return;
  }
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (new TextEncoder().encode(text).length >= 8192 || text.split("\n").length >= 120) {
    event.preventDefault();
    const hadText = Boolean(event.target.value.trim());
    try {
      await uploadFiles([new File([text], `粘贴文本-${Date.now()}.txt`, { type: "text/plain" })], "自动识别长粘贴");
      if (!hadText && $("#goal-input")) $("#goal-input").value = "请按附件中的完整需求执行。";
      showToast("超长粘贴已自动转为本机附件，可随时放回输入框。");
    } catch (error) { showToast(error.message, true); }
  }
});

$("#workspace").addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && event.target.id === "goal-input") { event.preventDefault(); $("#submit-goal")?.click(); } });

$("#pause-busy").addEventListener("click", async () => { const projectId = busyProjectId; if (!projectId) return; try { updateFromPayload(await api(`/api/projects/${projectId}/pause`, { method: "POST", body: "{}" })); showToast("已请求暂停并取消本次 Agent 调用。"); showInfo("handoff"); } catch (error) { showToast(error.message, true); } });
document.querySelectorAll("[data-global-view]").forEach((button) => button.addEventListener("click", () => button.dataset.globalView === "capabilities" ? showCapabilities().catch((error) => showToast(error.message, true)) : showInfo(button.dataset.globalView)));
$("#close-info").addEventListener("click", () => $("#info-dialog").close()); $("#close-capability").addEventListener("click", () => $("#capability-dialog").close());

$("#info-dialog").addEventListener("click", async (event) => {
  const version = event.target.closest("[data-handoff-version]"); if (version) $("#handoff-text").textContent = activeProject().handoff[version.dataset.handoffVersion];
  if (event.target.id === "copy-handoff") { await navigator.clipboard.writeText($("#handoff-text").textContent); showToast("交接文本已复制。"); }
  if (event.target.id === "download-handoff") downloadText("dshwf-handoff.md", $("#handoff-text").textContent);
  const documentTab = event.target.closest("[data-project-doc]");
  if (documentTab) renderDocumentEditor(documentTab.dataset.projectDoc);
  if (event.target.id === "save-project-doc") {
    const project = activeProject();
    try {
      await api(`/api/projects/${project.id}/documents`, { method: "POST", body: JSON.stringify({ name: event.target.dataset.docName, content: $("#project-doc-editor").value }) });
      showToast("项目规则已保存，下次 Agent 调用会注入。");
      loadProjectDocuments().catch(() => {});
    } catch (error) { showToast(error.message, true); }
  }
  if (event.target.id === "save-project-workspace") {
    const project = activeProject();
    try {
      const payload = await api(`/api/projects/${project.id}/workspace`, { method: "POST", body: JSON.stringify({ workspace: $("#project-workspace-input").value }) });
      session.state = payload.state;
      render();
      showToast("工作目录已保存。");
    } catch (error) { showToast(error.message, true); }
  }
  const checkpointRestore = event.target.closest("[data-restore-checkpoint]");
  if (checkpointRestore) {
    const project = activeProject();
    const checkpoint = project?.checkpoints?.find((item) => item.id === checkpointRestore.dataset.restoreCheckpoint);
    if (!project || !checkpoint) return showToast("检查点不存在或状态已经改变。", true);
    if (!confirm(`回退到“${checkpoint.reason}”？\n\n只恢复 LoopCanvas 工作流状态，不会自动还原工作目录里的文件。本次回退不会新建、删除或消耗任何检查点。`)) return;
    checkpointRestore.disabled = true;
    try {
      updateFromPayload(await api(`/api/projects/${project.id}/checkpoints/restore`, { method: "POST", body: JSON.stringify({ checkpointId: checkpoint.id }) }));
      $("#info-dialog").close();
      showToast(`已回退到“${checkpoint.reason}”；未创建新检查点，已有坐标仍可反复使用。`);
    } catch (error) { checkpointRestore.disabled = false; showToast(error.message, true); }
  }
  const conversationView = event.target.closest("[data-conversation-view]");
  if (conversationView) showConversationRecord(conversationView.dataset.conversationView).catch((error) => showToast(error.message, true));
  if (event.target.id === "back-conversations") loadConversationList().catch((error) => showToast(error.message, true));
  if (event.target.id === "download-conversation") {
    const project = activeProject();
    try {
      const payload = await api(`/api/projects/${project.id}/conversations/${encodeURIComponent(event.target.dataset.conversationFile)}`);
      downloadText(event.target.dataset.conversationFile, JSON.stringify(payload.record, null, 2));
    } catch (error) { showToast(error.message, true); }
  }
});

document.querySelectorAll("[data-capability]").forEach((button) => button.addEventListener("click", () => showCapabilities(button.dataset.capability).catch((error) => showToast(error.message, true))));
$("#capability-content").addEventListener("click", async (event) => {
  const item = event.target.closest("[data-capability-item]"); if (item) { const selected = capabilityItems[Number(item.dataset.capabilityItem)]; $("#capability-detail").textContent = selected.detail != null ? `${selected.path}\n\n${selected.detail}` : JSON.stringify(selected, null, 2); }
  if (event.target.id === "reload-agents") await showCapabilities("agents");
  if (event.target.id === "save-agents") { try { const payload = await api("/api/capabilities/agents", { method: "POST", body: JSON.stringify({ path: event.target.dataset.path, content: $("#agents-editor").value }) }); $("#agents-editor").value = payload.document.content; showToast("AGENTS.md 已保存。"); } catch (error) { showToast(error.message, true); } }
  const action = event.target.closest("[data-plugin-sync]");
  if (action) {
    const item = pluginCatalogItems.find((candidate) => candidate.id === action.dataset.pluginSync);
    if (!item?.runtime.supported) return;
    const enabled = action.dataset.enabled === "true";
    if (enabled) return showPluginEnableConfirmation(item);
    try {
      await api(`/api/plugins/${encodeURIComponent(item.id)}`, { method: "POST", body: JSON.stringify({ enabled: false }) });
      await loadPluginsTab();
      showToast(`插件「${item.manifest.name}」已同步关闭。`);
    } catch (error) { showToast(error.message, true); }
  }
});

$("#close-plugin-confirm").addEventListener("click", closePluginEnableConfirmation);
$("#cancel-plugin-confirm").addEventListener("click", closePluginEnableConfirmation);
$("#confirm-plugin-enable").addEventListener("click", async () => {
  const item = pendingPluginEnable;
  if (!item) return;
  const button = $("#confirm-plugin-enable");
  button.disabled = true;
  try {
    await api(`/api/plugins/${encodeURIComponent(item.id)}`, { method: "POST", body: JSON.stringify({ enabled: true, confirmed: true }) });
    closePluginEnableConfirmation();
    await loadPluginsTab();
    showToast(`插件「${item.manifest.name}」已同步开启。`);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});

$("#setting-runtime").addEventListener("change", () => { renderRuntimeSettings(); if ($("#setting-runtime").value === "codex") loadCodexModels().catch(() => {}); });
$("#setting-codex-model").addEventListener("change", () => renderCodexEfforts());
$("#settings-form").addEventListener("submit", async (event) => { if (event.submitter?.value !== "save") return; event.preventDefault(); try { const payload = await api("/api/settings", { method: "POST", body: JSON.stringify({ agentRuntime: $("#setting-runtime").value, dshPath: $("#setting-dsh").value, workspace: $("#setting-workspace").value, model: $("#setting-model").value, reasoningEffort: $("#setting-effort").value, cautionLevel: $("#setting-caution").value, codexModel: $("#setting-codex-model").value, codexReasoningEffort: $("#setting-codex-effort").value }) }); session.state.settings = payload.settings; session.installation = payload.installation; $("#settings-dialog").close(); render(); showToast(`执行引擎已切换为 ${payload.settings.agentRuntime === "codex" ? "Codex App Server" : "DeepSeek Harness"}；谨慎等级为${cautionLabel(payload.settings.cautionLevel)}。`); } catch (error) { showToast(error.message, true); } });
$("#probe-local-agents").addEventListener("click", async () => { const button = $("#probe-local-agents"); const result = $("#probe-result"); button.disabled = true; result.textContent = "正在检测 dsh 与 Codex……"; try { const payload = await api("/api/agents/probe", { method: "POST", body: JSON.stringify({ dshPath: $("#setting-dsh").value }) }); session.installation = payload.installation; renderHarness(); renderInstallationGuide(); const verified = [payload.installation.dsh, payload.installation.codex].filter((agent) => agent?.ready).length; result.textContent = `检测完成：${verified}/2 个运行时能力已验证`; if (payload.installation.codex?.ready) loadCodexModels(true).catch(() => {}); } catch (error) { result.textContent = error.message === "接口不存在。" ? "服务版本较旧，请重启 LoopCanvas Web 后重试。" : error.message; } finally { button.disabled = false; } });
$("#settings-dialog").addEventListener("click", async (event) => { if (event.target.id !== "copy-install-command") return; try { await navigator.clipboard.writeText("npx @deepseek-ai/dsh web"); showToast("安装命令已复制；请由你本人在终端粘贴并执行。"); } catch { showToast("复制失败，请手动选择命令文本。", true); } });

bootstrap().catch((error) => { $("#workspace").innerHTML = `<section class="card error-card">DSH Workflow Web 启动失败：${escapeHTML(error.message)}</section>`; });
