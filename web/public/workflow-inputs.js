// Portable input declarations; actual machine paths belong to a run, not a node.
export const inputTypes = { file: "文件", video: "视频", audio: "音频", image: "图片", directory: "文件夹" };
export const inputAccept = { video: ".mp4,.mov,.m4v,.webm,.mkv,.avi", audio: ".mp3,.m4a,.wav,.aiff,.aif,.caf,.aac,.flac,.ogg", image: ".png,.jpg,.jpeg,.webp,.gif,.svg,.heic,.tiff,.bmp" };
const safeKey = (key) => /^[a-zA-Z][\w-]{0,63}$/.test(key) && !["__proto__", "constructor", "prototype"].includes(key);

export function referencedInputs(nodes) {
  const keys = new Set();
  for (const node of nodes || []) {
    const text = JSON.stringify({ arguments: node.arguments, instructions: node.instructions });
    for (const match of text.matchAll(/\{\{\s*input\.([\w-]+)(?=[.\s}])/g)) keys.add(match[1]);
    if (node.condition?.path?.startsWith("input.")) keys.add(node.condition.path.split(".")[1]);
  }
  return [...keys];
}

export function workflowInputs(workflow) {
  if (workflow?.inputs !== undefined) return structuredClone(workflow.inputs);
  // Compatibility for existing saved graphs; new graphs always declare inputs.
  const nodes = workflow?.nodes || [];
  const fileGoal = nodes.some((n) => /\{\{\s*input\.goal\s*\}\}/.test(JSON.stringify(n.arguments)) && (['local_media_transcribe', 'local_media_clip'].includes(n.tool) || Object.entries(n.arguments || {}).some(([key, value]) => /^(inputPath|sourcePath|filePath|path)$/.test(key) && value === '{{input.goal}}')));
  return referencedInputs(nodes).filter((key) => key !== "goal" || fileGoal).map((key, index) => ({ key, label: key === "sourceVideo" ? "素材视频" : key === "targetVideo" ? "主视频" : `输入 ${index + 1}`, type: /Video$/.test(key) ? "video" : "file" }));
}

export function validateInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length > 32) throw new Error("工作流最多声明 32 个输入。");
  const keys = new Set();
  for (const input of inputs) {
    if (!input || !safeKey(input.key) || keys.has(input.key)) throw new Error("输入标识无效或重复。");
    if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 100) throw new Error("每个输入都需要 1–100 字的名称。");
    if (!Object.hasOwn(inputTypes, input.type)) throw new Error("请选择有效的输入类型。");
    keys.add(input.key);
  }
  return inputs;
}

export function validateInputReferences(workflow) {
  const inputs = validateInputs(workflowInputs(workflow));
  if (workflow.inputs !== undefined && !inputs.some((input) => input.key === "goal") && workflowInputs({ ...workflow, inputs: undefined }).some((input) => input.key === "goal")) throw new Error("文件路径不能引用任务说明 input.goal，请声明独立输入并绑定文件参数。");
  for (const key of referencedInputs(workflow.nodes)) if (key !== "goal" && !inputs.some((input) => input.key === key)) throw new Error(`节点引用了未声明的输入 ${key}，请先在规划中添加输入或重新绑定。`);
  return inputs;
}

export function mergeInputs(current, incoming) {
  const merged = structuredClone(current);
  for (const input of incoming) {
    const existing = merged.find((item) => item.key === input.key);
    if (existing && (existing.type !== input.type || existing.label !== input.label)) throw new Error(`输入 ${input.key} 与当前定义冲突，请检查输入名称和类型后重试。`);
    if (!existing) merged.push(structuredClone(input));
  }
  return validateInputs(merged);
}

export function bindNodeInput(node, parameter, key) {
  const parts = String(parameter).trim().split(".");
  if (!parts.length || parts.some((part) => !safeKey(part)) || !safeKey(key)) throw new Error("参数名应是安全的属性路径，例如 inputPath 或 options.source。");
  const args = structuredClone(node.arguments || {});
  let target = args;
  for (const part of parts.slice(0, -1)) {
    if (target[part] !== undefined && (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part]))) throw new Error("该参数路径经过一个非对象字段，请使用 JSON 编辑器调整。");
    target = target[part] ??= {};
  }
  target[parts.at(-1)] = `{{input.${key}}}`;
  return args;
}
