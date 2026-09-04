import { english } from "./translations.js";

const storageKey = "loopcanvas-language";
let language = "en";
try { language = localStorage.getItem(storageKey) === "zh-CN" ? "zh-CN" : "en"; } catch {}

export function getLanguage() { return language; }
export function setLanguage(value) {
  language = value === "zh-CN" ? "zh-CN" : "en";
  try { localStorage.setItem(storageKey, language); } catch {}
  return language;
}

const phrases = Object.keys(english).sort((a, b) => b.length - a.length);
const pattern = new RegExp(phrases.map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");

// Call only with authored UI strings. Never pass user inputs, agent responses,
// file contents, paths, IDs, protocol values, or interpolated template output.
export function t(source) {
  if (language === "zh-CN") return source;
  if (Object.hasOwn(english, source)) return english[source];
  return String(source).replace(pattern, (phrase) => english[phrase]);
}

// Translate static template chunks before interpolating values. This keeps
// user content, source code, URLs, and escaped HTML byte-for-byte intact.
export function ui(parts, ...values) {
  return parts.reduce((result, part, index) => result + t(part) + (index < values.length ? values[index] : ""), "");
}

const staticNodes = new Map();
const registeredRoots = new WeakSet();
export function localizeStatic(root) {
  // Register authored shell nodes once, before dynamic content arrives. Later
  // changes only touch nodes that still contain our last authored translation.
  if (!registeredRoots.has(root)) {
    registeredRoots.add(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (/[\u3400-\u9fff]/.test(node.textContent) && !node.parentElement.closest("script, style, textarea, code, pre, [translate=no]")) {
        staticNodes.set(node, [{ source: node.textContent, previous: node.textContent }]);
      }
    }
    for (const node of root.querySelectorAll("[title], [placeholder], [aria-label]")) {
      if (node.closest("[translate=no]")) continue;
      const records = [];
      for (const attribute of ["title", "placeholder", "aria-label"]) {
        const source = node.getAttribute(attribute);
        if (source && /[\u3400-\u9fff]/.test(source)) records.push({ attribute, source, previous: source });
      }
      if (records.length) staticNodes.set(node, records);
    }
  }
  for (const [node, records] of staticNodes) {
    if (!node.isConnected) { staticNodes.delete(node); continue; }
    for (const record of records) {
      const current = record.attribute ? node.getAttribute(record.attribute) : node.textContent;
      if (current !== record.previous) continue;
      const translated = t(record.source);
      if (record.attribute) node.setAttribute(record.attribute, translated);
      else node.textContent = translated;
      record.previous = translated;
    }
  }
  document.documentElement.lang = language;
}
