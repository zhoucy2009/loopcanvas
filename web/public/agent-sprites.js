import { t, ui, localizeStatic } from "./i18n.js";
export const spriteRoles = ["intake", "plan", "execute", "review"];
export const spriteLabels = { intake: "接收需求", plan: "计划", execute: "执行", review: "审核" };

export function spriteOperation(route, method) {
  if (method !== "POST") return null;
  const match = route.match(/^\/api\/projects\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, projectId, action] = match;
  const role = action === "plan" ? "plan"
    : /^(?:run|execute|steps\/[^/]+\/execute)$/.test(action) ? "execute"
    : /^(?:final-review|steps\/[^/]+\/agent-review)$/.test(action) ? "review" : null;
  return role ? { role, projectId } : null;
}

export class SpriteOccupancy {
  constructor() { this.local = new Map(); this.remote = []; this.sequence = 0; }
  begin(role, projectId = null) {
    const id = `local-${++this.sequence}`;
    this.local.set(id, { id, role, projectId });
    return () => this.local.delete(id);
  }
  sync(calls) { this.remote = calls.filter((call) => spriteRoles.includes(call.role)); }
  counts(projectId) {
    const counts = Object.fromEntries(spriteRoles.map((role) => [role, 0]));
    // An unbound/new view is empty, never an aggregate of other projects.
    if (!projectId) return counts;
    const remoteCalls = this.remote.filter((call) => call.projectId === projectId);
    for (const call of remoteCalls) counts[call.role]++;
    for (const call of this.local.values()) {
      if (call.projectId !== projectId) continue;
      // Server runner roles supersede a coarse local /run request, e.g. during review.
      if (call.role !== "intake" && remoteCalls.length) continue;
      counts[call.role]++;
    }
    return counts;
  }
}

