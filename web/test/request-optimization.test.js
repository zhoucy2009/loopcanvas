import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compactSharedContext } from "../src/harness.js";
import { listConversationRecords, writeConversationRecord } from "../src/conversations.js";

test("共享上下文只删除完全重复项和与目标相同的 requirement", () => {
  const goal = "制作一个静态页面";
  const context = [
    { kind: "requirement", content: goal },
    { kind: "decision", content: "使用纯 HTML" },
    { kind: "decision", content: "使用纯 HTML" },
    { kind: "correction", content: "使用纯 HTML" },
    { kind: "result", content: "  已生成首页  " }
  ];
  assert.equal(compactSharedContext(context, goal), [
    "[decision] 使用纯 HTML",
    "[correction] 使用纯 HTML",
    "[result] 已生成首页"
  ].join("\n"));
});

test("对话记录保存 request、output 与总字节指标", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-record-metrics-"));
  try {
    const request = { id: "metric-1", userGoal: "生成页面" };
    const output = "{\"status\":\"success\"}";
    const meta = await writeConversationRecord(directory, { projectId: "project-1", operation: "test", request, output });
    const record = JSON.parse(await readFile(meta.path, "utf8"));
    const requestSizeBytes = Buffer.byteLength(JSON.stringify(request));
    const outputSizeBytes = Buffer.byteLength(output);
    assert.deepEqual(record.captureMetrics, { requestSizeBytes, outputSizeBytes, totalSizeBytes: requestSizeBytes + outputSizeBytes });
    const listed = await listConversationRecords(directory, "project-1");
    assert.equal(listed[0].requestSizeBytes, requestSizeBytes);
    assert.equal(listed[0].totalSizeBytes, requestSizeBytes + outputSizeBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
