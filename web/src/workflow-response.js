// Read-only semantic nodes return data, never commands or file mutations.
export const isReadonlyAnalysis = (node) => node?.type === "tool" && ["agent_transcript_analyze", "agent_media_match"].includes(node.tool);
export const isReadonlyNode = (node) => isReadonlyAnalysis(node) || node?.type === "review";

// Old records have no reason code: only explicit requests for missing evidence
// are classified as input recovery; unknown business failures are not retried.
export function failureRecovery(error, result) {
  if (result?.status === "needs_input" || /请补充|缺少.*(?:证据|标注)|没有可靠的说话人/.test(error || "")) return "needs_input";
  if (result?.failureKind === "transient" || /JSON|超时|timeout|rate.limit|429|503|ECONNRESET/i.test(error || "")) return "retry";
  return "blocked";
}

const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: "string" };
const strings = { type: "array", items: string };
export function analysisResponseSchema(id, tool) {
  const output = tool === "agent_media_match"
    ? object({ matches: { type: "array", items: object({ sourceIndex: { type: "integer" }, targetIndex: { type: "integer" }, reason: string }) } })
    : object({ candidates: { type: "array", items: object({ id: string, title: string, sourceSegmentIndexes: { type: "array", items: { type: "integer" } }, score: { type: "number" }, keywords: strings, reasons: strings }) } });
  return object({ requestID: { type: "string", enum: [id] }, status: { type: "string", enum: ["success", "failure", "needs_input"] }, summary: string, error: string, output, evidence: strings });
}

export function reviewResponseSchema(id) {
  return object({ requestID: { type: "string", enum: [id] }, status: { type: "string", enum: ["success", "failure", "needs_input"] }, summary: string, error: string,
    output: object({ approved: { type: "boolean" }, checks: { type: "array", items: object({ criterion: string, passed: { type: "boolean" }, evidence: string }) } }), evidence: strings });
}

export function parseAnalysisResponse(raw, expectedID) {
  const text = String(raw ?? "").trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1").trim();
  let result, repair = null, originalError;
  try { result = JSON.parse(text); } catch (error) { originalError = error; }
  if (originalError && text.startsWith("{") && text.endsWith("}")) {
    // Only insert one missing inner closing delimiter. Do not complete truncated
    // strings/documents, extract nested objects, alter values or invent commas.
    const stack = []; let quoted = false, escaped = false, corrected = "", inserted = 0, invalid = false;
    for (let index = 0; index < text.length; index++) {
      const ch = text[index];
      if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; }
      else if (ch === '"') quoted = true;
      else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
      else if (ch === "}" || ch === "]") {
        if (stack.at(-1) !== ch) {
          if (inserted || stack.length < 2 || stack.at(-2) !== ch) { invalid = true; break; }
          const delimiter = stack.pop(); corrected += delimiter; inserted++;
          repair = { kind: "missing-inner-closer", offset: index, inserted: delimiter };
        }
        stack.pop();
      }
      corrected += ch;
    }
    if (!invalid && !quoted && !stack.length && inserted === 1) {
      try { result = JSON.parse(corrected); } catch { /* reject ambiguous/incomplete data */ }
    }
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`Agent 返回的分析 JSON 格式无效（${Buffer.byteLength(String(raw ?? ""))} 字节）：${originalError?.message || "需要完整对象"}。原始返回已保留，可从失败步骤继续。`);
  }
  if (result.requestID !== expectedID || !["success", "failure", "needs_input"].includes(result.status)) throw new Error("Agent 分析响应 ID 或状态无效。");
  return { result, repair: originalError ? repair : null };
}
