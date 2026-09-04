import { cp, mkdir, mkdtemp, rename, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
run("swift", ["build", "--product", "LoopCanvasWake", "-c", "release"]);
const bin = execFileSync("swift", ["build", "-c", "release", "--show-bin-path"], { cwd: root, encoding: "utf8" }).trim();
await mkdir(path.join(root, "dist"), { recursive: true });
const stage = await mkdtemp(path.join(root, "dist", ".wake-stage-"));
const app = path.join(stage, "LoopCanvas Wake.app");
const contents = path.join(app, "Contents");
await mkdir(path.join(contents, "MacOS"), { recursive: true });
await mkdir(path.join(contents, "Resources", "server", "web"), { recursive: true });
await cp(path.join(bin, "LoopCanvasWake"), path.join(contents, "MacOS", "LoopCanvasWake"));
await cp(path.join(root, "Resources", "Wake-Info.plist"), path.join(contents, "Info.plist"));
for (const entry of ["bin", "src", "public", "node_modules", "package.json"]) {
  await cp(path.join(root, "web", entry), path.join(contents, "Resources", "server", "web", entry), { recursive: true, verbatimSymlinks: true });
}
await cp(path.join(root, "plugins"), path.join(contents, "Resources", "server", "plugins"), { recursive: true, verbatimSymlinks: true });
await writeFile(path.join(contents, "Resources", "runtime.json"), JSON.stringify({ nodeExecutable: process.execPath }, null, 2));
run("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
const destination = path.join(root, "dist", "LoopCanvas Wake.app");
if (await stat(destination).catch(() => null)) {
  const backup = path.join(root, "dist", `LoopCanvas Wake.previous-${Date.now()}.app`);
  await rename(destination, backup);
  console.log(`Previous build retained: ${backup}`);
}
await rename(app, destination);
console.log(destination);
