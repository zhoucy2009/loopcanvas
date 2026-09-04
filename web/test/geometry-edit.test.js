import test from "node:test";
import assert from "node:assert/strict";
import { applyDirectSourceEdit, applyDOMGeometryToSource, normalizeGeometryEdit } from "../src/geometry-edit.js";

const geometry = {
  original: { x: 20, y: 30, width: 100, height: 50 },
  final: { x: 28, y: 24, width: 140, height: 80 },
  corners: [{ x: 28, y: 24 }, { x: 168, y: 24 }, { x: 168, y: 104 }, { x: 28, y: 104 }],
  viewport: { width: 1280, height: 720 },
  base: { translateX: 2, translateY: 3, scaleX: 1, scaleY: 1 }
};

test("二维编辑按最终四角计算确定性 translate/scale", () => {
  const edit = normalizeGeometryEdit(geometry);
  assert.equal(edit.translateX, 10);
  assert.equal(edit.translateY, -3);
  assert.equal(edit.scaleX, 1.4);
  assert.equal(edit.scaleY, 1.6);
  assert.deepEqual(edit.corners, geometry.corners);
});

test("DOM 几何编辑只按唯一稳定锚点修改原标签并记录四角", () => {
  const source = '<main><button data-loopcanvas-group="save-action" style="color: red; translate: 2px 3px;">保存</button></main>';
  const patched = applyDOMGeometryToSource(source, {
    kind: "dom-group", groupId: "save-action", traceId: "", label: "保存",
    element: { tag: "button", id: "", classes: [], attributes: { "data-loopcanvas-group": "save-action" } }
  }, geometry);
  assert.match(patched.content, /color: red/);
  assert.match(patched.content, /translate: 10px -3px/);
  assert.match(patched.content, /scale: 1\.4 1\.6/);
  assert.match(patched.content, /data-loopcanvas-geometry="28,24;168,24;168,104;28,104@1280x720"/);
  assert.equal((patched.content.match(/translate:/g) ?? []).length, 1);
});

test("DOM 锚点重复时拒绝凭推测覆盖", () => {
  const source = '<button id="same">A</button><button id="same">B</button>';
  assert.throws(() => applyDOMGeometryToSource(source, { element: { tag: "button", id: "same", attributes: {} } }, geometry), /不唯一/);
});

test("SVG 自闭合标签保持合法并使用 fill-box", () => {
  const source = '<svg><rect data-loopcanvas-group="shape" x="0" y="0" width="100" height="50" /></svg>';
  const patched = applyDOMGeometryToSource(source, {
    kind: "svg-group", groupId: "shape", element: { tag: "rect", id: "", attributes: { "data-loopcanvas-group": "shape" } }
  }, geometry);
  assert.match(patched.content, /<rect[^>]+style="[^"]*transform-box: fill-box;"[^>]+\/>/);
  assert.doesNotMatch(patched.content, /\/ style=/);
});

test("Canvas 适配器只能做旧文本唯一命中的原位替换", () => {
  const edit = { path: "scene.js", oldText: "const box = { x: 10, y: 20 };", newText: "const box = { x: 18, y: 14 };" };
  assert.equal(applyDirectSourceEdit(`start\n${edit.oldText}\nend`, edit).content, `start\n${edit.newText}\nend`);
  assert.throws(() => applyDirectSourceEdit(`${edit.oldText}\n${edit.oldText}`, edit), /不唯一/);
});
