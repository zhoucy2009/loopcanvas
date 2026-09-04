/** Reject stale snapshots and keep navigation local to the user's current tab. */
export function reconcileProjectState(current, incoming, { activate = false } = {}) {
  if (!incoming) return current;
  if (!current) return incoming;
  if (Number(incoming.stateRevision ?? 0) < Number(current.stateRevision ?? 0)) return current;
  const keepSelection = !activate && incoming.projects?.some((project) => project.id === current.activeProjectId);
  return { ...incoming, activeProjectId: keepSelection ? current.activeProjectId : incoming.activeProjectId };
}

export class ProjectDrafts {
  constructor(storage = null) { this.storage = storage; this.values = new Map(); }
  key(projectId, field) { return `loopcanvas:draft:${projectId || "new"}:${field}`; }
  get(projectId, field, fallback = "") {
    const key = this.key(projectId, field);
    if (this.values.has(key)) return this.values.get(key);
    try { return this.storage?.getItem(key) ?? fallback; } catch { return fallback; }
  }
  set(projectId, field, value) {
    const key = this.key(projectId, field);
    this.values.set(key, String(value));
    try { this.storage?.setItem(key, String(value)); } catch { /* In-memory drafts still work. */ }
  }
}

export function ownsProjectView(projectId, currentProjectId, frame = null, currentFrame = frame) {
  return projectId === currentProjectId && (!frame || (frame === currentFrame && frame.isConnected));
}
