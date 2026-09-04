(() => {
  let previewLanguage = "en";
  const previewEnglish = {"执":"E","执行":"Execute","失败":"Failed","行":"lines","执行失败：":"Execution failed:","预览脚本执行失败：":"Preview script failed:","无":"None","返回了无效边界。":"returned invalid bounds.","是":"Yes","作用范围审查结果必须是数组。":"Interaction region inspection must return an array.","作用范围":"Interaction region","个":" items","个作用范围":"scopes","单个物体最多关联 32 个作用范围。":"An object can have at most 32 interaction regions.","元素":"Element","源码":"Source","该元素已有非像素 translate，无法无损合并；请先在源码中转换为 px。":"This element uses non-pixel translation. Convert it to pixels in the source first.","的":"of","该元素已有无法合并的 scale；请先在源码中改为两个正数。":"This element's scale cannot be merged. Change it to two positive numbers in the source first.","该元素已有旋转、透视或 transform；为避免伪造坐标，本次不自动改写。":"Rotation, perspective, or transforms prevent exact coordinate editing. Source was not changed.","该元素位于已变换的父级中，无法保证视口坐标精确，未改动代码。":"A transformed parent prevents exact viewport coordinates. Source was not changed.","确认":"Confirm","取消":"Cancel","二维编辑":"Layout editor","二维设计编辑":"Layout editor","二维编辑 · 点击要修改的元素":"Layout editor · click an element","Shift 已开启":"Shift enabled","确认并写回代码":"Apply to source","拖动":"Drag","拖动整个元素":"Drag the element","左上角":"top-left corner","上边":"top edge","右上角":"top-right corner","右边":"right edge","右下角":"bottom-right corner","下边":"bottom edge","左下角":"bottom-left corner","左边":"left edge","步":" step","范围：":"Scope:","源码提交没有确认同步作用范围：":"Source commit did not acknowledge interaction regions:","。未写回任何代码。":". No source was changed.","实时预览失败：":"Live preview failed:","该元素没有稳定源码锚点。请添加 data-loopcanvas-group、data-loopcanvas-trace 或 id 后再编辑。":"This element needs a stable source anchor. Add data-loopcanvas-group, data-loopcanvas-trace, or id before editing.","该元素没有可编辑的二维边界。":"This element has no editable 2D bounds.","二维元素":"2D element","几何对象必须提供稳定 traceId 或 groupId。":"Geometry objects require a stable traceId or groupId.","几何适配器":"Geometry adapter","新":"New","该物体的适配器尚未审查作用范围，已阻止移动以避免命中区留在旧位置。请重新生成或补充 inspectInteractionRegions。":"This adapter has not inspected interaction regions. Moving is blocked to avoid stale hit areas. Implement inspectInteractionRegions first.","· 已关联":"· Linked","正在精确写回…":"Applying exact changes…","四角坐标":"Corner coordinates","正在用最终四角坐标替换旧代码":"Updating source with final corner coordinates","LoopCanvas picker 必须提供 pick(event)":"LoopCanvas picker requires pick(event)","二维几何编辑器必须提供 element、pick(event) 与 commit(edit)":"Geometry editors require element, pick(event), and commit(edit)","registerThree 需要 THREE、scene、camera 和 renderer/domElement":"registerThree requires THREE, scene, camera, and renderer/domElement","Three.js 对象组":"Three.js object group","刷新":"Refresh","坐标已写回源码，正在刷新预览":"Coordinates saved to source. Refreshing preview.","代码写回失败":"Could not write source","对象拾取失败：":"Object picking failed:","资源加载失败：":"Resource failed to load:","脚本或资源加载失败":"Script or resource failed to load","拒绝":"Reject","Promise 被拒绝":"Promise rejected","安全策略阻止资源：":"Security policy blocked resource:"};
  const phrases = Object.keys(previewEnglish).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(phrases.map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const t = (source) => previewLanguage === "zh-CN" ? source : source.replace(pattern, (phrase) => previewEnglish[phrase]);
  const ui = (parts, ...values) => parts.reduce((result, part, index) => result + t(part) + (index < values.length ? values[index] : ""), "");
  addEventListener("message", (event) => {
    if (event.source === parent && event.data?.type === "loopcanvas:locale") previewLanguage = event.data.language === "zh-CN" ? "zh-CN" : "en";
  });
  parent.postMessage({ type: "loopcanvas:locale-request" }, "*");

  const SELECT_COLOR = "#f59e0b";
  const DESIGN_COLOR = "#7c5cff";
  const pickers = [];
  const geometryEditors = [];
  let selectedDOM = null;
  let selectedOverlay = null;
  let clearSelectedObject = null;
  let designMode = false;
  let designSelection = null;
  let designLayer = null;
  let designDrag = null;
  let shiftPrimed = false;

  // Report a deliberately marked product root, or a solitary visual surface.
  // Do not crop arbitrary main/section elements: long documents must stay scrollable.
  let previewRoot = null;
  let lastPreviewBounds = "";
  function reportPreviewBounds() {
    if (!previewRoot?.isConnected) return;
    const rect = previewRoot.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.width > 3840 || rect.height > 2160) return;
    const bounds = { width: Math.ceil(rect.width), height: Math.ceil(rect.height), x: Math.max(0, rect.left), y: Math.max(0, rect.top) };
    const signature = JSON.stringify(bounds);
    if (signature === lastPreviewBounds) return;
    lastPreviewBounds = signature;
    parent.postMessage({ type: "loopcanvas:preview-bounds", version: 1, bounds }, "*");
  }
  function observePreviewRoot() {
    previewRoot = document.querySelector("[data-loopcanvas-preview-root]");
    if (!previewRoot) {
      const children = [...(document.body?.children ?? [])].filter((item) => !["SCRIPT", "STYLE", "LINK"].includes(item.tagName));
      if (children.length === 1 && children[0].matches("svg,canvas,img")) previewRoot = children[0];
    }
    if (!previewRoot) return;
    previewRoot.scrollIntoView({ block: "start", inline: "start", behavior: "instant" });
    new ResizeObserver(reportPreviewBounds).observe(previewRoot);
    reportPreviewBounds();
  }
  addEventListener("load", observePreviewRoot, { once: true });
  addEventListener("resize", reportPreviewBounds);
  addEventListener("scroll", reportPreviewBounds);

  function showError(message) {
    if (!message || document.getElementById("dshwf-preview-error")) return;
    const panel = document.createElement("div");
    panel.id = "dshwf-preview-error";
    panel.style.cssText = "position:fixed;left:20px;right:20px;top:20px;z-index:2147483647;padding:14px 16px;border:1px solid #d97706;border-radius:10px;background:#fff7ed;color:#9a3412;font:14px/1.45 sans-serif;white-space:pre-wrap;box-shadow:0 10px 30px rgba(0,0,0,.18)";
    panel.textContent = ui`预览脚本执行失败：${message}`;
    (document.body || document.documentElement).appendChild(panel);
  }

  function elementPath(element) {
    const parts = [];
    for (let current = element; current && current !== document.body && parts.length < 10; current = current.parentElement) {
      const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName) : [];
      const index = siblings.length > 1 ? `:${siblings.indexOf(current) + 1}` : "";
      parts.unshift(`${current.tagName.toLowerCase()}${current.id ? `#${current.id}` : index}`);
    }
    return `dom:${parts.join("/") || element.tagName.toLowerCase()}`;
  }

  function meaningfulDOMGroup(element) {
    const explicit = element.closest("[data-loopcanvas-group],[data-loopcanvas-trace],[data-component]");
    if (explicit) return explicit;
    const interactive = element.closest("button,a,input,textarea,select,summary,[role=button],[role=tab],[role=dialog],[role=menuitem]");
    if (interactive) return interactive;
    if (element instanceof SVGElement) return element.closest("g,[data-name]") || element.closest("svg") || element;
    return element.closest("article,section,form,nav,aside,header,footer,main,figure,canvas") || element;
  }

  function clearDOMSelection() {
    if (selectedDOM) {
      selectedDOM.element.style.outline = selectedDOM.outline;
      selectedDOM.element.style.outlineOffset = selectedDOM.outlineOffset;
      selectedDOM = null;
    }
    selectedOverlay?.remove();
    selectedOverlay = null;
  }

  function selectDOMGroup(element) {
    clearDOMSelection();
    selectedDOM = { element, outline: element.style.outline, outlineOffset: element.style.outlineOffset };
    element.style.outline = `3px solid ${SELECT_COLOR}`;
    element.style.outlineOffset = "3px";
  }

  function selectBounds(element, bounds) {
    clearDOMSelection();
    const rect = element.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;border:3px solid ${SELECT_COLOR};border-radius:4px;left:${rect.left + Number(bounds.x || 0)}px;top:${rect.top + Number(bounds.y || 0)}px;width:${Math.max(0, Number(bounds.width || 0))}px;height:${Math.max(0, Number(bounds.height || 0))}px;box-sizing:border-box`;
    document.documentElement.appendChild(overlay);
    selectedOverlay = overlay;
  }

  function waitForSelectionPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 90)));
  }

  function DOMDescriptor(group) {
    const attributes = {};
    for (const name of ["data-testid", "data-component", "data-loopcanvas-group", "data-loopcanvas-trace", "name", "role", "aria-label", "title", "type"]) {
      const value = group.getAttribute(name);
      if (value) attributes[name] = value;
    }
    return {
      kind: group instanceof SVGElement ? "svg-group" : "dom-group",
      groupId: attributes["data-loopcanvas-group"] || elementPath(group),
      traceId: attributes["data-loopcanvas-trace"] || attributes["data-loopcanvas-group"] || "",
      label: attributes["aria-label"] || attributes.title || attributes["data-component"] || group.id || group.tagName.toLowerCase(),
      element: {
        tag: group.tagName.toLowerCase(),
        id: group.id || "",
        classes: [...group.classList].slice(0, 12),
        text: (group.innerText || group.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
        attributes
      }
    };
  }

  function rounded(value) { return Math.round(Number(value) * 1_000) / 1_000; }
  function precise(value) { return Math.round(Number(value) * 1_000_000_000) / 1_000_000_000; }

  function designCorners(rect) {
    return [
      { x: rounded(rect.x), y: rounded(rect.y) },
      { x: rounded(rect.x + rect.width), y: rounded(rect.y) },
      { x: rounded(rect.x + rect.width), y: rounded(rect.y + rect.height) },
      { x: rounded(rect.x), y: rounded(rect.y + rect.height) }
    ];
  }

  function editorBounds(value, label) {
    const bounds = value?.bounds && typeof value.bounds === "object" ? value.bounds : value;
    const rect = {
      x: Number(bounds?.x), y: Number(bounds?.y),
      width: Number(bounds?.width), height: Number(bounds?.height)
    };
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 2 || rect.height < 2) throw new Error(ui`${label} 返回了无效边界。`);
    return rect;
  }

  function normalizedInteractionRegions(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error(t("作用范围审查结果必须是数组。"));
    if (value.length > 32) throw new Error(t("单个物体最多关联 32 个作用范围。"));
    return value.map((region, index) => ({
      id: String(region?.id || `interaction-${index + 1}`).slice(0, 160),
      label: String(region?.label || region?.id || ui`作用范围 ${index + 1}`).slice(0, 160),
      originalBounds: editorBounds(region, ui`作用范围 ${index + 1}`)
    }));
  }

  function compatibleTranslate(value) {
    if (!value || value === "none") return { x: 0, y: 0 };
    const match = String(value).trim().match(/^(-?\d+(?:\.\d+)?)px(?:\s+(-?\d+(?:\.\d+)?)px)?$/);
    if (!match) throw new Error(t("该元素已有非像素 translate，无法无损合并；请先在源码中转换为 px。"));
    return { x: Number(match[1]), y: Number(match[2] ?? 0) };
  }

  function compatibleScale(value) {
    if (!value || value === "none") return { x: 1, y: 1 };
    const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?$/);
    if (!match) throw new Error(t("该元素已有无法合并的 scale；请先在源码中改为两个正数。"));
    return { x: Number(match[1]), y: Number(match[2] ?? match[1]) };
  }

  function exactDOMAnchor(descriptor) {
    const attributes = descriptor.element?.attributes ?? {};
    return descriptor.traceId || attributes["data-loopcanvas-trace"] || attributes["data-loopcanvas-group"] || descriptor.element?.id || "";
  }

  function assertAxisAlignedContext(element) {
    const transformed = (value) => Boolean(value && value !== "none");
    const own = getComputedStyle(element);
    if (transformed(own.transform) || transformed(own.rotate) || transformed(own.perspective)) throw new Error(t("该元素已有旋转、透视或 transform；为避免伪造坐标，本次不自动改写。"));
    for (let current = element.parentElement; current && current !== document.documentElement; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (transformed(style.transform) || transformed(style.rotate) || transformed(style.translate) || transformed(style.scale) || transformed(style.perspective) || Number(style.zoom || 1) !== 1) {
        throw new Error(t("该元素位于已变换的父级中，无法保证视口坐标精确，未改动代码。"));
      }
    }
  }

  function designCSS() {
    return `
      #loopcanvas-design-layer{position:fixed;inset:0;z-index:2147483645;pointer-events:none;font:12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eef0f6}
      #loopcanvas-design-toolbar{position:fixed;z-index:3;top:12px;left:50%;display:flex;align-items:center;gap:8px;max-width:calc(100vw - 24px);padding:7px 8px 7px 11px;transform:translateX(-50%);border:1px solid rgba(166,144,255,.48);border-radius:9px;background:#12151dcc;box-shadow:0 8px 24px rgba(0,0,0,.26);backdrop-filter:blur(8px);pointer-events:auto}
      #loopcanvas-design-toolbar strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:650}
      #loopcanvas-design-toolbar span{color:#aeb5c5;white-space:nowrap;font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
      #loopcanvas-design-toolbar button{min-height:30px;padding:5px 9px;border:1px solid #3a4050;border-radius:6px;background:#202531;color:#eef0f6;font:600 11px/1 system-ui;cursor:pointer}
      #loopcanvas-design-toolbar button:hover{background:#292f3d}#loopcanvas-design-toolbar button:focus-visible,.loopcanvas-design-handle:focus-visible{outline:2px solid #b5a7ff;outline-offset:2px}
      #loopcanvas-design-confirm{border-color:#8f78ff!important;background:#7256ee!important}#loopcanvas-design-confirm:disabled{opacity:.46;cursor:default}
      .loopcanvas-design-interaction{position:fixed;z-index:1;border:1.5px dashed ${SELECT_COLOR};border-radius:4px;background:rgba(245,158,11,.08);box-sizing:border-box;pointer-events:none}
      .loopcanvas-design-interaction span{position:absolute;left:0;bottom:calc(100% + 3px);max-width:180px;overflow:hidden;text-overflow:ellipsis;padding:2px 5px;border-radius:4px;background:#2a2114e8;color:#ffd799;font:10px/1.35 system-ui;white-space:nowrap}
      #loopcanvas-design-box{position:fixed;z-index:2;border:1.5px solid ${DESIGN_COLOR};box-shadow:0 0 0 1px rgba(255,255,255,.72) inset;box-sizing:border-box;pointer-events:none}
      #loopcanvas-design-move{position:absolute;inset:7px;pointer-events:auto;cursor:move;background:transparent}
      .loopcanvas-design-handle{position:absolute;width:12px;height:12px;padding:0;border:2px solid #fff;border-radius:3px;background:${DESIGN_COLOR};box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:auto}
      .loopcanvas-design-handle[data-handle=nw]{left:0;top:0;transform:translate(-50%,-50%);cursor:nwse-resize}.loopcanvas-design-handle[data-handle=n]{left:50%;top:0;transform:translate(-50%,-50%);cursor:ns-resize}.loopcanvas-design-handle[data-handle=ne]{right:0;top:0;transform:translate(50%,-50%);cursor:nesw-resize}.loopcanvas-design-handle[data-handle=e]{right:0;top:50%;transform:translate(50%,-50%);cursor:ew-resize}.loopcanvas-design-handle[data-handle=se]{right:0;bottom:0;transform:translate(50%,50%);cursor:nwse-resize}.loopcanvas-design-handle[data-handle=s]{left:50%;bottom:0;transform:translate(-50%,50%);cursor:ns-resize}.loopcanvas-design-handle[data-handle=sw]{left:0;bottom:0;transform:translate(-50%,50%);cursor:nesw-resize}.loopcanvas-design-handle[data-handle=w]{left:0;top:50%;transform:translate(-50%,-50%);cursor:ew-resize}
      #loopcanvas-design-coordinates{position:absolute;left:0;top:calc(100% + 9px);display:grid;grid-template-columns:repeat(2,max-content);gap:2px 10px;padding:6px 8px;border:1px solid rgba(124,92,255,.55);border-radius:6px;background:#11141de8;color:#d7dbea;font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;pointer-events:none}
      @media(max-width:520px){#loopcanvas-design-toolbar span{display:none}#loopcanvas-design-toolbar{left:8px;right:8px;transform:none}#loopcanvas-design-coordinates{grid-template-columns:max-content}}
      @media(prefers-reduced-motion:reduce){#loopcanvas-design-toolbar{backdrop-filter:none}}
    `;
  }

  function ensureDesignLayer() {
    if (designLayer?.isConnected) return designLayer;
    const style = document.createElement("style");
    style.id = "loopcanvas-design-style";
    style.textContent = designCSS();
    document.documentElement.appendChild(style);
    designLayer = document.createElement("div");
    designLayer.id = "loopcanvas-design-layer";
    designLayer.innerHTML = t(`<div id="loopcanvas-design-toolbar" role="toolbar" aria-label="二维设计编辑"><strong id="loopcanvas-design-title">二维编辑 · 点击要修改的元素</strong><span id="loopcanvas-design-size">Shift 已开启</span><button id="loopcanvas-design-cancel" type="button">取消</button><button id="loopcanvas-design-confirm" type="button" disabled>确认并写回代码</button></div>`);
    document.documentElement.appendChild(designLayer);
    designLayer.querySelector("#loopcanvas-design-cancel").addEventListener("click", () => closeDesignMode(true));
    designLayer.querySelector("#loopcanvas-design-confirm").addEventListener("click", commitDesignSelection);
    return designLayer;
  }

  function setDesignMessage(message, error = false) {
    const title = ensureDesignLayer().querySelector("#loopcanvas-design-title");
    title.textContent = message;
    title.style.color = error ? "#ffb4b4" : "";
  }

  function restoreDOMPreview(selection) {
    if (!selection?.element || !selection.originalStyle) return;
    for (const [property, value] of Object.entries(selection.originalStyle)) selection.element.style[property] = value;
  }

  function clearDesignSelection({ restore = true, cancel = restore } = {}) {
    if (restore) restoreDOMPreview(designSelection);
    if (cancel) try { designSelection?.editor?.cancel?.({ target: designSelection.target, interactionRegions: originalInteractionRegionPayload(designSelection) }); } catch {}
    designSelection = null;
    designDrag = null;
    designLayer?.querySelector("#loopcanvas-design-box")?.remove();
    designLayer?.querySelectorAll(".loopcanvas-design-interaction").forEach((item) => item.remove());
    const confirm = designLayer?.querySelector("#loopcanvas-design-confirm");
    if (confirm) { confirm.disabled = true; confirm.textContent = t("确认并写回代码"); }
  }

  function closeDesignMode(restore = true) {
    clearDesignSelection({ restore, cancel: restore });
    designMode = false;
    designLayer?.remove();
    designLayer = null;
    document.documentElement.removeAttribute("data-loopcanvas-design-mode");
    parent.postMessage({ type: "loopcanvas:design-state", version: 1, active: false }, "*");
  }

  function openDesignMode() {
    if (designMode) return;
    designMode = true;
    document.documentElement.dataset.loopcanvasDesignMode = "1";
    ensureDesignLayer();
    parent.postMessage({ type: "loopcanvas:design-state", version: 1, active: true }, "*");
  }

  function handleButton(handle, label) {
    return ui`<button type="button" class="loopcanvas-design-handle" data-handle="${handle}" aria-label="拖动${label}"></button>`;
  }

  function renderDesignBox() {
    if (!designSelection) return;
    const rect = designSelection.rect;
    let box = designLayer.querySelector("#loopcanvas-design-box");
    if (!box) {
      box = document.createElement("div");
      box.id = "loopcanvas-design-box";
      box.innerHTML = ui`<div id="loopcanvas-design-move" data-handle="move" aria-label="拖动整个元素"></div>${handleButton("nw", t("左上角"))}${handleButton("n", t("上边"))}${handleButton("ne", t("右上角"))}${handleButton("e", t("右边"))}${handleButton("se", t("右下角"))}${handleButton("s", t("下边"))}${handleButton("sw", t("左下角"))}${handleButton("w", t("左边"))}<div id="loopcanvas-design-coordinates" aria-live="polite"></div>`;
      designLayer.appendChild(box);
      box.querySelectorAll("[data-handle]").forEach((handle) => {
        handle.addEventListener("pointerdown", beginDesignDrag);
        handle.addEventListener("keydown", nudgeDesignHandle);
      });
    }
    Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const corners = designCorners(rect);
    box.querySelector("#loopcanvas-design-coordinates").innerHTML = corners.map((point, index) => `<span>${["TL", "TR", "BR", "BL"][index]} ${point.x}, ${point.y}</span>`).join("");
    const regions = interactionRegionPayload(designSelection);
    designLayer.querySelectorAll(".loopcanvas-design-interaction").forEach((item) => item.remove());
    const host = designSelection.editor?.element?.getBoundingClientRect();
    for (const region of regions) {
      const overlay = document.createElement("div");
      overlay.className = "loopcanvas-design-interaction";
      overlay.setAttribute("aria-hidden", "true");
      Object.assign(overlay.style, {
        left: `${host.left + region.bounds.x}px`, top: `${host.top + region.bounds.y}px`,
        width: `${region.bounds.width}px`, height: `${region.bounds.height}px`
      });
      overlay.innerHTML = `<span>${region.label.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])}</span>`;
      designLayer.insertBefore(overlay, box);
    }
    designLayer.querySelector("#loopcanvas-design-size").textContent = `${rounded(rect.width)} × ${rounded(rect.height)} px${regions.length ? ui` · ${regions.length} 个作用范围` : ""}`;
  }

  function geometryPayload(selection = designSelection) {
    return {
      original: { ...selection.original }, final: { ...selection.rect }, corners: designCorners(selection.rect),
      viewport: { width: innerWidth, height: innerHeight }, base: { ...selection.base },
      interactionRegions: interactionRegionPayload(selection)
    };
  }

  function localEditorBounds(selection) {
    const host = selection.editor.element.getBoundingClientRect();
    return { x: selection.rect.x - host.left, y: selection.rect.y - host.top, width: selection.rect.width, height: selection.rect.height };
  }

  function interactionRegionPayload(selection) {
    if (!selection?.editor || !selection.interactionRegions?.length) return [];
    const finalObject = localEditorBounds(selection);
    const originalObject = selection.localOriginal;
    const scaleX = finalObject.width / originalObject.width;
    const scaleY = finalObject.height / originalObject.height;
    return selection.interactionRegions.map((region) => {
      const originalBounds = region.originalBounds;
      const bounds = {
        x: rounded(finalObject.x + (originalBounds.x - originalObject.x) * scaleX),
        y: rounded(finalObject.y + (originalBounds.y - originalObject.y) * scaleY),
        width: rounded(originalBounds.width * scaleX),
        height: rounded(originalBounds.height * scaleY)
      };
      return { id: region.id, label: region.label, originalBounds: { ...originalBounds }, bounds, corners: designCorners(bounds) };
    });
  }

  function originalInteractionRegionPayload(selection) {
    return (selection?.interactionRegions ?? []).map((region) => ({
      id: region.id, label: region.label, originalBounds: { ...region.originalBounds }, bounds: { ...region.originalBounds }, corners: designCorners(region.originalBounds)
    }));
  }

  function assertInteractionRegionsCommitted(sourceEdit, regions) {
    if (!regions.length) return;
    const committed = Array.isArray(sourceEdit?.interactionRegionIds) ? sourceEdit.interactionRegionIds.map(String) : [];
    const missing = regions.map((region) => region.id).filter((id) => !committed.includes(id));
    if (missing.length) throw new Error(ui`源码提交没有确认同步作用范围：${missing.join("、")}。未写回任何代码。`);
  }

  function applyDesignPreview() {
    if (!designSelection) return;
    const { original, rect, base, element, editor } = designSelection;
    if (element) {
      element.style.translate = `${rounded(base.translateX + rect.x - original.x)}px ${rounded(base.translateY + rect.y - original.y)}px`;
      element.style.scale = `${precise(base.scaleX * rect.width / original.width)} ${precise(base.scaleY * rect.height / original.height)}`;
      element.style.transformOrigin = "0 0";
      element.style.transformBox = element instanceof SVGElement ? "fill-box" : "border-box";
    }
    if (editor?.preview) {
      try { editor.preview({ target: designSelection.target, bounds: localEditorBounds(designSelection), viewportBounds: { ...rect }, corners: designCorners(rect), interactionRegions: interactionRegionPayload(designSelection) }); }
      catch (error) { setDesignMessage(ui`实时预览失败：${String(error?.message || error)}`, true); }
    }
    renderDesignBox();
  }

  function resizedRect(start, handle, dx, dy) {
    if (handle === "move") return { ...start, x: start.x + dx, y: start.y + dy };
    let left = start.x, top = start.y, right = start.x + start.width, bottom = start.y + start.height;
    if (handle.includes("w")) left = Math.min(right - 4, left + dx);
    if (handle.includes("e")) right = Math.max(left + 4, right + dx);
    if (handle.includes("n")) top = Math.min(bottom - 4, top + dy);
    if (handle.includes("s")) bottom = Math.max(top + 4, bottom + dy);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function beginDesignDrag(event) {
    if (!designSelection || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    designDrag = { handle: event.currentTarget.dataset.handle, x: event.clientX, y: event.clientY, rect: { ...designSelection.rect } };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveDesignDrag(event) {
    if (!designDrag || !designSelection) return;
    event.preventDefault();
    designSelection.rect = resizedRect(designDrag.rect, designDrag.handle, event.clientX - designDrag.x, event.clientY - designDrag.y);
    applyDesignPreview();
  }

  function endDesignDrag() { designDrag = null; }

  function nudgeDesignHandle(event) {
    if (!designSelection || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const amount = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
    const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
    designSelection.rect = resizedRect(designSelection.rect, event.currentTarget.dataset.handle, dx, dy);
    applyDesignPreview();
  }

  function selectDOMForDesign(group) {
    const target = DOMDescriptor(group);
    if (!exactDOMAnchor(target)) throw new Error(t("该元素没有稳定源码锚点。请添加 data-loopcanvas-group、data-loopcanvas-trace 或 id 后再编辑。"));
    assertAxisAlignedContext(group);
    const rect = group.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) throw new Error(t("该元素没有可编辑的二维边界。"));
    const translate = compatibleTranslate(group.style.translate);
    const scale = compatibleScale(group.style.scale);
    clearDesignSelection();
    designSelection = {
      target, element: group, editor: null,
      original: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      base: { translateX: translate.x, translateY: translate.y, scaleX: scale.x, scaleY: scale.y },
      originalStyle: { translate: group.style.translate, scale: group.style.scale, transformOrigin: group.style.transformOrigin, transformBox: group.style.transformBox }
    };
    designLayer.querySelector("#loopcanvas-design-confirm").disabled = false;
    setDesignMessage(target.label || target.groupId || t("二维元素"));
    renderDesignBox();
  }

  async function selectEditorForDesign(editor, event) {
    const picked = await editor.pick(event);
    if (!picked?.bounds) return false;
    const { interactionRegions: pickedRegions, ...pickedTarget } = picked;
    const target = { ...pickedTarget, kind: picked.kind || "geometry-object", element: { tag: editor.element.tagName.toLowerCase(), id: editor.element.id || "", classes: [...editor.element.classList], attributes: {} } };
    if (!target.traceId && !target.groupId) throw new Error(t("几何对象必须提供稳定 traceId 或 groupId。"));
    const host = editor.element.getBoundingClientRect();
    const bounds = editorBounds(picked.bounds, t("几何适配器"));
    const rect = { x: host.left + bounds.x, y: host.top + bounds.y, width: bounds.width, height: bounds.height };
    const inspection = typeof editor.inspectInteractionRegions === "function" ? await editor.inspectInteractionRegions({ target, event }) : null;
    const inspectedRegions = Array.isArray(inspection) ? inspection : inspection?.interactionRegions;
    if (typeof editor.inspectInteractionRegions !== "function" && !Object.prototype.hasOwnProperty.call(picked, "interactionRegions")) {
      throw new Error(t("该物体的适配器尚未审查作用范围，已阻止移动以避免命中区留在旧位置。请重新生成或补充 inspectInteractionRegions。"));
    }
    const interactionRegions = normalizedInteractionRegions(inspectedRegions ?? pickedRegions);
    clearDesignSelection();
    designSelection = {
      target, element: null, editor, original: { ...rect }, rect: { ...rect }, localOriginal: { ...bounds }, interactionRegions,
      base: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 }, originalStyle: null
    };
    designLayer.querySelector("#loopcanvas-design-confirm").disabled = false;
    setDesignMessage(`${target.label || target.traceId || target.groupId}${interactionRegions.length ? ui` · 已关联 ${interactionRegions.length} 个作用范围` : ""}`);
    renderDesignBox();
    return true;
  }

  async function commitDesignSelection() {
    if (!designSelection) return;
    const confirm = designLayer.querySelector("#loopcanvas-design-confirm");
    confirm.disabled = true;
    confirm.textContent = t("正在精确写回…");
    setDesignMessage(t("正在用最终四角坐标替换旧代码"));
    try {
      const geometry = geometryPayload();
      const sourceEdit = designSelection.editor?.commit ? await designSelection.editor.commit({ target: designSelection.target, bounds: localEditorBounds(designSelection), viewportBounds: { ...designSelection.rect }, corners: geometry.corners, originalBounds: { ...designSelection.original }, interactionRegions: geometry.interactionRegions }) : null;
      assertInteractionRegionsCommitted(sourceEdit, geometry.interactionRegions);
      parent.postMessage({ type: "loopcanvas:design-commit", version: 1, target: designSelection.target, geometry, sourceEdit: sourceEdit || null }, "*");
    } catch (error) {
      confirm.disabled = false;
      confirm.textContent = t("确认并写回代码");
      setDesignMessage(String(error?.message || error), true);
    }
  }

  const traceAPI = {
    version: 3,
    group(object, traceId, label = "") {
      if (!object || !traceId) return object;
      object.userData = object.userData || {};
      object.userData.loopcanvas = { ...(object.userData.loopcanvas || {}), traceId: String(traceId), label: String(label || object.name || ""), group: true };
      return object;
    },
    mark(object, traceId, label = "") { return this.group(object, traceId, label); },
    registerPicker(picker) {
      if (!picker || typeof picker.pick !== "function") throw new Error(t("LoopCanvas picker 必须提供 pick(event)"));
      pickers.push(picker);
      return () => { const index = pickers.indexOf(picker); if (index >= 0) pickers.splice(index, 1); };
    },
    registerGeometryEditor(editor) {
      if (!editor?.element || typeof editor.pick !== "function" || typeof editor.commit !== "function") throw new Error(t("二维几何编辑器必须提供 element、pick(event) 与 commit(edit)"));
      geometryEditors.push(editor);
      return () => { const index = geometryEditors.indexOf(editor); if (index >= 0) geometryEditors.splice(index, 1); };
    },
    registerThree({ THREE, scene, camera, renderer, domElement } = {}) {
      const element = domElement || renderer?.domElement;
      if (!THREE?.Raycaster || !THREE?.Vector2 || !scene || !camera || !element) throw new Error(t("registerThree 需要 THREE、scene、camera 和 renderer/domElement"));
      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      return this.registerPicker({
        element,
        pick(event) {
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects(scene.children, true).find((entry) => !entry.object.userData?.loopcanvasSelectionHelper);
          if (!hit) return null;
          let object = hit.object;
          for (let current = hit.object; current && current !== scene; current = current.parent) {
            if (current.userData?.loopcanvas?.group || current.userData?.loopcanvas?.traceId) { object = current; break; }
          }
          const objectPath = [];
          for (let current = object; current && current !== scene; current = current.parent) objectPath.unshift(current.name || current.type || current.uuid);
          clearSelectedObject?.();
          if (THREE.BoxHelper) {
            const helper = new THREE.BoxHelper(object, 0xf59e0b);
            helper.userData.loopcanvasSelectionHelper = true;
            scene.add(helper);
            renderer?.render?.(scene, camera);
            clearSelectedObject = () => { scene.remove(helper); helper.geometry?.dispose?.(); helper.material?.dispose?.(); };
          }
          const meta = object.userData?.loopcanvas || {};
          return {
            kind: "three-group",
            groupId: String(meta.traceId || `three:${objectPath.join("/")}`),
            traceId: String(meta.traceId || ""),
            label: String(meta.label || object.name || object.type || t("Three.js 对象组")),
            objectUuid: object.uuid || "",
            objectName: object.name || "",
            objectPath: objectPath.slice(-12),
            instanceId: Number.isInteger(hit.instanceId) ? hit.instanceId : null,
            faceIndex: Number.isInteger(hit.faceIndex) ? hit.faceIndex : null,
            materialIndex: Number.isInteger(hit.face?.materialIndex) ? hit.face.materialIndex : null,
            worldPoint: hit.point?.toArray?.().slice(0, 3) || []
          };
        }
      });
    }
  };

  window.__loopcanvasTrace = traceAPI;

  document.documentElement.dataset.loopcanvasTraceVersion = "3";

  addEventListener("pointermove", moveDesignDrag, true);
  addEventListener("pointerup", endDesignDrag, true);
  addEventListener("pointercancel", endDesignDrag, true);

  addEventListener("keydown", (event) => {
    if (designMode) {
      if (event.key === "Escape") { event.preventDefault(); closeDesignMode(true); }
      return;
    }
    if (event.key === "Shift" && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && !(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable=true]"))) {
      shiftPrimed = true;
      openDesignMode();
    }
    else shiftPrimed = false;
  }, true);

  addEventListener("keyup", (event) => {
    if (event.key !== "Shift") return;
    shiftPrimed = false;
  }, true);

  addEventListener("click", async (event) => {
    if (!designMode || event.metaKey || event.ctrlKey || event.button !== 0 || event.target instanceof Element && event.target.closest("#loopcanvas-design-layer")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    try {
      for (const editor of [...geometryEditors].reverse()) {
        if (editor.element !== element && !editor.element.contains?.(element)) continue;
        if (await selectEditorForDesign(editor, event)) return;
      }
      selectDOMForDesign(meaningfulDOMGroup(element));
    } catch (error) { setDesignMessage(String(error?.message || error), true); }
  }, true);

  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    if (event.data?.type === "loopcanvas:design-open" && event.data?.version === 1) {
      openDesignMode();
      return;
    }
    if (event.data?.type !== "loopcanvas:design-result") return;
    if (event.data.ok) {
      setDesignMessage(t("坐标已写回源码，正在刷新预览"));
      closeDesignMode(false);
    } else {
      const confirm = designLayer?.querySelector("#loopcanvas-design-confirm");
      if (confirm) { confirm.disabled = false; confirm.textContent = t("确认并写回代码"); }
      setDesignMessage(String(event.data.error || t("代码写回失败")), true);
    }
  });

  addEventListener("click", async (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    const group = meaningfulDOMGroup(element);
    selectDOMGroup(group);
    for (const picker of [...pickers].reverse()) {
      if (picker.element && picker.element !== element && !picker.element.contains?.(element)) continue;
      try {
        const picked = await picker.pick(event);
        if (!picked) continue;
        if (picked.bounds && picker.element) selectBounds(picker.element, picked.bounds);
        else if (picked.kind !== "dom-group" && picked.kind !== "svg-group") clearDOMSelection();
        await waitForSelectionPaint();
        parent.postMessage({ type: "loopcanvas:preview-select", version: 3, target: picked }, "*");
        return;
      } catch (error) { showError(ui`对象拾取失败：${String(error?.message || error)}`); }
    }
    await waitForSelectionPaint();
    parent.postMessage({ type: "loopcanvas:preview-select", version: 3, target: DOMDescriptor(group) }, "*");
  }, true);

  addEventListener("error", (event) => {
    const resource = event.target?.dataset?.loopcanvasRemoteSrc || event.target?.src || event.target?.href;
    showError(event.message || (resource ? ui`资源加载失败：${resource}` : t("脚本或资源加载失败")));
  }, true);
  addEventListener("unhandledrejection", (event) => showError(String(event.reason || t("Promise 被拒绝"))));
  addEventListener("securitypolicyviolation", (event) => showError(ui`安全策略阻止资源：${event.blockedURI || event.violatedDirective}`));
})();
