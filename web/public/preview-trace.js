(() => {
  const SELECT_COLOR = "#f59e0b";
  const pickers = [];
  let selectedDOM = null;
  let selectedOverlay = null;
  let clearSelectedObject = null;

  function showError(message) {
    if (!message || document.getElementById("dshwf-preview-error")) return;
    const panel = document.createElement("div");
    panel.id = "dshwf-preview-error";
    panel.style.cssText = "position:fixed;left:20px;right:20px;top:20px;z-index:2147483647;padding:14px 16px;border:1px solid #d97706;border-radius:10px;background:#fff7ed;color:#9a3412;font:14px/1.45 sans-serif;white-space:pre-wrap;box-shadow:0 10px 30px rgba(0,0,0,.18)";
    panel.textContent = `预览脚本执行失败：${message}`;
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
      if (!picker || typeof picker.pick !== "function") throw new Error("LoopCanvas picker 必须提供 pick(event)");
      pickers.push(picker);
      return () => { const index = pickers.indexOf(picker); if (index >= 0) pickers.splice(index, 1); };
    },
    registerThree({ THREE, scene, camera, renderer, domElement } = {}) {
      const element = domElement || renderer?.domElement;
      if (!THREE?.Raycaster || !THREE?.Vector2 || !scene || !camera || !element) throw new Error("registerThree 需要 THREE、scene、camera 和 renderer/domElement");
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
            label: String(meta.label || object.name || object.type || "Three.js 对象组"),
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
      } catch (error) { showError(`对象拾取失败：${String(error?.message || error)}`); }
    }
    await waitForSelectionPaint();
    parent.postMessage({ type: "loopcanvas:preview-select", version: 3, target: DOMDescriptor(group) }, "*");
  }, true);

  addEventListener("error", (event) => {
    const resource = event.target?.dataset?.loopcanvasRemoteSrc || event.target?.src || event.target?.href;
    showError(event.message || (resource ? `资源加载失败：${resource}` : "脚本或资源加载失败"));
  }, true);
  addEventListener("unhandledrejection", (event) => showError(String(event.reason || "Promise 被拒绝")));
  addEventListener("securitypolicyviolation", (event) => showError(`安全策略阻止资源：${event.blockedURI || event.violatedDirective}`));
})();
