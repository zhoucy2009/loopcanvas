import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_WORKFLOW_MEDIA_BYTES = 2 * 1024 ** 3;
const extensions = new Set([".mp4", ".mov", ".m4v", ".mp3", ".m4a", ".wav", ".aiff", ".aif", ".caf", ".aac", ".flac"]);

// Stream uploads to a private local file; never buffer a whole video in memory.
export async function importWorkflowMedia(request, dataDirectory, generic = false) {
  const name = path.basename(decodeURIComponent(String(request.headers["x-workflow-filename"] || "")));
  const extension = path.extname(name).toLowerCase();
  if (!name || name === "." || name === ".." || /[\x00-\x1f]/.test(name)) throw new Error("文件名无效。");
  if (!generic && !extensions.has(extension)) throw new Error("请选择支持的视频或音频文件（MP4、MOV、MP3、M4A、WAV 等）。");
  if (generic && extension && !/^\.[\p{L}\p{N}_-]{1,20}$/u.test(extension)) throw new Error("文件扩展名无效。");
  if (Number(request.headers["content-length"]) > MAX_WORKFLOW_MEDIA_BYTES) throw new Error("媒体文件超过 2 GiB，请改用本机完整路径。");
  const directory = path.join(dataDirectory, generic ? "workflow-inputs" : "workflow-media");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${randomUUID()}${extension}`);
  const temporary = `${target}.partial`;
  let size = 0;
  try {
    await pipeline(request, new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(size > MAX_WORKFLOW_MEDIA_BYTES ? new Error("媒体文件超过 2 GiB，请改用本机完整路径。") : null, chunk);
    } }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    if (!size) throw new Error("媒体文件为空，请重新选择。");
    await rename(temporary, target);
    return { name, path: target, size };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
