const roles = new Set(["plan", "execute", "review", "new_request", "gather"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// In-memory, short-lived, one-shot handoffs. Never store microphone audio.
export class VoiceWakeBroker {
  constructor({ now = Date.now, ttl = 120_000, limit = 64 } = {}) {
    this.now = now; this.ttl = ttl; this.limit = limit; this.events = new Map();
  }
  prune() {
    for (const [id, event] of this.events) if (event.expiresAt <= this.now()) this.events.delete(id);
  }
  create({ id, role }, project) {
    if (!uuid.test(String(id)) || !roles.has(role)) throw new Error("无效的后台唤醒事件。");
    this.prune();
    const existing = this.events.get(id);
    if (existing) {
      if (existing.role !== role) throw new Error("唤醒编号与角色不一致。");
      return { id: existing.id };
    }
    if (this.events.size >= this.limit) throw new Error("后台唤醒过于频繁，请稍后再试。");
    const selected = project?.steps?.find((s) => s.id === project.selectedStepId);
    const step = role === "review"
      ? (selected?.result ? selected : [...(project?.steps ?? [])].reverse().find((s) => s.result))
      : (selected && ["ready", "error"].includes(selected.status) ? selected : project?.steps?.find((s) => ["ready", "error"].includes(s.status)));
    this.events.set(id, { id, role, projectId: project?.id ?? null, stepId: step?.id ?? null, claimed: false, expiresAt: this.now() + this.ttl });
    return { id };
  }
  claim(id) {
    this.prune();
    const event = this.events.get(id);
    if (!event || event.claimed) throw new Error("唤醒已处理或已过期，请重新说出唤醒词。");
    event.claimed = true;
    return { id: event.id, role: event.role, projectId: event.projectId, stepId: event.stepId };
  }
}
