// Search pages own their request state; selection never owns an in-flight request.
export class ExplorationTabs {
  constructor() {
    this.tabs = [];
    this.selected = new Map();
  }

  list(scope) { return this.tabs.filter((tab) => tab.scope === scope); }

  active(scope) {
    return this.list(scope).find((tab) => tab.id === this.selected.get(scope))
      ?? this.open(scope);
  }

  open(scope, kind = "research", thread = null) {
    const existing = thread && this.list(scope).find((tab) => tab.threadId === thread.id);
    if (existing) return this.select(existing.id);
    const tab = {
      id: crypto.randomUUID(), scope, kind: thread?.kind === "art" ? "art" : kind,
      threadId: thread?.id ?? null, title: thread?.title ?? "", draft: "",
      busy: false, error: "", pendingQuery: "", unread: false, scrollTop: 0
    };
    this.tabs.push(tab);
    return this.select(tab.id);
  }

  select(id) {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab) return null;
    this.selected.set(tab.scope, id);
    tab.unread = false;
    return tab;
  }

  selectKind(scope, kind) {
    const current = this.active(scope);
    return current.kind === kind ? current
      : this.select(this.list(scope).findLast((tab) => tab.kind === kind)?.id) ?? this.open(scope, kind);
  }

  close(id) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return false;
    const tab = this.tabs[index];
    // Running pages remain reachable until their result has arrived.
    if (tab.busy) return false;
    const siblings = this.list(tab.scope);
    const position = siblings.indexOf(tab);
    this.tabs.splice(index, 1);
    if (this.selected.get(tab.scope) === id) {
      const next = siblings[position + 1] ?? siblings[position - 1];
      if (next) this.select(next.id);
      else this.open(tab.scope, tab.kind);
    }
    return true;
  }

  begin(tab, query) {
    if (tab.busy) return false;
    tab.busy = true;
    tab.error = "";
    tab.pendingQuery = query;
    tab.draft = "";
    tab.title ||= query.slice(0, 56);
    return true;
  }

  complete(tab, thread) {
    tab.threadId = thread.id;
    tab.title = thread.title;
    tab.kind = thread.kind === "art" ? "art" : "research";
    tab.busy = false;
    tab.pendingQuery = "";
    tab.unread = this.selected.get(tab.scope) !== tab.id;
  }

  fail(tab, error) {
    tab.busy = false;
    tab.error = error;
    tab.draft ||= tab.pendingQuery;
    tab.pendingQuery = "";
  }
}
