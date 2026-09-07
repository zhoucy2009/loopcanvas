import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { inputAccept, validateInputReferences } from "../public/workflow-inputs.js";

export function checkWorkflowInputs(workflow, values = {}) {
  const definitions = validateInputReferences(workflow);
  const resolved = {};
  const checks = definitions.map((input) => {
    const value = values[input.key];
    try {
      if (typeof value !== "string" || !value.trim()) throw new Error("请先导入文件或填写本机完整路径");
      const candidate = value.trim();
      if (!path.isAbsolute(candidate)) throw new Error("需要本机绝对路径，不能使用相对路径或网址");
      let canonical, info;
      try { canonical = realpathSync(candidate); info = statSync(canonical); accessSync(canonical, constants.R_OK | (input.type === "directory" ? constants.X_OK : 0)); }
      catch { throw new Error("路径不存在或当前服务没有读取权限，请重新选择"); }
      if (input.type === "directory" ? !info.isDirectory() : !info.isFile()) throw new Error(input.type === "directory" ? "需要可访问的文件夹" : "需要可读取的普通文件");
      if (inputAccept[input.type] && !inputAccept[input.type].split(",").includes(path.extname(canonical).toLowerCase())) throw new Error("文件格式与规划中的输入类型不符");
      resolved[input.key] = canonical;
      return { key: input.key, label: input.label, ok: true, path: canonical };
    } catch (error) { return { key: input.key, label: input.label, ok: false, error: error.message }; }
  });
  return { ok: checks.every((check) => check.ok), checks, values: resolved };
}

export function requireWorkflowInputs(workflow, values) {
  const result = checkWorkflowInputs(workflow, values);
  if (!result.ok) throw new Error(`运行前输入检查未通过：${result.checks.filter((check) => !check.ok).map((check) => `${check.label}（${check.key}）：${check.error}`).join("；")}`);
  return result.values;
}
