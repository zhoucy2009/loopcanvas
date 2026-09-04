import assert from "node:assert/strict";
import test from "node:test";
import { ExplorationTabs } from "../public/exploration-tabs.js";

test("技术、艺术和同类多页独立并行；乱序完成不抢占选中页", () => {
  const pages = new ExplorationTabs();
  const tech = pages.active("project-a");
  tech.draft = "技术问题";
  const art = pages.selectKind("project-a", "art");
  assert.equal(tech.draft, "技术问题");
  const tech2 = pages.open("project-a", "research");
  for (const tab of [tech, art, tech2]) assert.equal(pages.begin(tab, tab.id), true);
  assert.equal(pages.begin(tech, "重复提交"), false);
  assert.equal(pages.close(tech.id), false);
  art.draft = "下一轮问题";
  pages.complete(art, { id: "art-thread", kind: "art", title: "艺术结果" });
  assert.equal(pages.active("project-a"), tech2);
  assert.equal(art.unread, true);
  assert.equal(art.draft, "下一轮问题");
  assert.equal(tech.busy, true);
  pages.fail(tech, "模拟失败");
  assert.equal(tech.draft, tech.id);
  assert.equal(tech2.busy, true);
  assert.equal(pages.active("project-a"), tech2);
  assert.equal(pages.select(art.id).unread, false);
});

test("按项目/全局保留页面和草稿，重新打开历史不重复建页", () => {
  const pages = new ExplorationTabs();
  const first = pages.active("project-a");
  first.draft = "草稿";
  first.scrollTop = 240;
  const global = pages.open(null, "art", { id: "saved", kind: "art", title: "保存的搜索" });
  const second = pages.active("project-b");
  assert.equal(pages.active("project-a"), first);
  assert.equal(first.draft, "草稿");
  assert.equal(first.scrollTop, 240);
  assert.notEqual(second, first);
  assert.equal(pages.open(null, "art", { id: "saved" }), global);
  assert.equal(pages.list(null).length, 1);
  pages.close(global.id);
  assert.notEqual(pages.active(null).id, global.id);
  assert.equal(pages.active(null).kind, "art");
});

test("关闭选中页转到相邻页，失败不会覆盖已输入的新问题", () => {
  const pages = new ExplorationTabs();
  const first = pages.active(null);
  const second = pages.open(null);
  const third = pages.open(null);
  pages.select(second.id);
  pages.close(second.id);
  assert.equal(pages.active(null), third);
  pages.begin(first, "原始问题");
  first.draft = "新问题";
  pages.fail(first, "失败");
  assert.equal(first.draft, "新问题");
  assert.equal(pages.active(null), third);
  pages.close(first.id);
  assert.equal(pages.active(null), third);
});
