import { randomUUID } from "node:crypto";

// Track the lifetime of actual runner calls, not inferred progress or a timer.
export class AgentPresence {
  constructor() { this.calls = new Map(); }
  wrap(role, runner) {
    return async (...args) => {
      const input = args[0];
      const project = input?.project ?? input;
      const id = randomUUID();
      this.calls.set(id, { id, role, projectId: project?.id ?? null, startedAt: Date.now() });
      try { return await runner(...args); }
      finally { this.calls.delete(id); }
    };
  }
  snapshot() { return { calls: [...this.calls.values()] }; }
}
