import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../src/server.js";

test("探索按页面并行，同对话防重入，失败解锁且结果保持隔离", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-explore-concurrency-"));
  const calls = new Map();
  const runtime = await startServer({
    port: 0, dataDirectory: directory, workspace: path.join(directory, "workspace"),
    probeHarness: async () => ({ version: "0.1.0-rc.6" }),
    exploreWithHarness: async (input) => {
      await new Promise((resolve, reject) => calls.set(input.query, { input, resolve, reject }));
      return { result: { answer: `结果：${input.query}`, sources: [], unknowns: [], nextQuestions: [] }, request: {}, rawOutput: "test" };
    }
  });
  const waitForCall = async (query) => {
    for (let i = 0; i < 200; i++) {
      if (calls.has(query)) return calls.get(query);
      await delay(10);
    }
    assert.fail(`请求未并行进入执行器：${query}`);
  };
  try {
    const bootstrap = await (await fetch(`${runtime.url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${runtime.url}/api/projects/draft`, { method: "POST", headers, body: "{}" })).json();
    const projectId = created.state.activeProjectId;
    const post = (body) => fetch(`${runtime.url}/api/explore`, { method: "POST", headers, body: JSON.stringify({ projectId, ...body }) });
    const tech = post({ pageId: "tech-page", kind: "research", query: "技术一" });
    const art = post({ pageId: "art-page", kind: "art", query: "艺术一" });
    const tech2 = post({ pageId: "tech-page-2", kind: "research", query: "技术二" });
    const global = post({ projectId: null, kind: "art", query: "全局艺术" });
    await Promise.all(["技术一", "艺术一", "技术二", "全局艺术"].map(waitForCall));
    runtime.store.state = structuredClone(runtime.store.state);
    const duplicate = await post({ pageId: "tech-page", query: "重复" });
    assert.equal(duplicate.status, 400);
    assert.match((await duplicate.json()).error, /这个搜索页面/);
    calls.get("艺术一").resolve();
    const artResult = await (await art).json();
    assert.equal(artResult.thread.kind, "art");
    assert.equal(artResult.thread.messages.at(-1).text, "结果：艺术一");
    calls.get("技术二").resolve();
    const tech2Result = await (await tech2).json();
    calls.get("全局艺术").resolve();
    assert.equal((await (await global).json()).thread.projectId, null);
    calls.get("技术一").reject(new Error("模拟上游失败"));
    assert.equal((await tech).status, 400);
    const retry = post({ pageId: "tech-page", query: "重试" });
    (await waitForCall("重试")).resolve();
    assert.equal((await retry).status, 200);

    const continuation = post({ threadId: tech2Result.thread.id, kind: "research", query: "技术追问" });
    const running = await waitForCall("技术追问");
    assert.equal(running.input.history.length, 2);
    assert.equal(running.input.history[0].text, "技术二");
    const sameThread = await post({ threadId: tech2Result.thread.id, pageId: "different-page", query: "乱序追问" });
    assert.equal(sameThread.status, 400);
    const wrongKind = await post({ threadId: tech2Result.thread.id, kind: "art", query: "类型错配" });
    assert.equal(wrongKind.status, 400);
    assert.match((await wrongKind.json()).error, /类型与已有对话不一致/);
    running.resolve();
    const continued = await (await continuation).json();
    assert.equal(continued.thread.messages.length, 4);
    const state = (await (await fetch(`${runtime.url}/api/bootstrap`)).json()).state;
    const threads = state.projects.find((item) => item.id === projectId).explorationThreads;
    assert.equal(threads.length, 3);
    assert.equal(threads.find((item) => item.id === artResult.thread.id).messages.length, 2);
    assert.equal(state.explorationThreads.length, 1);
  } finally {
    for (const call of calls.values()) call.resolve();
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
