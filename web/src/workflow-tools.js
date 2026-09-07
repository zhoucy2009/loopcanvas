import { access, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./harness.js";
import { createSpeakerDiarizer } from "./speaker-diarization.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const helperSource = path.join(here, "native-media-transcriber.swift");
const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".avi", ".mpeg", ".mpg"]);
const audioExtensions = new Set([".m4a", ".mp3", ".wav", ".aif", ".aiff", ".caf", ".aac"]);
const supportedExtensions = new Set([...videoExtensions, ...audioExtensions]);

export const BUILTIN_WORKFLOW_TOOLS = Object.freeze([
  {
    name: "local_media_transcribe",
    title: "本机视频 / 音频转写",
    description: "使用 macOS 26 的本机 Speech 模型转写媒体文件并返回带时间信息的 segments。视频先由系统 avconvert 提取音轨；媒体内容不上传。首次使用某种语言时，macOS 可能下载语言资源。",
    arguments: {
      inputPath: "必填。本机媒体文件的绝对路径；通常使用 {{input.goal}}。",
      language: "可选。BCP-47 语言标识，默认 zh-CN。",
      outputName: "可选。工作流运行目录内的转写文本文件名，默认 transcript.txt。"
    },
    availability: "macOS 26+，并安装 Xcode Command Line Tools；不需要 ffmpeg、Whisper 或第三方转写服务。",
    availabilityType: "speech"
  },
  {
    name: "agent_transcript_analyze",
    title: "Agent 转写文本分析",
    description: "让当前配置的 Agent 只根据带时间信息的转写片段识别语义候选、完整句范围、关键词和评分依据。适合包袱、捧哏、金句、主题段落等需要语义判断的任务；结果作为可复核候选，不宣称绝对正确。",
    arguments: {
      transcript: "必填。local_media_transcribe 的完整输出，例如 {{outputs.transcribe}}。",
      criteria: "必填。需要识别的语义标准，例如‘每一句完整的捧哏或包袱’。",
      maxCandidates: "可选。最多候选数，默认 30，范围 1–100。",
      keywordsPerCandidate: "可选。每个候选关键词数，默认 5，范围 1–12。",
      contextSeconds: "可选。候选前后保留的上下文秒数，默认 0.35，范围 0–5。"
    },
    availability: "使用当前配置的 Agent 进行只读语义分析；不访问外部转写服务。",
    availabilityType: "agent"
  },
  {
    name: "agent_media_match", title: "双视频语义匹配",
    description: "比较素材视频与主视频的两组真实语义候选，返回主视频句末插入素材的时间方案。",
    arguments: { sourceCandidates: "素材视频候选数组", targetCandidates: "主视频候选数组", criteria: "语义匹配标准", maxInsertions: "最多插入数量，默认30" },
    availabilityType: "agent"
  },
  {
    name: "local_media_compose", title: "双视频插入合成",
    description: "用 macOS AVFoundation 保留完整主视频，在指定句末插入素材视频片段并导出一段 MP4 成片，验收视频轨道与时长。",
    arguments: { sourcePath: "素材视频绝对路径，{{input.sourceVideo}}", targetPath: "主视频绝对路径，{{input.targetVideo}}", insertions: "agent_media_match 返回的 insertions 数组" },
    availabilityType: "composer"
  },
  {
    name: "local_media_clip",
    title: "本机按时间码切分媒体",
    description: "使用 macOS avconvert 按候选 startSeconds 和 durationSeconds 切分原始视频或音频，并保存片段清单。媒体内容不上传。",
    arguments: {
      inputPath: "必填。原始媒体文件绝对路径；通常使用 {{input.goal}}。",
      clips: "必填。带 startSeconds、durationSeconds、text、keywords 的候选数组，例如 {{outputs.analyze.candidates}}。",
      outputPrefix: "可选。片段文件名前缀，默认 clip。"
    },
    availability: "macOS 自带 avconvert；不需要 ffmpeg。",
    availabilityType: "avconvert"
  } ,
  {
    name: "local_speaker_diarize", title: "本机声音分组 / 说话人分离",
    description: "用 sherpa-onnx 声音特征区分说话人，支持自动估计人数或指定 1–32 人，输出时间范围和代表片段试听。首次下载开源组件和约 47 MB 模型，媒体留在本机。人物姓名须人工确认。",
    arguments: { inputPath: "媒体绝对路径", numSpeakers: "-1 自动估计，或指定 1–32 人", threshold: "自动分组阈值，默认 0.9，越小分组越多" }, availabilityType: "diarization"
  }
]);

