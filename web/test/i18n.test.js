import assert from "node:assert/strict";
import test from "node:test";
import { t, ui, getLanguage, setLanguage } from "../public/i18n.js";
import { parseVoiceCommand } from "../public/voice-commands.js";

test("English is the default; switching translates only authored template chunks", () => {
  assert.equal(getLanguage(), "en");
  assert.equal(t("连接设置"), "Settings");
  const source = '<code>执行：const 学习 = "探索";</code>';
  assert.equal(ui`<h2>工作目录</h2>${source}`, `<h2>Workspace directory</h2>${source}`);
  setLanguage("zh-CN");
  assert.equal(t("连接设置"), "连接设置");
  assert.equal(ui`<h2>工作目录</h2>${source}`, `<h2>工作目录</h2>${source}`);
  setLanguage("unsupported");
  assert.equal(getLanguage(), "en");
});

test("language preference persists with storage and safely tolerates unavailable storage", () => {
  const saved = new Map();
  globalThis.localStorage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  setLanguage("zh-CN");
  assert.equal(saved.get("loopcanvas-language"), "zh-CN");
  globalThis.localStorage = { setItem() { throw new Error("blocked"); } };
  assert.doesNotThrow(() => setLanguage("en"));
  delete globalThis.localStorage;
});

test("English voice commands target individual agents and numbered nodes", () => {
  for (const [text, type] of [["hey, plan", "plan"], ["execute", "execute_step"], ["review", "step_review"], ["final review", "final_review"], ["new task", "new_request"], ["gather agents", "gather"], ["open preview", "preview"], ["pause and hand off", "pause"]]) {
    assert.equal(parseVoiceCommand(text).type, type, text);
  }
  assert.equal(parseVoiceCommand("Please execute step 3").stepNumber, 3);
  assert.equal(parseVoiceCommand("hey, review step two").stepNumber, 2);
  assert.equal(parseVoiceCommand("roll back to step 4").type, "rollback");
  assert.equal(parseVoiceCommand("Plan a 中文 dashboard").query, "a 中文 dashboard");
  assert.equal(parseVoiceCommand("search for state machines").query, "state machines");
  assert.equal(parseVoiceCommand("learn about closures").query, "closures");
  for (const text of ["don't execute", "do not review step 3", "I said execute", '"execute"', "hey, please do not execute"]) {
    assert.equal(parseVoiceCommand(text).type, "unknown", text);
  }
  assert.equal(parseVoiceCommand("执行第三步").stepNumber, 3);
});

test("the standalone preview localizes its controls without touching interpolated content", async () => {
  const { readFile } = await import("node:fs/promises");
  const vm = await import("node:vm");
  const source = await readFile(new URL("../public/preview-trace.js", import.meta.url), "utf8");
  const listeners = [];
  const parent = { postMessage() {} };
  const context = vm.createContext({ parent, addEventListener: (type, handler) => listeners.push(handler) });
  vm.runInContext(source.slice(0, source.indexOf("  const SELECT_COLOR")) + 'globalThis.translate = t; globalThis.template = ui; })();', context);
  assert.equal(context.translate("确认并写回代码"), "Apply to source");
  const sourceText = "执行 and 学习";
  assert.equal(context.template(["<b>取消</b>", ""], sourceText), "<b>Cancel</b>" + sourceText);
  listeners[0]({ source: {}, data: { type: "loopcanvas:locale", language: "zh-CN" } });
  assert.equal(context.translate("取消"), "Cancel");
  listeners[0]({ source: parent, data: { type: "loopcanvas:locale", language: "zh-CN" } });
  assert.equal(context.translate("确认并写回代码"), "确认并写回代码");
});
