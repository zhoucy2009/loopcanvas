import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listConversationRecords, readConversationRecord, writeConversationRecord } from "../src/conversations.js";

test("Agent 调用记录保存真实运行时，旧式输入明确标为 unknown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-conversations-"));
  try {
    const codex = await writeConversationRecord(directory, {
      projectId: "project",
      operation: "route-project",
      runtime: "codex",
      request: { kind: "route_project" },
      output: "{}"
    });
    await writeConversationRecord(directory, { projectId: "project", operation: "execute", output: "{}" });
    const items = await listConversationRecords(directory, "project");
    assert.deepEqual(new Set(items.map((item) => item.runtime)), new Set(["codex", "unknown"]));
    assert.equal((await readConversationRecord(directory, "project", codex.id)).runtime, "codex");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
