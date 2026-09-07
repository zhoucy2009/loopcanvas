import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";

export function artifactLinks(run) {
  return (run.data?.artifacts || []).map((artifact, index) => ({ ...artifact, downloadUrl: `/api/workflow-library/runs/${run.id}/artifacts/${index}`, mediaType: /\.(mp4|mov|m4v)$/i.test(artifact.path || "") ? "video" : "file" }));
}

export async function downloadArtifact(request, response, run, index, workspace) {
  const artifact = run?.data?.artifacts?.[index];
  if (!artifact) throw new Error("产物不存在。");
  let filename, file, size;
  if (artifact.path) {
    const base = path.resolve(run.workspace || workspace);
    const root = await realpath(path.join(base, "workflow-runs", run.id));
    const candidate = path.isAbsolute(artifact.path) ? artifact.path : path.resolve(artifact.path.startsWith("workflow-runs/") ? base : root, artifact.path);
    file = await realpath(candidate);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("产物路径不在本次运行目录中。");
    const info = await stat(file);
    if (!info.isFile()) throw new Error("产物不是文件。");
    size = info.size; filename = path.basename(file);
  } else if (typeof artifact.content === "string") {
    const body = Buffer.from(artifact.content);
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "attachment; filename=workflow-result.txt", "Content-Length": body.length, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    response.end(body); return;
  } else throw new Error("没有可下载的文件。");
  return streamFile(request, response, file, size, filename, urlPreview(request));
}

const urlPreview = (request) => new URL(request.url, "http://localhost").searchParams.get("preview") === "1";

export async function downloadWorkflowInput(request, response, run, key) {
  if (!run?.workflow.inputs?.some((input) => input.key === key && input.type !== "directory")) throw new Error("输入不存在或不是文件。 ");
  const file = await realpath(run.data.input[key]);
  const info = await stat(file);
  if (!info.isFile()) throw new Error("输入不是文件。");
  return streamFile(request, response, file, info.size, path.basename(file), true);
}

function streamFile(request, response, file, size, filename, preview = false) {
  let start = 0, end = size - 1, status = 200;
  if (request.headers.range) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
    if (!range || Number(range[1]) >= size || (range[2] && Number(range[2]) < Number(range[1]))) { response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return; }
    start = Number(range[1]); end = range[2] ? Math.min(end, Number(range[2])) : end; status = 206;
  }
  const mime = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".json": "application/json", ".txt": "text/plain", ".m4a": "audio/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg" }[path.extname(file).toLowerCase()] || "application/octet-stream";
  response.writeHead(status, { "Content-Type": mime, "Content-Disposition": `${preview && /^(video|audio)\//.test(mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`, "Content-Length": Math.max(0, end - start + 1), "Accept-Ranges": "bytes", ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (!size) { response.end(); return; }
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => response.destroy()); response.on("close", () => stream.destroy()); stream.pipe(response);
}
