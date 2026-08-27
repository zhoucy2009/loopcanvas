import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listDiagnostics, redactDiagnosticText, writeDiagnostic } from "../src/diagnostics.js";

test("脱敏诊断不会保留 API Key 或 Authorization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dshwf-diagnostic-"));
  try {
    const redacted = redactDiagnosticText("api_key=sk-1234567890abcdef Authorization: Bearer ds-abcdefghijklmnop");
    assert.doesNotMatch(redacted, /1234567890abcdef|abcdefghijklmnop/);
    await writeDiagnostic(directory, { operation: "plan", error: redacted });
    const items = await listDiagnostics(directory);
    assert.equal(items.length, 1);
    assert.equal(items[0].operation, "plan");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
