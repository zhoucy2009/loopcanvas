import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const versions = new Map();

export function compareCodexVersions(left = "", right = "") {
  const parse = (value) => String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/);
  const a = parse(left), b = parse(right);
  if (!a || !b) return Number(Boolean(a)) - Number(Boolean(b));
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return difference;
  }
  if (!a[4] || !b[4]) return Number(!a[4]) - Number(!b[4]);
  return a[4].localeCompare(b[4], "en", { numeric: true });
}

export async function codexVersion(executable) {
  try {
    const resolved = await realpath(executable);
    const info = await stat(resolved);
    const key = `${resolved}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    if (!versions.has(key)) {
      const pending = execute(executable, ["--version"], { cwd: os.tmpdir(), timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true })
        .then(({ stdout }) => stdout.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1] || "")
        .catch(() => "");
      versions.set(key, pending);
      // Failed probes must be retryable after a temporary installation failure.
      pending.then((version) => { if (!version) versions.delete(key); });
    }
    return await versions.get(key);
  } catch { return ""; }
}

export async function discoverCodexInstallations({
  home = os.homedir(), envPath = process.env.PATH ?? "", platform = process.platform,
  applicationsRoot = "/Applications", fallbackPaths = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
} = {}) {
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  // Prefer the desktop bundle when versions tie; otherwise compare every candidate.
  const candidates = [...new Set([
    ...(platform === "darwin" ? ["ChatGPT.app", "Codex.app"].map(app => path.join(applicationsRoot, app, "Contents", "Resources", "codex")) : []),
    ...envPath.split(path.delimiter).filter(Boolean).map(directory => path.join(directory, executableName)),
    path.join(home, ".local", "bin", executableName),
    ...fallbackPaths
  ])];
  const results = await Promise.all(candidates.map(async executable => {
    try {
      await access(executable, constants.X_OK);
      if (!(await stat(executable)).isFile()) return null;
      return { path: executable, version: await codexVersion(executable) };
    } catch { return null; }
  }));
  return results.filter(Boolean).sort((a, b) => compareCodexVersions(b.version, a.version));
}

export const CODEX_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function updateStandaloneCodex({
  discover = discoverCodexInstallations, run = execute, version = codexVersion,
  settings = {}, signal
} = {}) {
  if (settings.codexPath || process.env.LOOPCANVAS_CODEX_EXECUTABLE) return { status: "pinned" };
  const installations = await discover();
  // The native updater owns the standalone package and its atomic activation.
  // Never run it against a signed desktop bundle or a package-manager install.
  const resolved = await Promise.all(installations.map(async item => ({
    ...item, realPath: await realpath(item.path).catch(() => "")
  })));
  const standalone = resolved.find(item => /[/\\]packages[/\\]standalone[/\\]releases[/\\]/.test(item.realPath));
  if (!standalone) return { status: "unmanaged" };
  const before = standalone.version;
  await run(standalone.path, ["update"], {
    cwd: os.tmpdir(), env: { ...process.env, CODEX_NON_INTERACTIVE: "1" },
    timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024, windowsHide: true, signal
  });
  const after = await version(standalone.path);
  if (!after || compareCodexVersions(after, before) < 0) throw new Error("Codex 更新后的版本验证失败。");
  return { status: compareCodexVersions(after, before) > 0 ? "updated" : "current", before, after };
}

export function startCodexAutoUpdates({
  settings = () => ({}), update = updateStandaloneCodex, onResult = () => {},
  onError = () => {}, intervalMs = CODEX_UPDATE_INTERVAL_MS,
  enabled = process.env.LOOPCANVAS_CODEX_AUTO_UPDATE !== "0"
} = {}) {
  let pending = null;
  let stopped = false;
  const controller = new AbortController();
  const check = () => {
    if (stopped || !enabled) return Promise.resolve(null);
    if (!pending) pending = Promise.resolve()
      .then(() => update({ settings: settings(), signal: controller.signal }))
      .then(result => { if (!stopped) onResult(result); return result; })
      .catch(error => { if (!stopped) onError(error); return null; })
      .finally(() => { pending = null; });
    return pending;
  };
  const timer = enabled ? setInterval(check, intervalMs) : null;
  timer?.unref();
  const ready = check();
  return { ready, check, stop() { stopped = true; clearInterval(timer); controller.abort(); } };
}
