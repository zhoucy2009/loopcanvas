import assert from "node:assert/strict";
import test from "node:test";
import { chineseNumber, parseVoiceCommand, voiceLocalOperationLabel } from "../public/voice-commands.js";

test("新需求与集合直接唤起精灵，否定或句中提及不触发", () => {
  for (const text of ["开一个新需求", "打开新需求", "hey，开一个新需求", "新建一个新需求"]) assert.equal(parseVoiceCommand(text).type, "new_request");
  for (const text of ["集合", "全体集合", "hey 集合"]) assert.equal(parseVoiceCommand(text).type, "gather");
  for (const text of ["不要集合", "我刚才说开一个新需求", "“集合”"]) assert.equal(parseVoiceCommand(text).type, "unknown");
});

test("语音命令解析搜索、学习与执行意图", () => {
  assert.deepEqual(parseVoiceCommand("帮我搜 本地优先前端框架。"), { type: "search", query: "本地优先前端框架", transcript: "帮我搜 本地优先前端框架" });
  assert.deepEqual(parseVoiceCommand("我需要学 状态管理"), { type: "learning", query: "状态管理", transcript: "我需要学 状态管理" });
  assert.deepEqual(parseVoiceCommand("我想做一个 项目看板"), { type: "workflow", query: "项目看板", transcript: "我想做一个 项目看板" });
  assert.equal(parseVoiceCommand("帮我搜 React state management").query, "React state management");
});

test("语音命令以同义表达触发智能规划、定点执行与两级审核", () => {
  assert.deepEqual(parseVoiceCommand("帮我策划 一个本地任务面板"), { type: "plan", query: "一个本地任务面板", transcript: "帮我策划 一个本地任务面板" });
  assert.equal(parseVoiceCommand("规划一下这个需求").type, "plan");
  assert.equal(parseVoiceCommand("给我先列一个落地方案").type, "plan");
  assert.deepEqual(parseVoiceCommand("执行第 3 步"), { type: "execute_step", stepNumber: 3, stepText: "3", transcript: "执行第 3 步" });
  assert.equal(parseVoiceCommand("运行第三个节点").stepNumber, 3);
  assert.equal(parseVoiceCommand("从第三个节点开始干").stepNumber, 3);
  assert.deepEqual(parseVoiceCommand("审核一下"), { type: "step_review", stepNumber: null, stepText: "", transcript: "审核一下" });
  assert.equal(parseVoiceCommand("检查第三步结果").stepNumber, 3);
  assert.equal(parseVoiceCommand("帮我把刚刚这个结果把把关").type, "step_review");
  assert.equal(parseVoiceCommand("最终审核一下").type, "final_review");
  assert.equal(parseVoiceCommand("做一次交付前裁决").type, "final_review");
  assert.equal(parseVoiceCommand("对整个成品做最后验收").type, "final_review");
  assert.equal(parseVoiceCommand("不要执行第三步，只解释它").type, "unknown");
});

test("语音命令解析回退、演示与暂停交接", () => {
  assert.equal(parseVoiceCommand("回退到第 12 步").stepNumber, 12);
  assert.equal(parseVoiceCommand("回退到第三步").stepNumber, 3);
  assert.equal(parseVoiceCommand("我看看现在的效果").type, "preview");
  assert.equal(parseVoiceCommand("暂停任务并交接").type, "pause");
  assert.equal(voiceLocalOperationLabel("rollback"), "无 · 仅回退本机编排状态");
  assert.equal(voiceLocalOperationLabel("pause"), "无 · 仅暂停/生成交接状态");
  assert.equal(voiceLocalOperationLabel("execute_step"), "");
});

test("中文步骤编号支持常用数字且拒绝无效值", () => {
  assert.equal(chineseNumber("二十三"), 23);
  assert.equal(chineseNumber("一百零二"), 102);
  assert.equal(chineseNumber("两"), 2);
  assert.equal(chineseNumber("最后"), null);
  assert.equal(parseVoiceCommand("随便说一句").type, "unknown");
});

test("三个独立唤醒词和 hey 前缀直接路由到对应 Agent", () => {
  for (const [word, type, role] of [["规划", "plan", "plan"], ["执行", "execute_step", "execute"], ["审核", "step_review", "review"]]) {
    for (const text of [word, `hey，${word}`, `HEY ${word}。`, `Hey${word}`, `嘿，${word}`, `嗨 ${word}`, `${word} Agent`]) {
      const command = parseVoiceCommand(text);
      assert.equal(command.type, type, text);
      assert.equal(command.wakeAgent, role, text);
    }
  }
  assert.equal(parseVoiceCommand("执行").stepNumber, null);
  assert.equal(parseVoiceCommand("规划").query, "");
});

test("唤醒前缀保留后续指令和原话，不把被提及的词当唤醒", () => {
  assert.equal(parseVoiceCommand("hey，执行第三步").stepNumber, 3);
  assert.equal(parseVoiceCommand("hey，规划 React task board").query, "React task board");
  assert.equal(parseVoiceCommand("hey，审核第三步").stepNumber, 3);
  assert.equal(parseVoiceCommand("hey，审核第三步").transcript, "hey，审核第三步");
  for (const text of ["hey", "不要执行", "不要 hey，执行", "我刚才说了审核", "“执行”", "hey 搜索", "执行器"]) {
    assert.equal(parseVoiceCommand(text).type, "unknown", text);
  }
  assert.equal(parseVoiceCommand("打开执行模式").type, "workflow");
});
