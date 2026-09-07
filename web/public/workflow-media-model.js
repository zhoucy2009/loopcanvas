export function hasTwoVideoIntent(workflow) {
  return /(?:第二[个段部]?视频|另[一个段]*视频|两个视频|主视频)/.test(JSON.stringify(workflow));
}

export function isVideoComposition(workflow) {
  return workflow?.nodes?.some((node) => node.tool === "local_media_compose");
}

export function videoCompositionNodes(criteria) {
  const tool = (id, title, name, args) => ({ id, title, type: "tool", tool: name, arguments: args, instructions: "按真实输入执行，保留中间结果；缺少输入或未生成产物必须失败。" });
  return [
    tool("source_transcribe", "转写于谦素材视频", "local_media_transcribe", { inputPath: "{{input.sourceVideo}}", outputName: "source-transcript.txt", language: "zh-CN" }),
    tool("source_analyze", "提取完整捧哏片段", "agent_transcript_analyze", { transcript: "{{outputs.source_transcribe}}", criteria: "识别于谦说出的完整捧哏回应，尽量排除逗哏台词；无法确定说话人时降低置信度并说明。每段提取关键词和语义依据。", maxCandidates: 50, contextSeconds: 0, keywordsPerCandidate: 5 }),
    tool("target_transcribe", "转写主视频", "local_media_transcribe", { inputPath: "{{input.targetVideo}}", outputName: "target-transcript.txt", language: "zh-CN" }),
    tool("target_analyze", "标记主视频完整句结束位置", "agent_transcript_analyze", { transcript: "{{outputs.target_transcribe}}", criteria: "按主视频的完整句和语义主题分段，以每句话自然结束的位置作为可插入回应的位置。保留准确的来源片段索引。", maxCandidates: 100, contextSeconds: 0, keywordsPerCandidate: 5 }),
    tool("match", "匹配两段视频的语义并安排插入", "agent_media_match", { sourceCandidates: "{{outputs.source_analyze.candidates}}", targetCandidates: "{{outputs.target_analyze.candidates}}", criteria: String(criteria || "在主视频每段话结束后插入语义合适的于谦捧哏片段"), maxInsertions: 30 }),
    tool("compose", "合成完整成品视频", "local_media_compose", { sourcePath: "{{input.sourceVideo}}", targetPath: "{{input.targetVideo}}", insertions: "{{outputs.match.insertions}}" })
  ].map((node, index) => ({ ...node, x: 35 + (index % 3) * 250, y: 35 + Math.floor(index / 3) * 150 }));
}

// Planning explicitly represents evidence and quality gates in the graph.
// Existing saved templates remain unchanged; only new plans use this contract.
export function reviewedVideoCompositionPlan(criteria) {
  const requirements = String(criteria).trim();
  const nodes = videoCompositionNodes(requirements);
  nodes[0].title = "转写素材视频";
  nodes[1].title = "筛选符合要求的完整素材片段";
  nodes.find((node) => node.id === "match").title = "按用户标准匹配素材和插入位置";
  nodes[1].arguments.criteria = `只根据真实片段及可核对的证据筛选，保留来源索引。无法确定说话人时不能仅降低置信度继续；请求人工标注。完整要求：${requirements}`;
  nodes[3].arguments.criteria += ` 本次完整要求：${requirements}`;
  for (const node of nodes) node.instructions += ` 本次完整要求（只执行当前步骤涉及的部分，不得省略验收条件）：${requirements}`;
  const warnings = ["转写与语义候选不等于人物识别或成片验收；合成前独立审核，合成后等待人工观看确认。", "这是待检查的规划草稿。请核对输入用途、候选数量、匹配标准和箭头顺序后保存。"];
  if (/于谦|说话人|人物|身份|speaker/i.test(requirements)) {
    nodes.splice(1, 0, { id: "source_speakers", type: "tool", title: "按声音自动区分说话人", tool: "local_speaker_diarize", arguments: { inputPath: "{{input.sourceVideo}}", numSpeakers: -1, threshold: 0.9 } }, { id: "speaker_evidence", type: "approval", title: "试听分组并确认人物姓名", instructions: "试听每个声音分组的代表片段，再填写人物姓名。同一个人被分成多组可填写相同姓名合并；不确定的组留空，不要猜测。个别分错片段可用时间标注纠正。", arguments: { diarization: "{{outputs.source_speakers}}", transcript: "{{outputs.source_transcribe}}" } });
    nodes.find((node) => node.id === "source_analyze").arguments.speakerEvidence = "{{outputs.speaker_evidence}}";
    warnings.unshift("已加入声音自动分组和人工姓名确认；可自动估计人数或指定多人，分组不确定时可重新调整。");
  }
  nodes.splice(nodes.findIndex((node) => node.id === "compose"), 0, { id: "plan_review", type: "review", title: "合成前独立审核", instructions: `逐项独立检查候选来源、完整句边界、语义匹配理由、数量、间隔、重复使用和用户全部验收条件。通用感叹词不能替代真实语义关联。依据不足请求补充，任何标准不通过禁止合成。用户要求：${requirements}`, arguments: { insertions: "{{outputs.match.insertions}}" } });
  nodes.push({ id: "delivery_review", type: "approval", title: "观看成片并确认交付", instructions: `打开本次成品，核对插入位置、说话人、前后语义、声画连续、音量及与审核脚本的一致性。填写实际检查结果；不能检查或不符合要求请选择拒绝。本次要求：${requirements}`, arguments: { video: "{{outputs.compose}}" } });
  return { nodes, warnings };
}
