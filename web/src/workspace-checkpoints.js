import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const contains = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

// Store bytes under opaque names so project .gitignore, .gitattributes, filters,
// hooks and symlinks cannot change a snapshot or affect the user's repository.
async function pack(root, target) {
  await mkdir(path.join(target, "files"), { recursive: true });
  const entries = [];
  async function visit(relative = "") {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (name.toLowerCase() === ".git") continue;
      const file = path.join(relative, name);
      const source = path.join(root, file);
      const info = await lstat(source);
      const entry = { path: file, mode: info.mode & 0o777, type: info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file" };
      if (!info.isDirectory() && !info.isSymbolicLink() && !info.isFile()) throw new Error(`无法建立完整检查点：不支持的文件类型 ${file}`);
      entries.push(entry);
      if (info.isDirectory()) await visit(file);
      else if (info.isSymbolicLink()) await writeFile(path.join(target, "files", hash(file)), await readlink(source));
      else await copyFile(source, path.join(target, "files", hash(file)));
    }
  }
  await visit();
  await writeFile(path.join(target, "manifest.json"), JSON.stringify(entries));
}

async function unpack(source, root) {
  const entries = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
  const names = new Set();
  for (const entry of entries) {
    if (!entry.path || path.isAbsolute(entry.path) || entry.path.split(path.sep).some((part) => ["", ".", "..", ".git"].includes(part.toLowerCase())) || !["directory", "file", "symlink"].includes(entry.type) || names.has(entry.path)) throw new Error("文件检查点清单无效。");
    names.add(entry.path);
    if (entry.type !== "directory") await readFile(path.join(source, "files", hash(entry.path)));
  }
  // Preserve Git administrative files, including those in nested repositories.
  async function clear(directory) {
    let preserved = false;
    for (const name of await readdir(directory)) {
      if (name.toLowerCase() === ".git") { preserved = true; continue; }
      const file = path.join(directory, name);
      if ((await lstat(file)).isDirectory()) {
        if (await clear(file)) preserved = true;
        else await rm(file, { recursive: true });
      } else await rm(file);
    }
    return preserved;
  }
  await clear(root);
  for (const entry of entries) {
    const destination = path.join(root, entry.path);
    if (entry.type === "directory") await mkdir(destination, { recursive: true });
    else {
      const data = path.join(source, "files", hash(entry.path));
      if (entry.type === "symlink") await symlink(await readFile(data, "utf8"), destination);
      else { await copyFile(data, destination); await chmod(destination, entry.mode); }
    }
  }
  for (const entry of entries.filter((entry) => entry.type === "directory").reverse()) await chmod(path.join(root, entry.path), entry.mode);
}

export class WorkspaceCheckpoints {
  constructor(directory) { this.directory = directory; }

  async location(workspace) {
    await mkdir(workspace, { recursive: true });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await realpath(workspace);
    const storage = await realpath(this.directory);
    if (contains(root, storage) || contains(storage, root)) throw new Error("工作目录与检查点存储目录不能互相包含，请修改项目工作目录。");
    const key = hash(root);
    return { root, key, repository: path.join(storage, key, "repository.git"), worktree: path.join(storage, key, "worktree") };
  }

  async git(location, args) {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "LoopCanvas", GIT_AUTHOR_EMAIL: "checkpoint@localhost", GIT_COMMITTER_NAME: "LoopCanvas", GIT_COMMITTER_EMAIL: "checkpoint@localhost" };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
    const stdout = await new Promise((resolve, reject) => {
      const prefix = args[0] === "init" ? [] : ["--git-dir", location.repository, "--work-tree", location.worktree];
      const child = execFile("git", [...prefix, "-c", "core.hooksPath=/dev/null", ...args], { env, maxBuffer: 16 * 1024 * 1024 }, (error, output) => error ? reject(error) : resolve(output));
      child.stdin.end();
    });
    return stdout.trim();
  }

  async initialize(location) {
    try { await lstat(location.repository); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(path.dirname(location.repository), { recursive: true, mode: 0o700 });
    await this.git(location, ["init", "--bare", "--template=", location.repository]);
    const tree = await this.git(location, ["mktree"]);
    const commit = await this.git(location, ["commit-tree", tree, "-m", "Initialize workspace checkpoints"]);
    await this.git(location, ["update-ref", "refs/heads/checkpoints", commit]);
    await this.git(location, ["worktree", "add", "--detach", location.worktree, commit]);
  }

  async capture(workspace) {
    const location = await this.location(workspace);
    await this.initialize(location);
    await rm(path.join(location.worktree, "files"), { recursive: true, force: true });
    await pack(location.root, location.worktree);
    // Use the linked worktree's index/HEAD, never the original project's index.
    const linked = { ...location, repository: path.resolve(location.worktree, (await readFile(path.join(location.worktree, ".git"), "utf8")).trim().slice(8)) };
    await this.git(linked, ["add", "--all"]);
    const tree = await this.git(linked, ["write-tree"]);
    let commit = await this.git(linked, ["rev-parse", "refs/heads/checkpoints"]);
    if (tree !== await this.git(linked, ["rev-parse", `${commit}^{tree}`])) {
      commit = await this.git(linked, ["commit-tree", tree, "-p", commit, "-m", "Workspace before execution"]);
      await this.git(linked, ["update-ref", "refs/heads/checkpoints", commit]);
    }
    await this.git(linked, ["reset", "--hard", commit]);
    return { version: 1, workspace: location.root, key: location.key, commit };
  }

  async restore(workspace, snapshot) {
    const location = await this.location(workspace);
    if (snapshot?.version !== 1 || snapshot.workspace !== location.root || snapshot.key !== location.key || !/^[a-f0-9]{40,64}$/.test(snapshot.commit ?? "")) throw new Error("文件检查点不属于当前工作目录，无法回退。");
    const linked = { ...location, repository: path.resolve(location.worktree, (await readFile(path.join(location.worktree, ".git"), "utf8")).trim().slice(8)) };
    await this.git(linked, ["reset", "--hard", snapshot.commit]);
    const backup = await mkdtemp(path.join(this.directory, "restore-"));
    try { await pack(location.root, backup); }
    catch (error) { await rm(backup, { recursive: true, force: true }); throw error; }
    const transaction = {
      rollback: () => unpack(backup, location.root),
      dispose: () => rm(backup, { recursive: true, force: true })
    };
    try { await unpack(location.worktree, location.root); }
    catch (error) { await transaction.rollback(); await transaction.dispose(); throw error; }
    return transaction;
  }
}
