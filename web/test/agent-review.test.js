import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentReviewResponse } from "../src/harness.js";

test("步骤审核严格接受 pass/repair/blocked 并要求通过证据", () => {
  const pass = normalizeAgentReviewResponse({ requestID: "r1", verdict: "pass", summary: "通过", verifiedEvidence: ["已复查测试输出"] }, "r1");
  assert.equal(pass.verdict, "pass");
  assert.throws(() => normalizeAgentReviewResponse({ requestID: "r1", verdict: "pass", summary: "通过" }, "r1"), /没有可复查证据/);
  assert.throws(() => normalizeAgentReviewResponse({ requestID: "other", verdict: "repair", summary: "返修" }, "r1"), /错误的 requestID/);
  assert.throws(() => normalizeAgentReviewResponse({ requestID: "r1", verdict: "ok", summary: "未知" }, "r1"), /无效 verdict/);
});

test("最终审核 repair 只能指向已有步骤，pass 不得含失败验收项", () => {
  const repair = normalizeAgentReviewResponse({ requestID: "final", verdict: "repair", summary: "修复交付入口", repairStepIds: ["deliver", "missing"] }, "final", { final: true, stepIds: ["build", "deliver"] });
  assert.deepEqual(repair.repairStepIds, ["deliver"]);
  assert.throws(() => normalizeAgentReviewResponse({ requestID: "final", verdict: "repair", summary: "返修", repairStepIds: ["missing"] }, "final", { final: true, stepIds: ["deliver"] }), /必须指向已有步骤/);
  assert.throws(() => normalizeAgentReviewResponse({ requestID: "final", verdict: "pass", summary: "通过", acceptanceResults: [{ criterion: "入口可用", passed: false, evidence: "404" }], verifiedEvidence: ["404"] }, "final", { final: true, stepIds: ["deliver"] }), /未通过验收项/);
});

test("最终审核验收结果必须与条件逐项一一匹配", () => {
  const criteria = ["入口可用", "关键按钮可点击"];
  const valid = normalizeAgentReviewResponse({ requestID: "final", verdict: "pass", summary: "通过", acceptanceResults: criteria.map((criterion) => ({ criterion, passed: true, evidence: "已复查" })), verifiedEvidence: ["已复查"] }, "final", { final: true, stepIds: ["deliver"], acceptanceCriteria: criteria });
  assert.equal(valid.acceptanceResults.length, 2);
  assert.throws(() => normalizeAgentReviewResponse({ requestID: "final", verdict: "pass", summary: "通过", acceptanceResults: [{ criterion: "入口可用", passed: true, evidence: "已复查" }], verifiedEvidence: ["已复查"] }, "final", { final: true, stepIds: ["deliver"], acceptanceCriteria: criteria }), /一一匹配/);
  assert.throws(() => normalizeAgentReviewResponse({ requestID: "final", verdict: "repair", summary: "返修", acceptanceResults: [{ criterion: "入口可用", passed: false, evidence: "失败" }, { criterion: "入口可用", passed: false, evidence: "重复" }], repairStepIds: ["deliver"] }, "final", { final: true, stepIds: ["deliver"], acceptanceCriteria: criteria }), /一一匹配/);
  assert.throws(() => normalizeAgentReviewResponse({ requestID: "final", verdict: "pass", summary: "通过", acceptanceResults: criteria.map((criterion) => ({ criterion, passed: true, evidence: "" })), verifiedEvidence: ["总体证据"] }, "final", { final: true, stepIds: ["deliver"], acceptanceCriteria: criteria }), /每条验收条件/);
});
