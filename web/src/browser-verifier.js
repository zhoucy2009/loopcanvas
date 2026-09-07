import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { PDFDocument } from "pdf-lib";

export const BROWSER_VERIFY_TOOL = {
  type: "function",
  name: "loopcanvas_verify_browser",
  description: "Render a project-local HTML file in an isolated headless browser. Returns a real screenshot, print PDF page count/sizes, resource errors and saved evidence. Offline: external resources are blocked and reported. Does not establish visual acceptance by itself; inspect the returned image and PDF against requirements. No shell commands, arbitrary URLs or user browser profiles accepted.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["entrypoint"],
    properties: {
      entrypoint: { type: "string", description: "HTML path relative to the current project workspace" },
      width: { type: "integer", minimum: 320, maximum: 2560 },
      height: { type: "integer", minimum: 240, maximum: 2560 }
    }
  }
};

const ORIGIN = "https://loopcanvas-artifact.invalid";
const TYPES = { ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" };
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function browserAsset(workspace, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative)
    || relative.split("/").some((part) => part === ".." || part.startsWith("."))) throw new Error("浏览器资源路径不在允许范围内。");
  const root = await realpath(workspace);
  const candidate = await realpath(path.resolve(root, relative));
  if (!inside(root, candidate) || !TYPES[path.extname(candidate).toLowerCase()]) throw new Error("浏览器只能读取项目内的页面与静态资源，不能读取越界链接或其他文件。");
  const info = await stat(candidate);
  if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("浏览器资源不是文件或超过 20 MiB。");
  return { candidate, contentType: TYPES[path.extname(candidate).toLowerCase()] };
}

export async function resolveVerificationBrowser() {
  // This is host configuration, never model-supplied executable or arguments.
  const candidates = [process.env.LOOPCANVAS_BROWSER_EXECUTABLE, chromium.executablePath(),
    ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"] : []),
    ...(process.platform === "linux" ? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"] : []),
    ...(process.platform === "win32" ? [path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe")] : [])].filter(Boolean);
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  throw new Error("未找到隔离验收用的 Chromium/Chrome。请安装浏览器或由宿主配置 LOOPCANVAS_BROWSER_EXECUTABLE；不会自动下载或启动个人浏览器会话。");
}

export async function verifyBrowserArtifact(workspace, input, { signal } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["entrypoint", "width", "height"].includes(key))) throw new Error("浏览器验收参数无效。");
  const { entrypoint, width = 1280, height = 1000 } = input;
  if (!Number.isInteger(width) || width < 320 || width > 2560 || !Number.isInteger(height) || height < 240 || height > 2560) throw new Error("浏览器视口尺寸超出范围。");
  const root = await realpath(workspace);
  const entry = await browserAsset(root, entrypoint);
  if (![".html", ".htm"].includes(path.extname(entry.candidate).toLowerCase())) throw new Error("浏览器验收入口必须是 HTML 文件。");
  signal?.throwIfAborted();
  const executablePath = await resolveVerificationBrowser();
  const evidenceRoot = path.join(root, ".loopcanvas-browser");
  await mkdir(evidenceRoot, { recursive: true });
  if (await realpath(evidenceRoot) !== evidenceRoot) throw new Error("浏览器证据目录不能是符号链接。");
  const output = await mkdtemp(path.join(evidenceRoot, "run-"));
  const temporary = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-browser-"));
  let browser;
  let timer;
  const stop = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener("abort", stop, { once: true });
  const issues = [];
  const issue = (value) => { if (issues.length < 100 && !issues.includes(value)) issues.push(value.slice(0, 1000)); };
  try {
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 15000,
      downloadsPath: temporary,
      env: { PATH: process.env.PATH || "", HOME: temporary, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
    });
    signal?.throwIfAborted();
    timer = setTimeout(stop, 45000);
    const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: false, serviceWorkers: "block" });
    await context.routeWebSocket("**/*", (socket) => { issue("已阻止 WebSocket 连接"); socket.close(); });
    await context.route("**/*", async (route) => {
      try {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN || route.request().method() !== "GET") {
          issue(`已阻止非本地产物请求：${url.protocol}//${url.host}${url.pathname}`);
          return await route.abort();
        }
        const asset = await browserAsset(root, decodeURIComponent(url.pathname.slice(1)));
        await route.fulfill({ status: 200, contentType: asset.contentType, body: await readFile(asset.candidate),
          headers: { "Content-Security-Policy": "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'self'; form-action 'none'" } });
      } catch (error) {
        issue(`资源加载失败：${error.message}`);
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => issue(`页面错误：${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") issue(`控制台错误：${message.text()}`); });
    page.on("requestfailed", (request) => issue(`请求失败：${new URL(request.url()).pathname} ${request.failure()?.errorText || ""}`));
    page.on("dialog", (dialog) => { issue("页面弹窗已关闭"); void dialog.dismiss().catch(() => {}); });
    const source = await readFile(entry.candidate);
    const response = await page.goto(`${ORIGIN}/${entrypoint.split("/").map(encodeURIComponent).join("/")}`, { waitUntil: "load", timeout: 15000 });
    if (!response?.ok()) throw new Error("本地页面未成功加载。");
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => ({ title: document.title, width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      images: [...document.images].map((img) => ({ loaded: img.complete && img.naturalWidth > 0 })).slice(0, 200) }));
    if (layout.scrollHeight > 16000 || layout.scrollWidth > 16000 || layout.scrollWidth * layout.scrollHeight > 32_000_000) throw new Error("页面尺寸超过截图上限，需缩小验收范围后重试。");
    const screenshot = await page.screenshot({ fullPage: true, animations: "disabled", timeout: 10000 });
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true, format: "A4", timeout: 10000 });
    const document = await PDFDocument.load(pdf);
    const report = { status: "rendered", acceptancePassed: null, entrypoint, sourceSHA256: hash(source),
      browserVersion: browser.version(), viewport: { width, height }, layout, issues,
      pdf: { pageCount: document.getPageCount(), pages: document.getPages().map((page) => page.getSize()) },
      screenshot: path.join(output, "screen.png"), printPDF: path.join(output, "print.pdf"),
      screenshotSHA256: hash(screenshot), pdfSHA256: hash(pdf),
      note: "截图是屏幕渲染；PDF 是打印输出。页数与纸张尺寸不证明无裁切。必须检查截图/PDF和要求后给出验收结论；issues 非空时先判断资源缺失影响。" };
    if (hash(await readFile(entry.candidate)) !== report.sourceSHA256) throw new Error("渲染期间源文件发生变化，请重试以取得一致证据。");
    signal?.throwIfAborted();
    await writeFile(report.screenshot, screenshot, { mode: 0o600 });
    await writeFile(report.printPDF, pdf, { mode: 0o600 });
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    return { report, screenshot };
  } catch (error) {
    const detail = `隔离浏览器验收失败：${error.message}`;
    await writeFile(path.join(output, "failure.json"), JSON.stringify({ error: detail, issues }, null, 2), { mode: 0o600 }).catch(() => {});
    throw new Error(`${detail}；诊断：${path.join(output, "failure.json")}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    await browser?.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}
