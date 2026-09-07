import { spawn } from "node:child_process";
import http from "node:http";
import { realpath } from "node:fs/promises";
import path from "node:path";

export const runtimePreviewTracePath = "/__loopcanvas/preview-trace.js";

const hopByHopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"
]);

export function runtimePreviewProjectId(host = "") {
  return String(host).match(/^preview-([a-zA-Z0-9-]+)\.localhost(?::\d+)?$/)?.[1] ?? null;
}

export function isRuntimePreviewArtifact(artifact) {
  return Boolean(
    artifact
    && artifact.kind !== "html"
    && String(artifact.projectRoot ?? "").trim()
    && Array.isArray(artifact.runCommands)
    && artifact.runCommands.some((command) => String(command ?? "").trim())
  );
}

function injectPreviewBridge(source) {
  const injection = `<style id="loopcanvas-preview-hidden-state">[hidden]{display:none!important}</style><script src="${runtimePreviewTracePath}" data-error-panel="dshwf-preview-error"></script>`;
  const html = String(source ?? "");
  if (html.includes(`src="${runtimePreviewTracePath}"`) || html.includes(`src='${runtimePreviewTracePath}'`)) return html;
  const head = html.match(/<head[^>]*>/i);
  if (head?.index != null) {
    const end = head.index + head[0].length;
    return `${html.slice(0, end)}${injection}${html.slice(end)}`;
  }
  const body = html.match(/<body[^>]*>/i);
  if (body?.index != null) return `${html.slice(0, body.index)}${injection}${html.slice(body.index)}`;
  return `${injection}${html}`;
}

function withRuntimePort(command, port) {
  const source = String(command ?? "").trim();
  if (/--port(?:=|\s+)\d+/.test(source)) return source.replace(/--port(?:=|\s+)\d+/, `--port ${port}`);
  if (/(?:^|\s)-p\s+\d+/.test(source)) return source.replace(/(^|\s)-p\s+\d+/, `$1-p ${port}`);
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|preview)\b/.test(source)) {
    return /\bnpm\s+(?:run\s+)?/.test(source) ? `${source} -- --port ${port}` : `${source} --port ${port}`;
  }
  return source;
}

function listenOnRandomPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function compactLogs(logs) {
  return logs.join("").trim().slice(-4_000);
}

async function safeRuntimeRoot(project) {
  const artifactRoot = await realpath(path.resolve(project.artifact.projectRoot));
  const workspaceRoot = await realpath(path.resolve(project.workspace ?? project.artifact.projectRoot));
  const relative = path.relative(workspaceRoot, artifactRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("运行时预览目录超出项目工作区。");
  return artifactRoot;
}

async function waitUntilReady(runtime, pathname, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (runtime.exited) throw new Error(`预览命令提前退出（${runtime.exitCode ?? "unknown"}）。${compactLogs(runtime.logs)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}${pathname}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_500)
      });
      if (response.status < 500) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(120);
  }
  throw new Error(`预览服务在 ${Math.round(timeoutMs / 1_000)} 秒内没有就绪：${lastError?.message ?? "未知错误"}。${compactLogs(runtime.logs)}`);
}

function responseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || hopByHopHeaders.has(name.toLowerCase())) continue;
    if (["content-security-policy", "content-security-policy-report-only", "x-frame-options", "content-length"].includes(name.toLowerCase())) continue;
    result[name] = value;
  }
  result["cache-control"] = "no-store";
  return result;
}

function proxyRequest(runtime, request, response) {
  return new Promise((resolve) => {
    const headers = { ...request.headers, host: `127.0.0.1:${runtime.port}`, "accept-encoding": "identity" };
    delete headers.connection;
    const upstream = http.request({
      host: "127.0.0.1",
      port: runtime.port,
      method: request.method,
      path: request.url,
      headers
    }, (upstreamResponse) => {
      const headersForClient = responseHeaders(upstreamResponse.headers);
      const location = upstreamResponse.headers.location;
      if (location) {
        try {
          const target = new URL(location, `http://127.0.0.1:${runtime.port}`);
          if (target.hostname === "127.0.0.1" && Number(target.port) === runtime.port) {
            headersForClient.location = `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}${target.pathname}${target.search}${target.hash}`;
          }
        } catch {}
      }
      const contentType = String(upstreamResponse.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("text/html")) {
        response.writeHead(upstreamResponse.statusCode ?? 502, headersForClient);
        if (request.method === "HEAD") { upstreamResponse.resume(); response.end(); resolve(); return; }
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", resolve);
        return;
      }
      const chunks = [];
      upstreamResponse.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      upstreamResponse.once("end", () => {
        const body = Buffer.from(injectPreviewBridge(Buffer.concat(chunks).toString("utf8")), "utf8");
        response.writeHead(upstreamResponse.statusCode ?? 200, { ...headersForClient, "content-length": body.length });
        response.end(request.method === "HEAD" ? undefined : body);
        resolve();
      });
    });
    upstream.once("error", (error) => {
      if (!response.headersSent) {
        const body = Buffer.from(JSON.stringify({ error: `运行时预览连接失败：${error.message}` }));
        response.writeHead(502, { "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
        response.end(body);
      } else response.destroy(error);
      resolve();
    });
    request.pipe(upstream);
  });
}

export function createRuntimePreviewManager({ startupTimeoutMs = 30_000, spawnProcess = spawn } = {}) {
  const runtimes = new Map();

  async function stop(projectId) {
    const runtime = runtimes.get(projectId);
    if (!runtime) return;
    if (!runtime.exited) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.child.kill("SIGKILL");
        reject(new Error("预览进程尚未退出，请稍后重试回退。"));
      }, 3000);
      runtime.child.once("exit", () => { clearTimeout(timer); resolve(); });
      runtime.child.kill("SIGTERM");
    });
    runtimes.delete(projectId);
  }

  async function start(project) {
    if (!isRuntimePreviewArtifact(project.artifact)) throw new Error("当前产物没有可运行的预览命令。");
    const root = await safeRuntimeRoot(project);
    const commandSource = project.artifact.runCommands.find((item) => String(item ?? "").trim());
    const signature = JSON.stringify([root, commandSource, project.artifact.entrypoint ?? "/"]);
    const current = runtimes.get(project.id);
    if (current && current.signature === signature && !current.exited) return current;
    await stop(project.id);

    const port = await listenOnRandomPort();
    const command = withRuntimePort(commandSource, port);
    const child = spawnProcess("/bin/zsh", ["-lc", command], {
      cwd: root,
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", BROWSER: "none", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const runtime = { child, command, port, signature, logs: [], exited: false, exitCode: null };
    runtimes.set(project.id, runtime);
    const capture = (chunk) => {
      runtime.logs.push(Buffer.from(chunk).toString("utf8"));
      if (runtime.logs.length > 100) runtime.logs.splice(0, runtime.logs.length - 100);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("exit", (code) => { runtime.exited = true; runtime.exitCode = code; });
    child.once("error", capture);

    let pathname = "/";
    try { pathname = new URL(String(project.artifact.entrypoint ?? "/"), "http://preview.local").pathname || "/"; } catch {}
    try {
      await waitUntilReady(runtime, pathname, startupTimeoutMs);
      return runtime;
    } catch (error) {
      await stop(project.id);
      throw error;
    }
  }

  return {
    stop,
    async proxy(project, request, response) {
      const runtime = await start(project);
      return proxyRequest(runtime, request, response);
    },
    async close() {
      await Promise.all([...runtimes.keys()].map(stop));
    },
    runtimes
  };
}
