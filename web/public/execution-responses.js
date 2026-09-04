import { t, ui } from "./i18n.js";
// Reconcile a delayed HTTP response using read-only, authoritative server state.
// Never restart a run, cancel the server, or let an old response settle a newer run.
export class ExecutionResponses {
  constructor() { this.pending = new Map(); }

  track(projectId, project, response) {
    const entry = { updatedAt: project?.updatedAt, actionAt: project?.pendingAction?.createdAt, seenActive: false };
    const recovered = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
    this.pending.set(projectId, entry);
    return Promise.race([response, recovered]).finally(() => {
      if (this.pending.get(projectId) === entry) this.pending.delete(projectId);
    });
  }

  observe(projectId, active) {
    const entry = this.pending.get(projectId);
    if (entry && active) entry.seenActive = true;
    return entry;
  }

  reconcile(projectId, entry, state) {
    if (!entry || this.pending.get(projectId) !== entry) return false;
    const project = state.projects.find((item) => item.id === projectId);
    if (!project || project.busy !== false || project.pendingAction?.status === "running"
      || project.executionRun?.status === "running" || project.steps?.some((step) => step.status === "running")) return false;
    // An idle poll can arrive before the new POST reaches the server.
    if (!entry.seenActive && project.updatedAt === entry.updatedAt && project.pendingAction?.createdAt === entry.actionAt) return false;
    const failed = ["failed", "cancelled"].includes(project.pendingAction?.status)
      || ["failed", "cancelled"].includes(project.executionRun?.status);
    if (failed) {
      const error = new Error(project.lastError || project.pendingAction?.error || project.executionRun?.error || t("执行已结束，但未成功完成。"));
      error.state = state;
      entry.reject(error);
    } else entry.resolve({ state });
    return true;
  }
}

export function settledRuntimeActivity(project, fallback = t("执行已结束")) {
  const error = project?.lastError || project?.pendingAction?.error || project?.executionRun?.error;
  if (project?.isPaused || project?.executionRun?.status === "cancelled" || project?.pendingAction?.status === "cancelled") return t("执行已暂停");
  if (error) return ui`执行失败：${error}`;
  if (project?.phase === "complete") return t("全部节点已验证并交付");
  if (project?.executionRun?.status === "awaiting_direction") return t("等待目标方向答复");
  if (project?.executionRun?.status === "awaiting_parallel_choice") return t("等待并行方式选择");
  return fallback;
}

export function nodeRuntimeState(project, step, runtime) {
  const live = runtime?.projectId === project.id && runtime?.stepId === step.id ? runtime : null;
  // Bootstrap is authoritative even before the first runtime poll, and a
  // project-level stream may currently point at another parallel node.
  const running = step.status === "running" && project.busy === true;
  return { running, interrupted: step.status === "running" && project.busy === false, live };
}

export function runtimeActivityText(runtime, now = Date.now()) {
  const activity = runtime?.activity === "Codex 正在分析当前子进程"
    ? t("Codex 正在处理当前节点") : runtime?.activity || t("正在执行，等待节点活动");
  const timestamp = Date.parse(runtime?.updatedAt);
  if (!runtime?.active || !Number.isFinite(timestamp)) return activity;
  const age = Math.max(0, Math.floor((now - timestamp) / 1000));
  return `${activity} · ${age < 90 ? ui`最近事件 ${age} 秒前` : ui`${age} 秒未收到新事件`}`;
}
