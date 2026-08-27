import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactDiagnosticText } from "./diagnostics.js";

const MAX_RECORDS_PER_PROJECT = 200;
const MAX_RECORD_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_RECORD_FILE_BYTES = 512 * 1024 * 1024;

function recordDirectory(dataDirectory, projectId) {
  return path.join(dataDirectory, "conversations", String(projectId));
}

function safeRecordId(recordId) {
  return /^record-[0-9T:.Z-]+-[A-Za-z0-9_-]+\.json$/.test(String(recordId)) ? String(recordId) : null;
}

export async function writeConversationRecord(dataDirectory, input = {}) {
  const directory = recordDirectory(dataDirectory, input.projectId ?? "unknown");
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const capturedAt = new Date().toISOString();
  const output = redactDiagnosticText(input.output ?? "", { maxBytes: MAX_RECORD_OUTPUT_BYTES });
  const requestSizeBytes = (() => {
    try { return Buffer.byteLength(JSON.stringify(input.request ?? null)); }
    catch { return null; }
  })();
  const outputSizeBytes = Buffer.byteLength(output);
  const runtime = ["codex", "dsh"].includes(input.runtime) ? input.runtime : "unknown";
  const captureMetrics = {
    requestSizeBytes,
    outputSizeBytes,
    totalSizeBytes: requestSizeBytes == null ? null : requestSizeBytes + outputSizeBytes
  };
  const record = {
    id,
    capturedAt,
    operation: String(input.operation ?? "unknown"),
    status: ["failed", "awaiting_user_direction"].includes(input.status) ? input.status : "success",
    projectId: input.projectId ? String(input.projectId) : null,
    nodeId: input.nodeId ? String(input.nodeId) : null,
    runtime,
    request: input.request ?? null,
    output,
    captureMetrics,
    error: input.error ? String(input.error) : null
  };
  const filename = `record-${capturedAt.replaceAll(":", "-")}-${id}.json`;
  const recordPath = path.join(directory, filename);
  const meta = {
    id: filename,
    capturedAt,
    operation: record.operation,
    nodeId: record.nodeId,
    runtime,
    status: record.status,
    error: record.error,
    sizeBytes: outputSizeBytes,
    requestSizeBytes,
    totalSizeBytes: captureMetrics.totalSizeBytes
  };
  await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await writeFile(`${recordPath}.meta`, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  return { ...meta, path: recordPath };
}

export async function listConversationRecords(dataDirectory, projectId) {
  const directory = recordDirectory(dataDirectory, projectId);
  const names = await readdir(directory).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const records = [];
  for (const filename of names.filter((name) => /^record-.+\.json\.meta$/.test(name)).sort().reverse().slice(0, MAX_RECORDS_PER_PROJECT)) {
    const candidate = path.resolve(directory, filename);
    if (path.dirname(candidate) !== path.resolve(directory)) continue;
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      records.push(parsed);
    } catch {
      records.push({ id: filename.replace(/\.meta$/, ""), capturedAt: null, operation: "unknown", status: "failed", error: "记录文件无法解析。", sizeBytes: 0 });
    }
  }
  return records;
}

export async function readConversationRecord(dataDirectory, projectId, recordId) {
  const filename = safeRecordId(recordId);
  if (!filename) throw new Error("对话记录标识无效。");
  const directory = path.resolve(recordDirectory(dataDirectory, projectId));
  const candidate = path.resolve(directory, filename);
  if (path.dirname(candidate) !== directory) throw new Error("对话记录路径越界。");
  const info = await stat(candidate).catch(() => null);
  if (!info?.isFile()) throw new Error("对话记录不存在。");
  if (info.size > MAX_RECORD_FILE_BYTES) throw new Error("对话记录文件过大，无法读取。");
  return JSON.parse(await readFile(candidate, "utf8"));
}