// Stable DOM: spirits are never recreated when the workspace re-renders.
export class AgentSprites {
  constructor(root, { localize = localizeStatic, reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches } = {}) {
    this.root = root; this.reducedMotion = reducedMotion; this.projectId = null;
    this.occupancy = new SpriteOccupancy(); this.animations = new Map(); this.targets = new Map(); this.connected = false;
    this.states = new Map(spriteRoles.map((role) => [role, "pod"]));
    const slots = (zone) => spriteRoles.map((role) => `<div class="sprite-slot" data-slot="${zone}-${role}"><span>${spriteLabels[role]}</span></div>`).join("");
    root.innerHTML = `<section class="agent-capsule" aria-label="Agent 待命胶囊"><header><span>AGENT TEAM <small>待命胶囊</small></span><button type="button" id="gather-agents" title="召集空闲精灵，不中断正在运行的任务">集合</button></header><div class="capsule-body">${slots("pod")}</div></section>
      <section class="agent-work-zone" aria-label="Agent 执行区"><header><strong>执行区</strong><span data-sprite-summary role="status" aria-live="polite">四位精灵已就位</span></header></section>
      <div class="sprite-flight-layer" aria-hidden="true">${spriteRoles.map((role) => `<div class="workspace-spirit-border sprite-${role}" data-border="${role}"></div>`).join("")}${spriteRoles.map((role) => `<div class="agent-sprite sprite-${role}" data-spirit="${role}"><svg viewBox="0 0 48 48"><path class="sprite-body" d="M10 39C3 32 5 11 18 7C30 1 42 12 42 27C42 42 32 43 24 41C18 44 13 43 10 39Z"/><path class="sprite-glint" d="M13 18c1-4 4-6 7-7"/><path class="sprite-eyes" d="M19 21v7m12-7v7"/><path class="sprite-feet" d="M14 41l-3 3m22-3 3 3"/></svg><span class="sprite-deepseek" aria-hidden="true"></span></div>`).join("")}</div>`;
    localize(root);
    root.querySelector("#gather-agents").addEventListener("click", () => this.gather());
    this.resize = () => { this.layout(false); };
    this.observer = new ResizeObserver(this.resize); this.observer.observe(root);
    this.workspace = document.querySelector("#workspace, .workspace");
    if (this.workspace) this.observer.observe(this.workspace);
    window.addEventListener("resize", this.resize);
    window.addEventListener("scroll", this.resize, { passive: true, capture: true });
    document.addEventListener("visibilitychange", () => this.layout(false));
    this.layout(false);
  }
  setHarness(runtime) {
    // Only swap the artwork. Occupancy, flights and role colours remain intact.
    this.root.classList.toggle("deepseek-sprites", runtime === "dsh" || runtime === "deepseek");
  }
  setProject(projectId) {
    projectId ??= null;
    if (this.projectId === projectId) return;
    this.projectId = projectId;
    // Navigation shows another team's positions, not the previous team's return flight.
    // Removing handles also invalidates completion callbacks from the old project.
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
    this.render(false);
  }
  begin(role, projectId) {
    const finish = this.occupancy.begin(role, projectId);
    this.render();
    return () => { finish(); this.render(); };
  }
  handoff(projectId) {
    const finish = this.begin("intake", projectId);
    // Intake hands the submitted prompt to the request; it does not occupy a model call.
    queueMicrotask(finish);
  }
  sync(calls) { this.connected = true; this.occupancy.sync(calls); this.render(); }
  offline(message = t("连接中断 · 保留最后工作状态")) { this.connected = false; this.root.querySelector("[data-sprite-summary]").textContent = message; }
  render(animate = true) {
    this.root.classList.toggle("sprites-paused", document.hidden || this.reducedMotion());
    const counts = this.occupancy.counts(this.projectId);
    const active = spriteRoles.filter((role) => counts[role]);
    this.root.querySelector("[data-sprite-summary]").textContent = active.length
      ? active.map((role) => `${t(spriteLabels[role])}${counts[role] > 1 ? ` ×${counts[role]}` : ""}`).join(" · ") + t(" 工作中")
      : t("已归队 · 等待下一次调用");
    for (const role of spriteRoles) {
      const target = counts[role] ? "work" : "pod";
      this.targets.set(role, target);
      this.root.querySelector(`[data-slot="pod-${role}"]`).classList.toggle("away", Boolean(counts[role]));
      this.move(role, target, false, animate);
    }
  }
  workRect() {
    const rect = this.workspace?.getBoundingClientRect();
    if (!rect) return null;
    // Use the real surface bounds: scrolling must never create a floating crossbar.
    return { left: rect.left, top: rect.top, width: rect.width, height: Math.max(0, rect.bottom - rect.top) };
  }

