import test from "node:test";
import assert from "node:assert/strict";
import { parseAnalysisResponse } from "../src/workflow-response.js";
import { normalizeTranscriptAnalysisResult } from "../src/harness.js";

test("repairs a missing inner array closer without changing values, including brackets inside strings", () => {
  const raw = '{"requestID":"r","status":"success","output":{"candidates":[{"sourceSegmentIndexes":[0],"reasons":["依据 } ] \\\" 完整句"}]} ,"evidence":["真实来源"]}';
  const { result, repair } = parseAnalysisResponse(raw, "r");
  assert.equal(repair.inserted, "]");
  assert.deepEqual(result.output.candidates[0].reasons, ['依据 } ] " 完整句']);
  const normalized = normalizeTranscriptAnalysisResult(result, { arguments: { contextSeconds: 0, transcript: { segments: [{ text: "真实来源", startSeconds: 2, durationSeconds: 3 }] } } });
  assert.equal(normalized.output.candidates[0].startSeconds, 2);
  assert.equal(normalized.output.candidates[0].durationSeconds, 3);
  result.output.candidates[0].sourceSegmentIndexes = [5];
  assert.throws(() => normalizeTranscriptAnalysisResult(result, { arguments: { transcript: { segments: [{}] } } }), /来源片段索引/);
});

test("rejects incomplete, ambiguous, nested-only and mismatched protocol responses", () => {
  for (const raw of [
    '{"requestID":"r","status":"success","output":{"candidates":[{"reasons":["truncated',
    '{"requestID":"r","status":"success","output":{}} trailing',
    'text {"requestID":"r","status":"success"}',
    '{"requestID":"r","status":"success","output":{"a":1 "b":2}}',
    '{"requestID":"r","status":"success","output":{"a":[{"b":["x"}}}',
    '{"requestID":"other","status":"success"}',
    '{"requestID":"r","status":"maybe"}',
  ]) assert.throws(() => parseAnalysisResponse(raw, "r"));
  assert.throws(() => parseAnalysisResponse("", "r"), /0 字节/);
  assert.equal(parseAnalysisResponse('```json\n{"requestID":"r","status":"success"}\n```', "r").repair, null);
});
