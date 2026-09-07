import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const executable = (file) => access(file, constants.X_OK).then(() => true, () => false);

export function createSpeakerDiarizer({ dataDirectory, processRunner }) {
  const models = path.join(dataDirectory, "workflow-tools", "speaker-diarization-v1");
  const python = path.join(models, "venv", "bin", "python3");
  let setup;
  async function availability() {
    const candidates = [process.env.LOOPCANVAS_DIARIZATION_PYTHON, "/opt/homebrew/bin/python3.12", "/opt/homebrew/bin/python3", "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3"].filter(Boolean);
    let installer; for (const file of candidates) if (await executable(file)) { installer = file; break; }
    const installed = await access(path.join(models, "manifest.json")).then(() => true, () => false) && await executable(python);
    return { available: process.platform === "darwin" && (installed || Boolean(installer)), installed, installer, reason: process.platform !== "darwin" ? "当前音轨转换需要 macOS。" : !installed && !installer ? "需要本机 Python 3.10 或更高版本以安装说话人组件。" : "" };
  }
  async function ensure(signal, onEvent) {
    const status = await availability();
    if (!status.available) throw new Error(status.reason);
    if (status.installed) return;
    if (!setup) setup = (async () => {
      onEvent?.({ type: "activity", activity: "首次准备说话人分离：下载开源运行组件和约 47 MB 声音模型，媒体不上传" });
      const installed = await processRunner(status.installer, [path.join(here, "setup-speaker-diarization.py"), models], { cwd: dataDirectory, timeoutMs: 20 * 60_000, signal });
      if (installed.code !== 0) throw new Error(`说话人组件准备失败：${installed.stderr.slice(-2000)}`);
    })().finally(() => { setup = null; });
    await setup;
  }
  async function execute({ run, node }, settings, signal, onEvent) {
    const args = node.arguments ?? {};
    if (!path.isAbsolute(String(args.inputPath ?? ""))) throw new Error("自动分组需要可访问的媒体绝对路径。");
    const inputPath = await realpath(args.inputPath);
    const info = await stat(inputPath); await access(inputPath, constants.R_OK);
    if (!info.isFile() || !info.size || info.size > 8 * 1024 ** 3) throw new Error("媒体文件为空、不是文件或超过 8 GiB。");
    const numSpeakers = Number(args.numSpeakers ?? -1), threshold = Number(args.threshold ?? 0.9);
    if (numSpeakers !== -1 && (!Number.isInteger(numSpeakers) || numSpeakers < 1 || numSpeakers > 32)) throw new Error("说话人数选择自动（-1）或 1–32 人。");
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1.5) throw new Error("分组阈值需要大于 0 且不超过 1.5。");
    const directory = path.resolve(settings.workspace, "workflow-runs", run.id, node.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await ensure(signal, onEvent);
    const converted = async (command, commandArgs) => {
      const result = await processRunner(command, commandArgs, { cwd: directory, timeoutMs: 60 * 60_000, signal });
      if (result.code !== 0) throw new Error(`声音分析失败：${result.stderr.slice(-2000) || "音轨转换失败"}`);
    };
    let audio = inputPath;
    if (/\.(mp4|mov|m4v|avi|mpeg|mpg)$/i.test(inputPath)) {
      audio = path.join(directory, "source.m4a");
      onEvent?.({ type: "activity", activity: "提取本机音轨" });
      await converted("/usr/bin/avconvert", ["--source", inputPath, "--preset", "PresetAppleM4A", "--output", audio, "--replace"]);
    }
    const audioPath = path.join(directory, "source.wav");
    await converted("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", audio, audioPath]);
    const requestPath = path.join(directory, "diarization-request.json");
    await writeFile(requestPath, JSON.stringify({ models, audioPath, outputDirectory: directory, numSpeakers, threshold }), { mode: 0o600 });
    onEvent?.({ type: "activity", activity: numSpeakers === -1 ? "按声音特征分组，自动估计说话人数" : `按声音特征分为 ${numSpeakers} 位说话人` });
    const response = await processRunner(python, [path.join(here, "speaker-diarization.py"), requestPath], { cwd: directory, timeoutMs: 6 * 60 * 60_000, signal });
    if (response.code !== 0) throw new Error(`本机说话人分离失败：${response.stderr.slice(-2000)}`);
    const output = JSON.parse(response.stdout);
    if (!Array.isArray(output.speakers) || !output.speakers.length || !Array.isArray(output.turns) || output.turns.length > 20000) throw new Error("声音分组没有返回有效片段。");
    Object.assign(output, { id: node.id, inputPath, sourceSize: info.size, sourceMtimeMs: info.mtimeMs, requestedSpeakers: numSpeakers, threshold, provenance: "automatic-voice-clustering", identityConfirmed: false });
    const reportPath = path.join(directory, "speaker-groups.json");
    await writeFile(reportPath, JSON.stringify(output, null, 2), { mode: 0o600 });
    const artifacts = [{ title: "声音分组与时间范围", path: reportPath }];
    for (const speaker of output.speakers) for (const sample of speaker.samples ?? []) {
      const resolved = await realpath(sample.path);
      if (path.dirname(resolved) !== await realpath(directory)) throw new Error("试听文件不在本次分析目录。");
      artifacts.push({ title: `${speaker.label} · ${sample.startSeconds.toFixed(1)}–${sample.endSeconds.toFixed(1)} 秒`, path: resolved });
    }
    const manifest = JSON.parse(await readFile(path.join(models, "manifest.json"), "utf8"));
    return { result: { status: "success", summary: `已根据声音分出 ${output.speakers.length} 组，等待试听并确认姓名。`, output, artifacts, evidence: ["本机 sherpa-onnx 声学分组；不推断人物姓名", `模型指纹 ${JSON.stringify(manifest.models)}`] }, request: { kind: "builtin_workflow_tool", tool: "local_speaker_diarize", arguments: args }, workspace: directory };
  }
  return { availability, execute };
}
