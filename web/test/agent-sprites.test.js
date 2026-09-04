import test from "node:test";
import assert from "node:assert/strict";
import { AgentPresence } from "../src/agent-presence.js";
import { AgentSprites, SpriteOccupancy, spriteOperation } from "../public/agent-sprites.js";

test("精灵只跟踪真实操作，不把验收、轮询或预览误当审核 Agent", () => {
  assert.equal(spriteOperation("/api/projects/p/plan", "POST").role, "plan");
  assert.equal(spriteOperation("/api/projects/p/run", "POST").role, "execute");
  assert.equal(spriteOperation("/api/projects/p/steps/s/agent-review", "POST").role, "review");
  assert.equal(spriteOperation("/api/projects/p/final-review", "POST").role, "review");
  assert.equal(spriteOperation("/api/projects/p/steps/s/approve", "POST"), null);
  assert.equal(spriteOperation("/api/projects/p/runtime", "GET"), null);
});

test("同色精灵等待最后一份工作，紫色交接结束独立归队", () => {
  const state = new SpriteOccupancy();
  const end1 = state.begin("execute", "p1"), end2 = state.begin("execute", "p1");
  const other = state.begin("execute", "p2");
  const intake = state.begin("intake", "p1");
  assert.equal(state.counts("p1").execute, 2);
  assert.equal(state.counts("p2").execute, 1);
  intake(); end1(); end1();
  assert.equal(state.counts("p1").execute, 1);
  assert.equal(state.counts("p1").intake, 0);
  end2();
  assert.equal(state.counts("p1").execute, 0);
  assert.equal(state.counts("p2").execute, 1);
  other();
  assert.equal(state.counts("p2").execute, 0);
});

test("真实并行执行与审核同时展示，远端状态覆盖粗粒度本地执行请求", () => {
  const state = new SpriteOccupancy();
  state.begin("execute", "p1");
  state.sync([{ role: "review", projectId: "p1" }, { role: "execute", projectId: "p1" }, { role: "plan", projectId: "p2" }]);
  assert.deepEqual(state.counts("p1"), { intake: 0, plan: 0, execute: 1, review: 1 });
  assert.deepEqual(state.counts("p2"), { intake: 0, plan: 1, execute: 0, review: 0 });
  const idle = { intake: 0, plan: 0, execute: 0, review: 0 };
  assert.deepEqual(state.counts("new"), idle);
  assert.deepEqual(state.counts(null), idle);
  assert.deepEqual(state.counts(), idle);
});

test("后端在每个 runner 开始登记，成功或抛错都释放自己的工作", async () => {
  const presence = new AgentPresence();
  let release1, release2;
  const run = presence.wrap("execute", (project) => new Promise((resolve, reject) => {
    if (project.id === "p1") release1 = resolve; else release2 = reject;
  }));
  const first = run({ id: "p1" }), second = run({ id: "p2" });
  assert.equal(presence.snapshot().calls.length, 2);
  release1("done"); await first;
  assert.deepEqual(presence.snapshot().calls.map((call) => call.projectId), ["p2"]);
  release2(new Error("cancelled")); await assert.rejects(second, /cancelled/);
  assert.equal(presence.snapshot().calls.length, 0);
});

function spriteFixture(t, reducedMotion = false) {
  const nodes = new Map(), flights = [];
  const node = (key) => {
    if (!nodes.has(key)) nodes.set(key, {
      dataset: {}, style: {}, classList: { toggle() {} }, addEventListener() {},
      getBoundingClientRect: () => ({ left: key.includes("work") ? 30 : 600, top: 40, width: 60 }),
      animate(frames, options) {
        let finish;
        const finished = new Promise((resolve) => { finish = resolve; });
        const animation = { finished, cancel: finish };
        flights.push({ key, frames, options, finish });
        return animation;
      }
    });
    return nodes.get(key);
  };
  const globals = { window: { addEventListener() {} }, document: { hidden: false, addEventListener() {} }, innerWidth: 1280, ResizeObserver: class { observe() {} } };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  t.after(() => { for (const key of Object.keys(globals)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else delete globalThis[key]; } });
  const stage = new AgentSprites({ querySelector: node }, { localize: () => {}, reducedMotion: () => reducedMotion });
  return { stage, flights, nodes };
}

test("同一工作刷新不重复跳入，快速交接先完成入场再归队", async (t) => {
  const { stage, flights } = spriteFixture(t);
  stage.setProject("p1");
  stage.sync([{ role: "execute", projectId: "p1" }]);
  const count = flights.length;
  stage.sync([{ role: "execute", projectId: "p1" }]);
  assert.equal(flights.length, count);
  stage.gather();
  assert.equal(flights.filter((flight) => flight.key.includes('spirit="execute"')).length, 1);
  for (const flight of flights) flight.finish();
  await Promise.resolve(); await Promise.resolve();
  stage.handoff("p1");
  await Promise.resolve();
  assert.equal(stage.states.get("intake"), "work");
  const intake = flights.findLast((flight) => flight.key.includes('spirit="intake"'));
  intake.finish(); await Promise.resolve(); await Promise.resolve();
  assert.equal(stage.states.get("intake"), "pod");
});

test("减少动态效果只淡入", (t) => {
  const { stage, flights } = spriteFixture(t, true);
  stage.setProject("p1");
  stage.sync([{ role: "review", projectId: "p1" }]);
  const fade = flights.at(-1);
  assert.equal(fade.options.duration, 100);
  assert.ok(fade.frames.every((frame) => !Object.hasOwn(frame, "transform")));
});

test("执行中开新需求：四个精灵独立归胶囊，旧动画与轮询不串任务", async (t) => {
  const { stage, flights } = spriteFixture(t);
  stage.setProject("p1");
  const oldFinish = stage.begin("execute", "p1");
  const calls = [{ role: "execute", projectId: "p1" }];
  stage.sync(calls);
  assert.equal(stage.states.get("execute"), "work");
  const oldFlight = flights.at(-1);
  const flightCount = flights.length;
  stage.setProject("p2");
  assert.equal(flights.length, flightCount, "切换任务不播放旧精灵归队动画");
  assert.ok([...stage.states.values()].every((state) => state === "pod"));
  stage.gather();
  assert.equal(flights.length, flightCount + 4, "新任务四个精灵一起集合");
  oldFlight.finish(); oldFinish();
  stage.sync(calls);
  await Promise.resolve(); await Promise.resolve();
  assert.ok([...stage.targets.values()].every((state) => state === "pod"));
  assert.ok([...stage.states.values()].every((state) => state === "pod"));
  const beforeSwitch = flights.length;
  stage.setProject("p1");
  assert.equal(stage.states.get("execute"), "work", "旧任务仍在执行");
  assert.equal(flights.length, beforeSwitch, "切回已有任务直接恢复位置");
  stage.setProject("p1"); stage.sync(calls);
  assert.equal(flights.length, beforeSwitch, "同任务更新不重复入场");
  stage.setProject(null);
  assert.ok([...stage.states.values()].every((state) => state === "pod"));
});

test("后台项目的本地完成不会释放当前项目同色工作", async (t) => {
  const { stage } = spriteFixture(t);
  stage.setProject("p1");
  const oldFinish = stage.begin("execute", "p1");
  stage.setProject("p2");
  const newFinish = stage.begin("execute", "p2");
  oldFinish();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(stage.targets.get("execute"), "work");
  assert.equal(stage.occupancy.counts("p2").execute, 1);
  newFinish();
  assert.equal(stage.targets.get("execute"), "pod");
});