function executable(candidate) {
  return access(candidate, fsConstants.X_OK).then(() => true, () => false);
}

function normalizedInputPath(value) {
  let input = String(value ?? "").trim();
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) input = input.slice(1, -1);
  if (input.startsWith("file://")) input = fileURLToPath(input);
  if (!path.isAbsolute(input)) throw new Error("请在“本次任务”填写视频或音频文件的完整路径，然后重新执行。");
  return input;
}

function safeOutputName(value) {
  const name = String(value || "transcript.txt").trim();
  if (!name || name !== path.basename(name) || !/^[^\0/\\]{1,120}$/.test(name)) throw new Error("转写输出文件名无效。");
  return name.endsWith(".txt") ? name : `${name}.txt`;
}

function safePrefix(value) {
  const prefix = String(value || "clip").trim();
  if (!/^[\p{L}\p{N}_-]{1,60}$/u.test(prefix)) throw new Error("媒体片段文件名前缀无效。");
  return prefix;
}

async function mediaFile(value) {
  const input = normalizedInputPath(value);
  const canonical = await realpath(input).catch(() => { throw new Error(`找不到媒体文件：${input}`); });
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error("输入必须是一个本机媒体文件。");
  if (info.size > 8 * 1024 ** 3) throw new Error("媒体文件超过 8 GiB，请先裁剪后再处理。");
  const extension = path.extname(canonical).toLowerCase();
  if (!supportedExtensions.has(extension)) throw new Error(`暂不支持 ${extension || "无扩展名"} 媒体；支持 MP4、MOV、M4V、MP3、M4A、WAV、AIFF、CAF 和 AAC。`);
  return { canonical, extension };
}

