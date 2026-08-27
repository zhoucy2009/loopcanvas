import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_RECORDS = 50;

export function redactDiagnosticText(value, { maxBytes = 12_000 } = {}) {
  return String(value ?? "")
    .replace(/\b(?:sk|ds)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, maxBytes);
}

export async function writeDiagnostic(dataDirectory, input = {}) {
  const directory = path.join(dataDirectory, "diagnostics");
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const record = {
    id,
    capturedAt: new Date().toISOString(),
    operation: String(input.operation ?? "unknown"),
    projectId: input.projectId ? String(input.projectId) : null,
    stepId: input.stepId ? String(input.stepId) : null,
    error: redactDiagnosticText(input.error)
  };
  const filename = `failure-${record.capturedAt.replaceAll(":", "-")}-${id}.json`;
  const diagnosticPath = path.join(directory, filename);
  await writeFile(diagnosticPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { ...record, filename, path: diagnosticPath };
}

export async function listDiagnostics(dataDirectory) {
  const directory = path.join(dataDirectory, "diagnostics");
  const names = await readdir(directory).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const records = [];
  for (const filename of names.filter((name) => name.endsWith(".json")).sort().reverse().slice(0, MAX_RECORDS)) {
    const candidate = path.resolve(directory, filename);
    if (path.dirname(candidate) !== path.resolve(directory)) continue;
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      records.push({ ...parsed, filename, path: candidate });
    } catch {
      records.push({ filename, path: candidate, error: "诊断文件无法解析。" });
    }
  }
  return records;
}
