import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONTENT_CHARS = 80_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 12_000;

function ipv4Parts(address) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

export function isBlockedSourceAddress(value) {
  let address = String(value ?? "").trim().toLowerCase();
  if (address.startsWith("::ffff:")) address = address.slice(7);
  const ipv4 = ipv4Parts(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  if (!address.includes(":")) return true;
  return address === "::" || address === "::1" || address.startsWith("fc") || address.startsWith("fd")
    || /^fe[89ab]/.test(address) || address.startsWith("ff") || address.startsWith("2001:db8:");
}

export function assertPublicSourceURL(value) {
  let url;
  try { url = new URL(String(value ?? "")); } catch { throw new Error("来源链接无效。"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只支持公开 HTTP/HTTPS 来源。");
  if (url.username || url.password) throw new Error("来源链接不能包含账号凭据。");
  if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) {
    throw new Error("只允许公开来源使用标准 80/443 端口。");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("不能读取本机或内部网络来源。");
  }
  if (isIP(hostname) && isBlockedSourceAddress(hostname)) throw new Error("不能读取本机、私网或保留地址。");
  url.hash = "";
  return url;
}

export function validatePublicAddresses(hostname, records) {
  const addresses = (Array.isArray(records) ? records : []).map((record) => typeof record === "string" ? record : record?.address).filter(Boolean);
  if (!addresses.length) throw new Error(`无法解析来源主机：${hostname}`);
  if (addresses.some(isBlockedSourceAddress)) throw new Error("来源解析到了本机、私网或保留地址，已停止读取。");
  return addresses;
}

function decodeEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    }
    return named[entity.toLowerCase()] ?? " ";
  });
}

function plainHTML(value) {
  return decodeEntities(String(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|main|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readableHTML(value) {
  let html = String(value)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript|svg|canvas|nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const main = html.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (main?.[2]) html = main[2];
  let codeBlockCount = 0;
  html = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, block) => {
    const code = plainHTML(block).slice(0, 20_000);
    if (!code) return " ";
    codeBlockCount += 1;
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
  });
  return { content: plainHTML(html), codeBlockCount };
}

export function extractReadableContent(body, contentType = "text/html") {
  const normalizedType = String(contentType).split(";")[0].trim().toLowerCase();
  const supported = normalizedType.startsWith("text/") || normalizedType === "application/json" || normalizedType.endsWith("+json")
    || ["application/javascript", "application/xml", "application/xhtml+xml"].includes(normalizedType);
  if (!supported) throw new Error(`不支持读取 ${normalizedType || "未知格式"} 来源。`);
  const raw = String(body ?? "").replaceAll("\0", "").trim();
  if (!raw) throw new Error("来源返回了空内容。");
  let content;
  let codeBlockCount = 0;
  if (normalizedType.includes("html") || /^\s*(?:<!doctype|<html|<article|<main)/i.test(raw)) {
    ({ content, codeBlockCount } = readableHTML(raw));
  } else if (normalizedType === "application/json" || normalizedType.endsWith("+json")) {
    try { content = JSON.stringify(JSON.parse(raw), null, 2); } catch { content = raw; }
  } else {
    content = raw.replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n");
  }
  if (content.length < 40) throw new Error("页面可读取的正文过少，可能需要登录或动态渲染。");
  const truncated = content.length > MAX_CONTENT_CHARS;
  return { content: content.slice(0, MAX_CONTENT_CHARS), truncated, codeBlockCount };
}

async function resolvePublicAddress(url, lookupHost) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const records = isIP(hostname) ? [{ address: hostname }] : await lookupHost(hostname, { all: true, verbatim: true });
  return validatePublicAddresses(hostname, records)[0];
}

function requestOnce(url, address, { signal, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const tlsHostname = url.hostname.replace(/^\[|\]$/g, "");
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", abort);
      callback(value);
    };
    const request = client.request({
      protocol: url.protocol,
      hostname: address,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      method: "GET",
      path: `${url.pathname}${url.search}`,
      servername: isIP(tlsHostname) ? undefined : tlsHostname,
      headers: {
        Host: url.host,
        Accept: "text/html,text/plain,text/markdown,application/json,application/javascript;q=0.9,*/*;q=0.2",
        "Accept-Encoding": "identity",
        "User-Agent": "LoopCanvas/0.1 public-source-reader"
      }
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        finish(resolve, { redirect: new URL(location, url).href });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(reject, new Error(`来源返回 HTTP ${status}。`));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > maxBytes) {
        response.destroy();
        finish(reject, new Error("来源内容超过 1 MiB 限制。"));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          finish(reject, new Error("来源内容超过 1 MiB 限制。"));
        } else chunks.push(chunk);
      });
      response.on("end", () => finish(resolve, {
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: String(response.headers["content-type"] ?? "text/plain")
      }));
      response.on("error", (error) => finish(reject, error));
    });
    const abort = () => request.destroy(new Error("来源读取已取消。"));
    request.on("error", (error) => finish(reject, error));
    request.setTimeout(timeoutMs, () => request.destroy(new Error("来源读取超时。")));
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
    request.end();
  });
}

async function requestPublicSource(initialURL, options = {}) {
  const lookupHost = options.lookupHost ?? lookup;
  let current = assertPublicSourceURL(initialURL);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const address = await resolvePublicAddress(current, lookupHost);
    const response = await requestOnce(current, address, options);
    if (!response.redirect) return { ...response, finalUrl: current.href };
    if (redirects === MAX_REDIRECTS) throw new Error("来源重定向次数过多。");
    current = assertPublicSourceURL(response.redirect);
  }
  throw new Error("来源读取失败。");
}

export async function extractPublicSource(reference, options = {}) {
  const url = assertPublicSourceURL(reference?.url);
  const response = options.transport ? await options.transport(url.href) : await requestPublicSource(url.href, options);
  const readable = extractReadableContent(response.body, response.contentType);
  return {
    content: readable.content,
    metadata: {
      finalUrl: response.finalUrl || url.href,
      contentType: String(response.contentType ?? "text/plain").slice(0, 160),
      charCount: readable.content.length,
      truncated: readable.truncated,
      codeBlockCount: readable.codeBlockCount
    }
  };
}
