import path from "node:path";

const MAX_COORDINATE = 1_000_000;
const EDITABLE_SOURCE_EXTENSIONS = new Set([".html", ".htm", ".svg"]);

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > MAX_COORDINATE) throw new Error(`${label} 不是有效坐标。`);
  return number;
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

function precise(value) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function geometryRect(value, label) {
  const rect = value && typeof value === "object" ? value : {};
  const normalized = {
    x: finiteNumber(rect.x, `${label}.x`),
    y: finiteNumber(rect.y, `${label}.y`),
    width: finiteNumber(rect.width, `${label}.width`),
    height: finiteNumber(rect.height, `${label}.height`)
  };
  if (normalized.width < 2 || normalized.height < 2) throw new Error(`${label} 的宽高不能小于 2px。`);
  return normalized;
}

function baseGeometry(value) {
  const base = value && typeof value === "object" ? value : {};
  const normalized = {
    translateX: finiteNumber(base.translateX ?? 0, "base.translateX"),
    translateY: finiteNumber(base.translateY ?? 0, "base.translateY"),
    scaleX: finiteNumber(base.scaleX ?? 1, "base.scaleX"),
    scaleY: finiteNumber(base.scaleY ?? 1, "base.scaleY")
  };
  if (normalized.scaleX <= 0 || normalized.scaleY <= 0) throw new Error("基础缩放必须大于 0。");
  return normalized;
}

function cornersFor(rect) {
  return [
    { x: rounded(rect.x), y: rounded(rect.y) },
    { x: rounded(rect.x + rect.width), y: rounded(rect.y) },
    { x: rounded(rect.x + rect.width), y: rounded(rect.y + rect.height) },
    { x: rounded(rect.x), y: rounded(rect.y + rect.height) }
  ];
}

export function normalizeGeometryEdit(raw = {}) {
  const original = geometryRect(raw.original, "original");
  const final = geometryRect(raw.final, "final");
  const base = baseGeometry(raw.base);
  const expectedCorners = cornersFor(final);
  if (Array.isArray(raw.corners)) {
    if (raw.corners.length !== 4) throw new Error("必须提交四个角坐标。");
    raw.corners.forEach((corner, index) => {
      const x = finiteNumber(corner?.x, `corners[${index}].x`);
      const y = finiteNumber(corner?.y, `corners[${index}].y`);
      if (Math.abs(x - expectedCorners[index].x) > 0.51 || Math.abs(y - expectedCorners[index].y) > 0.51) throw new Error("四角坐标与最终矩形不一致。");
    });
  }
  const scaleX = precise(base.scaleX * final.width / original.width);
  const scaleY = precise(base.scaleY * final.height / original.height);
  if (scaleX <= 0 || scaleY <= 0 || scaleX > 1_000 || scaleY > 1_000) throw new Error("最终缩放超出可写入范围。");
  return {
    original,
    final,
    corners: expectedCorners,
    viewport: {
      width: Math.max(0, rounded(finiteNumber(raw.viewport?.width ?? 0, "viewport.width"))),
      height: Math.max(0, rounded(finiteNumber(raw.viewport?.height ?? 0, "viewport.height")))
    },
    translateX: rounded(base.translateX + final.x - original.x),
    translateY: rounded(base.translateY + final.y - original.y),
    scaleX,
    scaleY
  };
}

function escapedPattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactAnchor(target = {}) {
  const attributes = target.element?.attributes && typeof target.element.attributes === "object" ? target.element.attributes : {};
  const candidates = [
    ["data-loopcanvas-trace", attributes["data-loopcanvas-trace"]],
    ["data-loopcanvas-group", attributes["data-loopcanvas-group"] || (/^(?!dom:)/.test(String(target.groupId ?? "")) ? target.groupId : "")],
    ["id", target.element?.id]
  ];
  const [name, value] = candidates.find(([, candidate]) => String(candidate ?? "").trim()) ?? [];
  if (!name) throw new Error("这个元素缺少可唯一回写的 data-loopcanvas-trace、data-loopcanvas-group 或 id。");
  return { name, value: String(value).trim().slice(0, 320), tag: String(target.element?.tag ?? "").trim().toLowerCase().slice(0, 40) };
}

