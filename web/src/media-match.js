export function normalizeMediaMatch(result, args) {
  if (result.status !== "success") return result;
  const matches = result.output?.matches;
  if (!Array.isArray(matches) || !matches.length) throw new Error("没有找到可插入的语义匹配；未生成成片。请调整匹配标准或素材。");
  const max = Math.min(100, Math.max(1, Number(args.maxInsertions) || 30));
  if (matches.length > max) throw new Error("匹配结果超过允许的插入数量。");
  const seen = new Set();
  const insertions = matches.map((match) => {
    if (!Number.isInteger(match.sourceIndex) || !Number.isInteger(match.targetIndex)) throw new Error("匹配必须引用真实候选索引。");
    const source = args.sourceCandidates?.[match.sourceIndex], target = args.targetCandidates?.[match.targetIndex];
    if (!source || !target || seen.has(match.targetIndex)) throw new Error("匹配索引不存在或同一位置重复插入。");
    seen.add(match.targetIndex);
    const atSeconds = Number(target.startSeconds) + Number(target.durationSeconds);
    const sourceStartSeconds = Number(source.startSeconds), durationSeconds = Number(source.durationSeconds);
    if (![atSeconds, sourceStartSeconds, durationSeconds].every(Number.isFinite) || atSeconds < 0 || sourceStartSeconds < 0 || durationSeconds <= 0) throw new Error("来源候选时间码无效。");
    return { atSeconds, sourceStartSeconds, durationSeconds, sourceIndex: match.sourceIndex, targetIndex: match.targetIndex, sourceText: source.text, targetText: target.text, reason: String(match.reason || "") };
  }).sort((a, b) => a.atSeconds - b.atSeconds);
  return { ...result, output: { insertions }, artifacts: [{ title: "双视频语义插入方案", content: JSON.stringify(insertions, null, 2) }], statePatch: {}, evidence: ["插入位置和素材时间范围由服务端从两组真实候选索引计算。"] };
}