  point(role, zone) {
    const rect = zone === "work" ? this.workRect() : null;
    if (rect) {
      const inset = -(3 + spriteRoles.indexOf(role) * 3);
      return { x: rect.left + rect.width - 44 - inset, y: rect.top + inset - 22 };
    }
    const slot = this.root.querySelector(`[data-slot="pod-${role}"]`).getBoundingClientRect();
    return { x: slot.left + slot.width / 2 - 22, y: slot.top + 1 };
  }
  appearance(role, target, attached) {
    const node = this.root.querySelector(`[data-spirit="${role}"]`);
    const border = this.root.querySelector(`[data-border="${role}"]`);
    node.dataset.zone = target;
    node.style.opacity = attached ? "0" : "1";
    const rect = this.workRect();
    const inset = -(3 + spriteRoles.indexOf(role) * 3);
    const toolbar = document.querySelector(".main-area > .topbar")?.getBoundingClientRect();
    const footer = document.querySelector(".runtime-footer")?.getBoundingClientRect();
    if (rect) Object.assign(border.style, {
      // Clip behind sticky chrome without moving the border onto scrolled content.
      clipPath: `inset(${Math.max(0, (toolbar?.bottom ?? 0) - rect.top - inset)}px 0 ${Math.max(0, rect.top + rect.height - inset - Math.min(innerHeight, footer?.top ?? innerHeight))}px 0)`,
      left: `${rect.left + inset}px`, top: `${rect.top + inset}px`,
      width: `${Math.max(0, rect.width - inset * 2)}px`, height: `${Math.max(0, rect.height - inset * 2)}px`
    });
    border.classList.toggle("attached", attached && Boolean(rect?.height));
  }
  move(role, target, gather = false, animate = true) {
    if (this.animations.has(role)) return; // Finish a jump before processing a quick handoff/return.
    const node = this.root.querySelector(`[data-spirit="${role}"]`);
    const previous = this.states.get(role);
    const end = this.point(role, target);
    const changed = previous !== target || gather;
    const start = gather ? { x: Math.min(innerWidth - 46, end.x + 100 + spriteRoles.indexOf(role) * 16), y: end.y - 6 }
      : { x: Number(node.dataset.x ?? end.x), y: Number(node.dataset.y ?? end.y) };
    this.states.set(role, target);
    node.dataset.x = end.x; node.dataset.y = end.y;
    node.style.transform = `translate(${end.x}px, ${end.y}px)`;
    const shouldAnimate = changed && animate && !document.hidden;
    this.appearance(role, target, target === "work" && !shouldAnimate);
    if (!shouldAnimate) return;
    const reduced = this.reducedMotion();
    const frames = reduced ? [{ opacity: target === "work" ? 1 : .35 }, { opacity: target === "work" ? 0 : 1 }] : gather
      ? [0, .2, .4, .6, .8, 1].map((fraction, i) => ({
        transform: `translate(${start.x + (end.x - start.x) * fraction}px, ${end.y - (i % 2 ? 0 : 4)}px) rotate(${fraction === 1 ? 0 : i % 2 ? 8 : -8}deg)`,
        opacity: fraction === 0 ? .15 : 1, offset: fraction
      })) : [
      { transform: `translate(${start.x}px, ${start.y}px) scale(${previous === "work" ? .15 : 1})`, opacity: previous === "work" ? 0 : 1 },
      { transform: `translate(${start.x + (end.x - start.x) * .6}px, ${start.y + (end.y - start.y) * .35}px) rotate(-8deg)`, opacity: 1, offset: .5 },
      { transform: `translate(${end.x}px, ${end.y}px) scale(1)`, opacity: 1, offset: .8 },
      { transform: `translate(${end.x}px, ${end.y}px) scale(${target === "work" ? .12 : 1})`, opacity: target === "work" ? 0 : 1 }
    ];
    const animation = node.animate(frames, { duration: reduced ? 100 : gather ? 480 : 560, easing: "cubic-bezier(.22,.65,.3,1)" });
    this.animations.set(role, animation);
    animation.finished.catch(() => {}).then(() => {
      if (this.animations.get(role) !== animation) return;
      this.animations.delete(role);
      this.move(role, this.targets.get(role) ?? target);
    });
  }
  gather() {
    if (!this.connected) { this.root.querySelector("[data-sprite-summary]").textContent = t("正在确认工作状态 · 暂不召回"); return; }
    const counts = this.occupancy.counts(this.projectId);
    for (const role of spriteRoles) {
      if (counts[role]) continue;
      this.animations.get(role)?.cancel(); this.animations.delete(role);
      this.targets.set(role, "pod"); this.move(role, "pod", true);
    }
    this.root.querySelector("[data-sprite-summary]").textContent = spriteRoles.some((role) => counts[role])
      ? t("空闲精灵集合 · 工作中的精灵不受影响") : t("四位精灵集合 · 准备接收新需求");
  }
  layout(animate = false) {
    this.root.classList.toggle("sprites-paused", document.hidden || this.reducedMotion());
    for (const role of spriteRoles) {
      this.animations.get(role)?.cancel(); this.animations.delete(role);
      this.move(role, this.targets.get(role) ?? "pod", false, animate);
    }
  }
}