function styleWithGeometry(style, edit, transformBox) {
  const managed = new Set(["translate", "scale", "transform-origin", "transform-box"]);
  const declarations = String(style ?? "").split(";").map((item) => item.trim()).filter(Boolean).filter((item) => !managed.has(item.split(":", 1)[0].trim().toLowerCase()));
  declarations.push(
    `translate: ${edit.translateX}px ${edit.translateY}px`,
    `scale: ${edit.scaleX} ${edit.scaleY}`,
    "transform-origin: 0 0",
    `transform-box: ${transformBox}`
  );
  return `${declarations.join("; ")};`;
}

function geometryMarker(edit) {
  const points = edit.corners.map((point) => `${point.x},${point.y}`).join(";");
  return `${points}@${edit.viewport.width}x${edit.viewport.height}`;
}

function appendTagAttribute(tag, attribute) {
  const closing = tag.match(/\s*\/?>$/)?.[0] ?? ">";
  return `${tag.slice(0, -closing.length)} ${attribute}${closing}`;
}

export function applyDOMGeometryToSource(source, target, rawGeometry) {
  const edit = normalizeGeometryEdit(rawGeometry);
  const anchor = exactAnchor(target);
  const tagPattern = anchor.tag ? escapedPattern(anchor.tag) : "[A-Za-z][\\w:-]*";
  const candidates = [...String(source).matchAll(new RegExp(`<${tagPattern}\\b[^<>]*>`, "gi"))].filter((match) => {
    const attribute = new RegExp(`\\b${escapedPattern(anchor.name)}\\s*=\\s*(["'])${escapedPattern(anchor.value)}\\1`, "i");
    return attribute.test(match[0]);
  });
  if (candidates.length !== 1) throw new Error(candidates.length ? "源码锚点不唯一，已拒绝凭推测改代码。" : "源码中找不到精确元素锚点，未改动代码。");
  const matched = candidates[0];
  let tag = matched[0];
  const styleMatch = tag.match(/\bstyle\s*=\s*(["'])(.*?)\1/i);
  const nextStyle = styleWithGeometry(styleMatch?.[2] ?? "", edit, target.kind === "svg-group" ? "fill-box" : "border-box").replaceAll('"', "&quot;");
  if (styleMatch) tag = `${tag.slice(0, styleMatch.index)}style=${styleMatch[1]}${nextStyle}${styleMatch[1]}${tag.slice(styleMatch.index + styleMatch[0].length)}`;
  else tag = appendTagAttribute(tag, `style="${nextStyle}"`);
  const marker = geometryMarker(edit);
  const markerMatch = tag.match(/\bdata-loopcanvas-geometry\s*=\s*(["'])(.*?)\1/i);
  if (markerMatch) tag = `${tag.slice(0, markerMatch.index)}data-loopcanvas-geometry=${markerMatch[1]}${marker}${markerMatch[1]}${tag.slice(markerMatch.index + markerMatch[0].length)}`;
  else tag = appendTagAttribute(tag, `data-loopcanvas-geometry="${marker}"`);
  return {
    content: `${String(source).slice(0, matched.index)}${tag}${String(source).slice(matched.index + matched[0].length)}`,
    edit,
    anchor: `${anchor.name}=${anchor.value}`
  };
}

export function validateDirectSourceEdit(raw = {}) {
  const sourcePath = String(raw.path ?? "").replaceAll("\\", "/").trim();
  const oldText = String(raw.oldText ?? "");
  const newText = String(raw.newText ?? "");
  if (!sourcePath || path.isAbsolute(sourcePath) || sourcePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Canvas 几何适配器返回了无效源码路径。");
  if (!oldText || oldText.length > 20_000 || newText.length > 20_000) throw new Error("Canvas 源码替换片段必须为 1–20000 字符。");
  if (oldText === newText) throw new Error("Canvas 几何适配器没有返回实际代码变化。");
  return { path: sourcePath, oldText, newText };
}

export function applyDirectSourceEdit(source, rawEdit) {
  const edit = validateDirectSourceEdit(rawEdit);
  const first = String(source).indexOf(edit.oldText);
  const second = first < 0 ? -1 : String(source).indexOf(edit.oldText, first + edit.oldText.length);
  if (first < 0) throw new Error("Canvas 适配器提供的旧代码已变化，未覆盖任何内容。");
  if (second >= 0) throw new Error("Canvas 适配器提供的旧代码不唯一，已拒绝替换。");
  return { content: `${String(source).slice(0, first)}${edit.newText}${String(source).slice(first + edit.oldText.length)}`, edit };
}

export function isDeclarativeGeometrySource(filename) {
  return EDITABLE_SOURCE_EXTENSIONS.has(path.extname(String(filename)).toLowerCase());
}
