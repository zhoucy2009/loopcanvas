// Speaker labels are local to one media file; names require a recorded user decision.
export function speakerGroups(run) {
  const result = {};
  for (const output of [...Object.values(run.data?.outputs ?? {}), ...Object.values(run.data?.context?.speakerDiarizations ?? {})]) {
    if (output?.provenance !== "automatic-voice-clustering" || !output.inputPath || !Array.isArray(output.speakers)) continue;
    const key = Object.keys(run.data.input).find((key) => key !== "goal" && run.data.input[key] === output.inputPath);
    if (key) result[key] = output;
  }
  return result;
}

export function mappedSpeakerAnnotations(groups, mappings) {
  const annotations = [];
  for (const [inputKey, choices] of Object.entries(mappings ?? {})) {
    const group = groups[inputKey];
    if (!group || !choices || typeof choices !== "object" || Array.isArray(choices)) throw new Error("声音分组已变化，请重新载入后确认。");
    for (const [speakerId, name] of Object.entries(choices)) {
      if (!group.speakers.some((speaker) => speaker.id === speakerId) || typeof name !== "string" || name.length > 100) throw new Error("说话人名称或分组无效。");
      if (!name.trim()) continue;
      for (const turn of group.turns.filter((turn) => turn.speakerId === speakerId && !turn.overlap)) annotations.push({ inputKey, speakerId, speaker: name.trim(), startSeconds: turn.startSeconds, endSeconds: turn.endSeconds, provenance: "user-named-voice-cluster" });
    }
  }
  return annotations;
}

export function annotateTranscript(transcript, inputKey, evidence) {
  // A new group confirmation replaces earlier mappings for this media file.
  const latestMapping = evidence.findLastIndex((item) => Object.hasOwn(item.speakerMappings ?? {}, inputKey));
  const annotations = evidence.flatMap((item, index) => (item.annotations ?? []).filter((a) => a.provenance !== "user-named-voice-cluster" || latestMapping < 0 || index === latestMapping)).filter((a) => a.inputKey === inputKey);
  return { ...transcript, segments: (transcript.segments ?? []).map((segment) => {
    const { speakerName: priorName, speakerStatus: priorStatus, speakerCoverage: priorCoverage, ...base } = segment;
    const start = Number(segment.startSeconds), duration = Number(segment.durationSeconds), end = start + duration;
    if (!(duration > 0)) return { ...base, speakerStatus: "uncertain" };
    // Union intervals prevents duplicate human confirmations inflating coverage.
    const byName = new Map();
    const manual = annotations.filter((a) => a.provenance === "user-segment-correction" && Math.min(end, a.endSeconds) - Math.max(start, a.startSeconds) >= duration * 0.75);
    for (const a of manual.length ? manual : annotations) {
      const left = Math.max(start, a.startSeconds), right = Math.min(end, a.endSeconds);
      if (right > left) { if (!byName.has(a.speaker)) byName.set(a.speaker, []); byName.get(a.speaker).push([left, right]); }
    }
    const ranked = [...byName].map(([name, intervals]) => {
      let total = 0, right = -Infinity;
      for (const [a, b] of intervals.sort((a, b) => a[0] - b[0])) { total += Math.max(0, b - Math.max(a, right)); right = Math.max(right, b); }
      return { name, coverage: total / duration };
    }).sort((a, b) => b.coverage - a.coverage);
    const best = ranked[0];
    // This is temporal coverage, not a model probability or biometric identification.
    return best?.coverage >= 0.75 && (ranked[1]?.coverage ?? 0) < 0.15
      ? { ...base, speakerName: best.name, speakerStatus: "user-confirmed-mapping", speakerCoverage: Math.min(1, best.coverage) }
      : { ...base, speakerStatus: "uncertain" };
  }) };
}