export function createWorkflowTools({ dataDirectory, processRunner = runProcess } = {}) {
  if (!dataDirectory) throw new Error("工作流工具需要本机数据目录。");
  const toolDirectory = path.join(dataDirectory, "workflow-tools");
  const helperBinary = path.join(toolDirectory, "media-transcriber-v1");
  const diarizer = createSpeakerDiarizer({ dataDirectory, processRunner });
  let compilePromise = null;

  async function catalog() {
    const [avconvert, xcrun] = await Promise.all([executable("/usr/bin/avconvert"), executable("/usr/bin/xcrun")]);
    const supportedMacOS = process.platform === "darwin" && Number(os.release().split(".")[0]) >= 25;
    const speakers = await diarizer.availability();
    return BUILTIN_WORKFLOW_TOOLS.map((tool) => ({
      ...Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "availabilityType")),
      available: tool.availabilityType === "diarization" ? speakers.available : tool.availabilityType === "agent" ? true : tool.availabilityType === "composer" ? supportedMacOS && xcrun : tool.availabilityType === "avconvert" ? process.platform === "darwin" && avconvert : supportedMacOS && avconvert && xcrun,
      unavailableReason: tool.availabilityType === "diarization" ? speakers.reason : tool.availabilityType === "agent" ? "" : process.platform !== "darwin" ? "当前系统不是 macOS。" : tool.availabilityType === "avconvert" && !avconvert ? "未找到 macOS avconvert。" : !supportedMacOS ? "本机转写需要 macOS 26 或更高版本。" : !xcrun ? "未找到 Xcode Command Line Tools。" : !avconvert ? "未找到 macOS avconvert。" : ""
    }));
  }

  async function ensureHelper(signal, onEvent) {
    if (await executable(helperBinary)) return helperBinary;
    if (!compilePromise) {
      compilePromise = (async () => {
        await mkdir(toolDirectory, { recursive: true, mode: 0o700 });
        onEvent?.({ type: "activity", activity: "准备本机语音转写组件" });
        const compiled = await processRunner("/usr/bin/xcrun", [
          "swiftc", "-parse-as-library", "-O",
          "-module-cache-path", path.join(toolDirectory, "swift-module-cache"),
          "-framework", "Speech", "-framework", "AVFAudio", "-framework", "CoreMedia",
          "-o", helperBinary, helperSource
        ], { cwd: toolDirectory, timeoutMs: 3 * 60_000, signal });
        if (compiled.code !== 0) throw new Error(`无法准备本机语音转写组件：${compiled.stderr.trim() || "Swift 编译失败。"}`);
        return helperBinary;
      })().finally(() => { compilePromise = null; });
    }
    return compilePromise;
  }

  async function transcribe({ run, node }, settings, signal, onEvent) {
    const { canonical, extension } = await mediaFile(node.arguments?.inputPath);

    const runDirectory = path.resolve(settings.workspace, "workflow-runs", run.id, node.id || ".");
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    let audioPath = canonical;
    if (videoExtensions.has(extension)) {
      audioPath = path.join(runDirectory, "source-audio.m4a");
      onEvent?.({ type: "activity", activity: "使用 macOS 提取媒体音轨" });
      const converted = await processRunner("/usr/bin/avconvert", [
        "--source", canonical, "--preset", "PresetAppleM4A", "--output", audioPath,
        "--replace", "--disableMetadataFilter"
      ], { cwd: runDirectory, timeoutMs: 60 * 60_000, signal });
      if (converted.code !== 0) throw new Error(`无法读取视频音轨：${converted.stderr.trim() || "avconvert 转换失败。"}`);
    }

    const helper = await ensureHelper(signal, onEvent);
    const language = String(node.arguments?.language || "zh-CN").trim().slice(0, 35);
    onEvent?.({ type: "activity", activity: `正在本机转写媒体（${language}）` });
    const transcribed = await processRunner(helper, [audioPath, language], {
      cwd: runDirectory, timeoutMs: 6 * 60 * 60_000, signal
    });
    if (transcribed.code !== 0) throw new Error(`本机语音转写失败：${transcribed.stderr.trim() || "Speech 分析器未返回结果。"}`);
    let output;
    try { output = JSON.parse(transcribed.stdout); }
    catch { throw new Error("本机语音转写返回了无法解析的结果。"); }
    if (output.status !== "success" || !String(output.text ?? "").trim()) throw new Error("本机语音转写没有返回有效文本。");

    const outputName = safeOutputName(node.arguments?.outputName);
    const transcriptPath = path.join(runDirectory, outputName);
    const segmentsPath = path.join(runDirectory, `${path.basename(outputName, ".txt")}.segments.json`);
    await Promise.all([
      writeFile(transcriptPath, `${output.text.trim()}\n`, { mode: 0o600 }),
      writeFile(segmentsPath, `${JSON.stringify(output.segments ?? [], null, 2)}\n`, { mode: 0o600 })
    ]);
    const relativeTranscript = path.relative(settings.workspace, transcriptPath);
    const relativeSegments = path.relative(settings.workspace, segmentsPath);
    return {
      result: {
        status: "success",
        summary: `已在本机完成 ${path.basename(canonical)} 的语音转写。`,
        output: { text: output.text, locale: output.locale, inputPath: canonical, transcriptPath, segmentsPath, segments: output.segments ?? [] },
        statePatch: { globals: { lastTranscriptPath: transcriptPath, lastTranscriptLocale: output.locale }, context: {}, deleteGlobals: [] },
        artifacts: [
          { title: "媒体转写文本", path: relativeTranscript, content: output.text },
          { title: "带时间信息的转写片段", path: relativeSegments }
        ],
        evidence: [
          `macOS Speech 本机模型返回 ${(output.segments ?? []).length} 个转写片段。`,
          `转写文本已写入 ${relativeTranscript}。`
        ]
      },
      request: { kind: "builtin_workflow_tool", tool: node.tool, arguments: node.arguments },
      rawOutput: JSON.stringify({ ...output, text: undefined }),
      workspace: runDirectory
    };
  }

  async function clipMedia({ run, node }, settings, signal, onEvent) {
    const { canonical, extension } = await mediaFile(node.arguments?.inputPath);
    const clips = node.arguments?.clips;
    if (!Array.isArray(clips)) throw new Error("媒体切分节点需要候选数组 clips。");
    if (!clips.length) throw new Error("没有可切分候选，未生成视频片段；请调整筛选标准。");
    if (clips.length > 100) throw new Error("一次最多切分 100 个媒体片段。");
    const normalized = clips.map((clip, index) => {
      const startSeconds = Number(clip?.startSeconds);
      const durationSeconds = Number(clip?.durationSeconds);
      if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3600) throw new Error(`第 ${index + 1} 个片段的时间码无效。`);
      return { ...clip, startSeconds, durationSeconds };
    });
    const runDirectory = path.resolve(settings.workspace, "workflow-runs", run.id, "clips", node.id || ".");
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const prefix = safePrefix(node.arguments?.outputPrefix);
    const video = videoExtensions.has(extension);
    const outputExtension = video ? ".mov" : ".m4a";
    const preset = video ? "PresetHighestQuality" : "PresetAppleM4A";
    const outputs = [];
    for (let index = 0; index < normalized.length; index++) {
      signal?.throwIfAborted?.();
      const clip = normalized[index];
      const filename = `${prefix}-${String(index + 1).padStart(3, "0")}${outputExtension}`;
      const outputPath = path.join(runDirectory, filename);
      onEvent?.({ type: "activity", activity: `正在切分媒体片段 ${index + 1}/${normalized.length}` });
      const converted = await processRunner("/usr/bin/avconvert", [
        "--source", canonical, "--preset", preset, "--output", outputPath,
        "--start", String(clip.startSeconds), "--duration", String(clip.durationSeconds),
        "--replace", "--disableMetadataFilter"
      ], { cwd: runDirectory, timeoutMs: 60 * 60_000, signal });
      if (converted.code !== 0) throw new Error(`第 ${index + 1} 个媒体片段切分失败：${converted.stderr.trim() || "avconvert 转换失败。"}`);
      if (!(await stat(outputPath).catch(() => null))?.size) throw new Error(`第 ${index + 1} 个片段没有生成有效文件。`);
      outputs.push({ ...clip, index: index + 1, path: outputPath, filename });
    }
    const manifestPath = path.join(runDirectory, `${prefix}-manifest.json`);
    await writeFile(manifestPath, `${JSON.stringify(outputs, null, 2)}\n`, { mode: 0o600 });
    const relativeManifest = path.relative(settings.workspace, manifestPath);
    return {
      result: {
        status: "success",
        summary: outputs.length ? `已在本机按时间码生成 ${outputs.length} 个媒体片段。` : "没有语义候选，已生成空的媒体片段清单。",
        output: { clips: outputs, manifestPath },
        statePatch: { globals: { lastClipManifestPath: manifestPath, lastClipCount: outputs.length }, context: {}, deleteGlobals: [] },
        artifacts: [
          { title: "媒体片段清单", path: relativeManifest },
          ...outputs.map((item) => ({ title: `媒体片段 ${item.index}${item.text ? ` · ${String(item.text).slice(0, 40)}` : ""}`, path: path.relative(settings.workspace, item.path) }))
        ],
        evidence: [`macOS avconvert 按已验证时间码完成 ${outputs.length} 个片段。`, `片段清单已写入 ${relativeManifest}。`]
      },
      request: { kind: "builtin_workflow_tool", tool: node.tool, arguments: node.arguments },
      rawOutput: JSON.stringify({ clipCount: outputs.length, manifestPath }),
      workspace: runDirectory
    };
  }

  let composeCompile;
  async function compose({ run, node }, settings, signal, onEvent) {
    const source = await mediaFile(node.arguments?.sourcePath), target = await mediaFile(node.arguments?.targetPath);
    if (source.canonical === target.canonical) throw new Error("素材视频和主视频必须是两个不同文件。");
    if (![source.extension, target.extension].every((extension) => videoExtensions.has(extension))) throw new Error("合成需要两个视频文件。");
    const insertions = node.arguments?.insertions;
    if (!Array.isArray(insertions) || !insertions.length || insertions.length > 100 || insertions.some((item) => ![item.atSeconds, item.sourceStartSeconds, item.durationSeconds].every(Number.isFinite) || item.atSeconds < 0 || item.sourceStartSeconds < 0 || item.durationSeconds <= 0)) throw new Error("缺少有效双视频插入方案，不能生成成片。");
    const binary = path.join(toolDirectory, "media-composer-v1");
    if (!await executable(binary)) {
      composeCompile ??= (async () => {
        await mkdir(toolDirectory, { recursive: true, mode: 0o700 });
        const compiled = await processRunner("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-O", "-module-cache-path", path.join(toolDirectory, "swift-module-cache"), path.join(here, "native-media-composer.swift"), "-o", binary], { timeoutMs: 180_000, signal });
        if (compiled.code !== 0) throw new Error(`无法准备本机视频合成组件：${compiled.stderr}`);
      })().finally(() => { composeCompile = null; });
      await composeCompile;
    }
    const directory = path.resolve(settings.workspace, "workflow-runs", run.id, node.id || "compose");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const outputPath = path.join(directory, "finished-video.mp4"), requestPath = path.join(directory, "composition.json");
    await writeFile(requestPath, JSON.stringify({ sourcePath: source.canonical, targetPath: target.canonical, outputPath, insertions }), { mode: 0o600 });
    onEvent?.({ type: "activity", activity: `正在把 ${insertions.length} 个素材片段插入完整主视频并导出 MP4` });
    const exported = await processRunner(binary, [requestPath], { cwd: directory, timeoutMs: 60 * 60_000, signal });
    if (exported.code !== 0) throw new Error(`视频合成未完成：${exported.stderr}`);
    const report = JSON.parse(exported.stdout);
    const file = await stat(outputPath).catch(() => null);
    if (!file?.isFile() || !file.size || report.status !== "success" || report.hasVideo !== true || report.insertedCount !== insertions.length || !(report.durationSeconds > 0) || !Number.isFinite(report.expectedDurationSeconds) || Math.abs(report.durationSeconds - report.expectedDurationSeconds) > 0.25) throw new Error("成片文件或视频轨道/时长验收失败。");
    return { result: { status: "success", summary: `已插入 ${report.insertedCount} 个片段并导出完整 MP4 成片。`, output: { ...report, path: outputPath, verified: true }, artifacts: [{ title: "成品视频（MP4）", path: path.relative(settings.workspace, outputPath), role: "final" }, { title: "视频插入清单", path: path.relative(settings.workspace, requestPath) }], evidence: [`实际文件 ${file.size} 字节`, `视频轨道有效，实际时长 ${report.durationSeconds} 秒，符合完整主视频加插入片段时长。`] }, workspace: directory };
  }

  async function execute(input, settings, signal, onEvent) {
    if (input.node.type && input.node.type !== "tool") return null;
    if (input.node.tool === "local_speaker_diarize") return diarizer.execute(input, settings, signal, onEvent);
    if (input.node.tool === "local_media_compose") return compose(input, settings, signal, onEvent);
    if (input.node.tool === "local_media_transcribe") return transcribe(input, settings, signal, onEvent);
    if (input.node.tool === "local_media_clip") return clipMedia(input, settings, signal, onEvent);
    return null;
  }

  return { catalog, execute };
}
