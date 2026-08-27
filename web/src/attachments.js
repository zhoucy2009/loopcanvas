import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_SINGLE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_BATCH_BYTES = 100 * 1024 * 1024;

function safeName(value) {
  const base = path.basename(String(value || "attachment")).replaceAll(":", "-").replaceAll("\\", "-").trim();
  return (base || "attachment").slice(0, 120);
}

function attachmentKind(mimeType, filename) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) return "pdf";
  if (mimeType.startsWith("text/") || /\.(txt|md|json|csv|tsv|html|css|js|ts|swift|py|yaml|yml)$/i.test(filename)) return "text";
  return "file";
}

export async function stageAttachment({ dataDirectory, state, bytes, filename, mimeType = "application/octet-stream", source = "Web 文件选择器" }) {
  if (!Buffer.isBuffer(bytes)) throw new Error("附件内容无效。");
  if (bytes.length > MAX_SINGLE_FILE_BYTES) throw new Error("单个附件不能超过 25 MiB。");
  const currentBytes = state.draftAttachments.reduce((total, item) => total + item.byteCount, 0);
  if (currentBytes + bytes.length > MAX_BATCH_BYTES) throw new Error("当前附件批次总量不能超过 100 MiB。");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (state.draftAttachments.some((item) => item.sha256 === sha256)) throw new Error("相同内容的附件已经添加。");
  const id = randomUUID();
  const name = safeName(filename);
  const directory = path.join(dataDirectory, "attachments");
  await mkdir(directory, { recursive: true });
  const localPath = path.join(directory, `${id}-${name}`);
  await writeFile(localPath, bytes, { mode: 0o600 });
  return {
    id, name, kind: attachmentKind(mimeType, name), mimeType,
    byteCount: bytes.length, sha256, localPath, source: String(source || "Web 文件选择器").slice(0, 80)
  };
}

export function findAttachment(state, attachmentId) {
  const draft = state.draftAttachments.find((item) => item.id === attachmentId);
  if (draft) return draft;
  for (const project of [...state.projects, ...state.archivedProjects]) {
    const match = project.attachments?.find((item) => item.id === attachmentId);
    if (match) return match;
  }
  return null;
}

export async function readTextAttachment(state, attachmentId) {
  const attachment = findAttachment(state, attachmentId);
  if (!attachment || attachment.kind !== "text") throw new Error("这个附件不能恢复为文本。");
  if (attachment.byteCount > 2 * 1024 * 1024) throw new Error("文本附件超过 2 MiB，不能直接放回输入框。");
  return readFile(attachment.localPath, "utf8");
}

export async function discardDraftAttachment({ dataDirectory, state, attachmentId }) {
  const index = state.draftAttachments.findIndex((item) => item.id === attachmentId);
  if (index < 0) throw new Error("暂存附件不存在。");
  const [attachment] = state.draftAttachments.splice(index, 1);
  const root = path.resolve(dataDirectory, "attachments");
  const candidate = path.resolve(attachment.localPath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("附件路径越界，拒绝删除。");
  await rm(candidate, { force: true });
}
