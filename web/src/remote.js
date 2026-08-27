import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import QRCode from "qrcode";

const PAIRING_TTL_MS = 5 * 60 * 1_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const COMMAND_LIMIT = 200;
const EVENT_LIMIT = 100;
const BODY_LIMIT = 256 * 1_024;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanLabel(value, fallback, max = 80) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) || fallback;
}

function cleanURL(value) {
  const candidate = new URL(String(value ?? ""));
  if (!['http:', 'https:'].includes(candidate.protocol)) throw new Error("只允许 http 或 https 网页地址。");
  candidate.username = "";
  candidate.password = "";
  return candidate.href.slice(0, 2_000);
}

function publicBaseURL(value, allowInsecure = false) {
  const candidate = new URL(String(value ?? ""));
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(candidate.hostname);
  if (candidate.protocol !== "https:" && !(allowInsecure || loopback)) {
    throw new Error("Remote 配对地址必须使用 HTTPS；仅显式测试模式可使用明文 HTTP。");
  }
  candidate.hash = "";
  candidate.search = "";
  candidate.pathname = candidate.pathname.replace(/\/+$/, "");
  return candidate.href.replace(/\/$/, "");
}

function bearerToken(request) {
  const match = String(request.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

async function readBody(request, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求内容过大。"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(body);
}

function text(response, status, value, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  const body = Buffer.from(String(value));
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders
  });
  response.end(body);
}

function parseJSON(buffer) {
  try { return buffer.length ? JSON.parse(buffer.toString("utf8")) : {}; }
  catch { throw Object.assign(new Error("请求 JSON 无效。"), { statusCode: 400 }); }
}

function xmlEscape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function xmlValue(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml).match(new RegExp(`<${escaped}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${escaped}>`));
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

export function parseRemoteCommand(input) {
  const text = String(input ?? "").trim();
  if (!text || text.length > 2_000) throw new Error("命令为空或过长。");
  if (/^(状态|status)$/i.test(text)) return { type: "status", label: "查看状态", requiresApproval: false };
  if (/^(暂停|pause)$/i.test(text)) return { type: "pause", label: "暂停当前任务", requiresApproval: true };
  if (/^(恢复|resume)$/i.test(text)) return { type: "resume", label: "恢复当前任务", requiresApproval: true };
  const open = text.match(/^(?:打开|open)\s+(https?:\/\/\S+)$/i);
  if (open) return { type: "open_url", label: "打开网页", url: cleanURL(open[1]), requiresApproval: true };
  const run = text.match(/^(?:运行|run)\s+(本设备|here|原设备|origin)\s+(https?:\/\/\S+)$/i);
  if (run) return {
    type: "handoff",
    label: run[1] === "本设备" || run[1].toLowerCase() === "here" ? "在本设备运行" : "在原设备运行",
    runLocation: run[1] === "本设备" || run[1].toLowerCase() === "here" ? "target" : "origin",
    url: cleanURL(run[2]),
    requiresApproval: true
  };
  throw new Error("不支持该命令。可用：状态、暂停、恢复、打开 <https://…>、运行 本设备|原设备 <https://…>。");
}

export function verifyWeChatSignature({ token, timestamp, nonce, signature }) {
  if (![token, timestamp, nonce, signature].every((item) => typeof item === "string" && item.length > 0)) return false;
  const expected = createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
  return safeEqual(expected, signature);
}

export function verifyWhatsAppSignature({ appSecret, rawBody, signature }) {
  if (!appSecret || !Buffer.isBuffer(rawBody) || !String(signature).startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return safeEqual(expected, signature);
}

function channelConfig(options = {}) {
  const wechatAllowed = new Set((options.wechatAllowedOpenIDs ?? []).map(String).filter(Boolean));
  const whatsappAllowed = new Set((options.whatsappAllowedNumbers ?? []).map(String).filter(Boolean));
  return {
    wechat: {
      token: String(options.wechatToken ?? ""),
      allowedSenders: wechatAllowed,
      configured: Boolean(options.wechatToken && wechatAllowed.size),
      mode: "service-account-plaintext"
    },
    whatsapp: {
      appSecret: String(options.whatsappAppSecret ?? ""),
      verifyToken: String(options.whatsappVerifyToken ?? ""),
      allowedSenders: whatsappAllowed,
      configured: Boolean(options.whatsappAppSecret && options.whatsappVerifyToken && whatsappAllowed.size),
      mode: "cloud-api"
    }
  };
}

export class RemoteManager {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.allowInsecure = options.allowInsecure === true;
    this.baseURL = options.baseURL ? publicBaseURL(options.baseURL, this.allowInsecure) : "";
    this.dataFile = path.join(options.dataDirectory, "remote-state.json");
    this.now = options.now ?? (() => Date.now());
    this.channels = channelConfig(options);
    this.pairings = new Map();
    this.state = { version: 1, devices: [], commands: [], events: [] };
  }

  async load() {
    await mkdir(path.dirname(this.dataFile), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.dataFile, "utf8"));
      if (parsed?.version === 1 && Array.isArray(parsed.devices) && Array.isArray(parsed.commands) && Array.isArray(parsed.events)) this.state = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Remote 状态读取失败：${error.message}`);
    }
    return this;
  }

  async persist() {
    const temporary = `${this.dataFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.dataFile);
  }

  assertEnabled() {
    if (!this.enabled) throw Object.assign(new Error("Remote 当前关闭；请以显式 Remote 配置重新启动。"), { statusCode: 409 });
  }

  channelStatus() {
    return {
      wechat: { configured: this.channels.wechat.configured, mode: this.channels.wechat.mode, limitation: "仅微信服务号/测试号明文回调；不支持个人微信自动化。" },
      whatsapp: { configured: this.channels.whatsapp.configured, mode: this.channels.whatsapp.mode, limitation: "接收使用 WhatsApp Cloud API Webhook；未配置主动回复。" }
    };
  }

  publicStatus() {
    const now = this.now();
    return {
      enabled: this.enabled,
      baseURL: this.baseURL,
      transport: this.baseURL?.startsWith("https:") ? "https" : this.baseURL ? "insecure-test" : "unconfigured",
      channels: this.channelStatus(),
      devices: this.state.devices.filter((item) => !item.revokedAt && item.expiresAt > now).map(({ tokenHash, ...item }) => ({ ...item, online: now - item.lastSeenAt < 90_000 })),
      commands: this.state.commands.slice(-50).reverse(),
      pendingCount: this.state.commands.filter((item) => item.status === "pending").length
    };
  }

  async createPairing({ label = "手机浏览器" } = {}) {
    this.assertEnabled();
    if (!this.baseURL) throw new Error("尚未配置 Remote 公共 HTTPS 地址。");
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.pairings.set(id, { id, secretHash: sha256(secret), label: cleanLabel(label, "手机浏览器"), expiresAt, claimedAt: null });
    const url = `${this.baseURL}/remote/#pairing=${encodeURIComponent(id)}&secret=${encodeURIComponent(secret)}`;
    const qrSVG = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2, color: { dark: "#10131a", light: "#ffffff" } });
    return { id, url, qrSVG, expiresAt };
  }

  async claimPairing({ id, secret, deviceName, userAgent = "" }) {
    this.assertEnabled();
    const pairing = this.pairings.get(String(id));
    if (!pairing || pairing.claimedAt || pairing.expiresAt <= this.now() || !safeEqual(pairing.secretHash, sha256(secret))) {
      throw Object.assign(new Error("配对链接无效、已使用或已过期。"), { statusCode: 403 });
    }
    pairing.claimedAt = this.now();
    const token = randomBytes(32).toString("base64url");
    const device = {
      id: randomUUID(),
      name: cleanLabel(deviceName, pairing.label),
      kind: /iphone|android|mobile/i.test(userAgent) ? "phone" : "browser",
      capability: "browser-controller",
      tokenHash: sha256(token),
      pairedAt: this.now(),
      lastSeenAt: this.now(),
      expiresAt: this.now() + SESSION_TTL_MS,
      revokedAt: null
    };
    this.state.devices.push(device);
    await this.persist();
    return { token, device: this.publicDevice(device) };
  }

  publicDevice(device) {
    const { tokenHash, ...publicValue } = device;
    return { ...publicValue, online: this.now() - device.lastSeenAt < 90_000 };
  }

  async authenticate(token) {
    const tokenHash = sha256(token);
    const device = this.state.devices.find((item) => !item.revokedAt && item.expiresAt > this.now() && safeEqual(item.tokenHash, tokenHash));
    if (!device) throw Object.assign(new Error("Remote 设备会话无效或已过期。"), { statusCode: 401 });
    device.lastSeenAt = this.now();
    await this.persist();
    return device;
  }

  async revokeDevice(id) {
    const device = this.state.devices.find((item) => item.id === id && !item.revokedAt);
    if (!device) throw new Error("Remote 设备不存在或已撤销。");
    device.revokedAt = this.now();
    await this.persist();
    return this.publicStatus();
  }

  async enqueueCommand({ channel, sender, text: input, deviceId = null, messageId = null }) {
    this.assertEnabled();
    const normalizedMessageId = messageId ? cleanLabel(messageId, "", 240) : null;
    if (normalizedMessageId) {
      const duplicate = this.state.commands.find((item) => item.channel === channel && item.messageId === normalizedMessageId);
      if (duplicate) return duplicate;
    }
    const command = parseRemoteCommand(input);
    const record = {
      id: randomUUID(),
      channel,
      sender: cleanLabel(sender, "未知发送者", 120),
      deviceId,
      messageId: normalizedMessageId,
      input: String(input).trim().slice(0, 2_000),
      command,
      status: command.requiresApproval ? "pending" : "accepted",
      createdAt: this.now(),
      decidedAt: command.requiresApproval ? null : this.now(),
      decision: command.requiresApproval ? null : "read-only"
    };
    this.state.commands.push(record);
    this.state.commands = this.state.commands.slice(-COMMAND_LIMIT);
    await this.persist();
    return record;
  }

  async decideCommand(id, decision) {
    if (!['approved', 'rejected'].includes(decision)) throw new Error("审批结果无效。");
    const command = this.state.commands.find((item) => item.id === id);
    if (!command || command.status !== "pending") throw new Error("Remote 命令不存在或已处理。");
    command.status = decision;
    command.decision = decision;
    command.decidedAt = this.now();
    await this.persist();
    return command;
  }

  async createHandoff({ url, title, targetDeviceId }) {
    this.assertEnabled();
    const device = this.state.devices.find((item) => item.id === targetDeviceId && !item.revokedAt && item.expiresAt > this.now());
    if (!device) throw new Error("目标设备不存在、已撤销或已过期。");
    const event = {
      id: randomUUID(), type: "handoff", deviceId: device.id, url: cleanURL(url), title: cleanLabel(title, "网页交接", 240),
      status: "awaiting_device", createdAt: this.now(), decidedAt: null, runLocation: null
    };
    this.state.events.push(event);
    this.state.events = this.state.events.slice(-EVENT_LIMIT);
    await this.persist();
    return event;
  }

  eventsFor(deviceId, since = 0) {
    return this.state.events.filter((item) => item.deviceId === deviceId && item.createdAt > Number(since || 0));
  }

  async decideHandoff(deviceId, eventId, runLocation) {
    if (!['target', 'origin'].includes(runLocation)) throw new Error("运行位置无效。");
    const event = this.state.events.find((item) => item.id === eventId && item.deviceId === deviceId);
    if (!event || event.status !== "awaiting_device") throw new Error("网页交接不存在或已处理。");
    if (runLocation === "target") {
      const device = this.state.devices.find((item) => item.id === deviceId);
      if (device?.capability !== "loopcanvas-runtime") {
        throw new Error("此设备只有浏览器控制能力，不能在本设备运行 Agent；可选择在原设备运行。");
      }
    }
    event.status = "accepted";
    event.runLocation = runLocation;
    event.decidedAt = this.now();
    await this.persist();
    return event;
  }
}

function remoteAppHTML() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LoopCanvas Remote</title><link rel="stylesheet" href="/remote/app.css"></head><body><main><header><span class="mark">LC</span><div><strong>LoopCanvas Remote</strong><small id="connection">正在检查配对…</small></div></header><section id="pair" hidden><h1>连接此设备</h1><label>设备名称<input id="device-name" maxlength="80" autocomplete="nickname"></label><button id="claim">完成一次性配对</button></section><section id="control" hidden><h1>控制原设备</h1><form id="command-form"><label>受限命令<input id="command" maxlength="2000" placeholder="状态 / 暂停 / 恢复 / 打开 https://…"></label><button>发送</button></form><p class="note">暂停、恢复、打开与运行必须在原设备的 LoopCanvas 中逐条批准；不会执行任意 shell 文本。</p><div id="events"></div></section><p id="message" role="status"></p></main><script src="/remote/app.js" defer></script></body></html>`;
}

const remoteCSS = `:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#090c11;color:#e8ecf3}*{box-sizing:border-box}body{margin:0}main{max-width:520px;margin:auto;padding:24px}header{display:flex;gap:12px;align-items:center;margin-bottom:30px}.mark{display:grid;place-items:center;width:40px;height:40px;border:1px solid #3b4558;border-radius:12px;background:#151b25;color:#a89cff;font-weight:800}header strong,header small{display:block}header small,.note,#message{margin-top:4px;color:#8d98a9;font-size:13px;line-height:1.55}section{padding:20px;border:1px solid #283142;border-radius:16px;background:#111720}h1{margin:0 0 18px;font-size:22px}label{display:grid;gap:7px;color:#b9c2cf;font-size:13px}input{width:100%;padding:13px;border:1px solid #364156;border-radius:10px;background:#090d14;color:#fff;font:inherit}button,.open-link{width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#7668db;color:#fff;font:inherit;font-weight:700}.event{margin-top:12px;padding:12px;border:1px solid #303a4e;border-radius:11px}.event strong,.event small{display:block}.event small{margin-top:5px;color:#8d98a9;overflow-wrap:anywhere}.open-link{display:block;background:#1a2230;text-align:center;text-decoration:none;font-size:12px}.event-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.event-actions button{font-size:12px}.event-actions button[disabled]{opacity:.45;cursor:not-allowed}`;

const remoteJS = `const $=s=>document.querySelector(s);const key='loopcanvas-remote-session';let session=JSON.parse(localStorage.getItem(key)||'null');const params=new URLSearchParams(location.hash.slice(1));const pairing=params.get('pairing');const secret=params.get('secret');const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function msg(v,e=false){$('#message').textContent=v;$('#message').style.color=e?'#ff9ca7':''}async function call(url,options={}){const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(session?.token?{Authorization:'Bearer '+session.token}:{}),...(options.headers||{})}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'请求失败');return body}function show(){const paired=Boolean(session?.token);$('#pair').hidden=paired||!pairing||!secret;$('#control').hidden=!paired;$('#connection').textContent=paired?'已安全配对':pairing?'等待确认':'请从 LoopCanvas 扫描新的二维码';}$('#device-name').value=/iPhone|Android|Mobile/i.test(navigator.userAgent)?'我的手机':'浏览器设备';$('#claim').onclick=async()=>{try{session=await call('/remote/api/pair/claim',{method:'POST',body:JSON.stringify({id:pairing,secret,deviceName:$('#device-name').value})});localStorage.setItem(key,JSON.stringify(session));history.replaceState(null,'','/remote/');show();msg('配对成功。');poll()}catch(error){msg(error.message,true)}};$('#command-form').onsubmit=async event=>{event.preventDefault();try{const value=$('#command').value;const result=await call('/remote/api/commands',{method:'POST',body:JSON.stringify({text:value})});$('#command').value='';msg(result.command.status==='pending'?'已发送，等待原设备批准。':'已记录状态查询。')}catch(error){msg(error.message,true)}};async function decide(id,runLocation){try{await call('/remote/api/handoffs/'+encodeURIComponent(id)+'/decision',{method:'POST',body:JSON.stringify({runLocation})});msg(runLocation==='origin'?'已选择在原设备运行。':'已选择在本设备运行。');poll()}catch(error){msg(error.message,true)}}async function poll(){if(!session?.token)return;try{const data=await call('/remote/api/events?since=0');const canRun=session.device?.capability==='loopcanvas-runtime';$('#events').innerHTML=data.events.filter(event=>event.status==='awaiting_device').slice(-20).map(event=>'<article class="event"><strong>'+escape(event.title)+'</strong><small>'+escape(event.url)+'</small><a class="open-link" target="_blank" rel="noopener noreferrer" href="'+escape(event.url)+'">在本设备打开网页</a><div class="event-actions"><button data-origin="'+event.id+'">Agent 在原设备运行</button><button data-target="'+event.id+'" '+(canRun?'':'disabled title="当前设备只有浏览器控制能力"')+'>Agent 在本设备运行</button></div></article>').join('');document.querySelectorAll('[data-origin]').forEach(button=>button.onclick=()=>decide(button.dataset.origin,'origin'));document.querySelectorAll('[data-target]:not([disabled])').forEach(button=>button.onclick=()=>decide(button.dataset.target,'target'))}catch(error){if(/会话/.test(error.message)){localStorage.removeItem(key);session=null;show()}msg(error.message,true)}setTimeout(poll,3000)}show();poll();`;

function wechatReply({ to, from, content }) {
  return `<xml><ToUserName><![CDATA[${String(to).replaceAll("]]>", "] ]>")}]]></ToUserName><FromUserName><![CDATA[${String(from).replaceAll("]]>", "] ]>")}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1_000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${String(content).replaceAll("]]>", "] ]>")}]]></Content></xml>`;
}

function whatsappMessages(payload) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  return entries.flatMap((entry) => Array.isArray(entry?.changes) ? entry.changes : []).flatMap((change) => Array.isArray(change?.value?.messages) ? change.value.messages : []).filter((message) => message?.type === "text" && message?.from && message?.text?.body).map((message) => ({ id: String(message.id ?? ""), from: String(message.from), text: String(message.text.body) }));
}

export function createRemoteServer(manager) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && ["/remote", "/remote/"].includes(url.pathname)) return text(response, 200, remoteAppHTML(), "text/html; charset=utf-8", {
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
      });
      if (request.method === "GET" && url.pathname === "/remote/app.css") return text(response, 200, remoteCSS, "text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/remote/app.js") return text(response, 200, remoteJS, "text/javascript; charset=utf-8");

      if (request.method === "POST" && url.pathname === "/remote/api/pair/claim") {
        const body = parseJSON(await readBody(request));
        return json(response, 200, await manager.claimPairing({ ...body, userAgent: String(request.headers["user-agent"] ?? "") }));
      }

      if (url.pathname.startsWith("/remote/api/")) {
        const device = await manager.authenticate(bearerToken(request));
        if (request.method === "GET" && url.pathname === "/remote/api/status") return json(response, 200, { device: manager.publicDevice(device) });
        if (request.method === "GET" && url.pathname === "/remote/api/events") return json(response, 200, { events: manager.eventsFor(device.id, url.searchParams.get("since")) });
        if (request.method === "POST" && url.pathname === "/remote/api/commands") {
          const body = parseJSON(await readBody(request));
          return json(response, 201, { command: await manager.enqueueCommand({ channel: "paired-device", sender: device.name, deviceId: device.id, text: body.text }) });
        }
        const decision = url.pathname.match(/^\/remote\/api\/handoffs\/([^/]+)\/decision$/);
        if (request.method === "POST" && decision) {
          const body = parseJSON(await readBody(request));
          return json(response, 200, { event: await manager.decideHandoff(device.id, decision[1], body.runLocation) });
        }
        return json(response, 404, { error: "Remote 接口不存在。" });
      }

      if (url.pathname === "/webhooks/wechat") {
        const signatureArgs = { token: manager.channels.wechat.token, timestamp: url.searchParams.get("timestamp") ?? "", nonce: url.searchParams.get("nonce") ?? "", signature: url.searchParams.get("signature") ?? "" };
        if (!manager.channels.wechat.configured || !verifyWeChatSignature(signatureArgs)) return text(response, 403, "forbidden");
        if (request.method === "GET") return text(response, 200, url.searchParams.get("echostr") ?? "");
        if (request.method === "POST") {
          const xml = (await readBody(request)).toString("utf8");
          const from = xmlValue(xml, "FromUserName");
          const to = xmlValue(xml, "ToUserName");
          const type = xmlValue(xml, "MsgType");
          const content = xmlValue(xml, "Content");
          if (type !== "text") return text(response, 200, "");
          if (!manager.channels.wechat.allowedSenders.has(from)) return text(response, 403, "forbidden");
          const command = await manager.enqueueCommand({ channel: "wechat", sender: from, text: content, messageId: xmlValue(xml, "MsgId") });
          return text(response, 200, wechatReply({ to: from, from: to, content: command.status === "pending" ? "已送达 LoopCanvas，等待原设备批准。" : "状态查询已送达 LoopCanvas。" }), "application/xml; charset=utf-8");
        }
      }

      if (url.pathname === "/webhooks/whatsapp") {
        const channel = manager.channels.whatsapp;
        if (request.method === "GET") {
          const valid = channel.configured && url.searchParams.get("hub.mode") === "subscribe" && safeEqual(channel.verifyToken, url.searchParams.get("hub.verify_token") ?? "");
          return text(response, valid ? 200 : 403, valid ? (url.searchParams.get("hub.challenge") ?? "") : "forbidden");
        }
        if (request.method === "POST") {
          const body = await readBody(request);
          if (!channel.configured || !verifyWhatsAppSignature({ appSecret: channel.appSecret, rawBody: body, signature: request.headers["x-hub-signature-256"] })) return text(response, 403, "forbidden");
          for (const message of whatsappMessages(parseJSON(body))) {
            if (!channel.allowedSenders.has(message.from)) continue;
            await manager.enqueueCommand({ channel: "whatsapp", sender: message.from, text: message.text, messageId: message.id });
          }
          return text(response, 200, "ok");
        }
      }

      return json(response, 404, { error: "Remote 路由不存在。" });
    } catch (error) {
      return json(response, error.statusCode ?? 400, { error: error?.message || "Remote 请求失败。" });
    }
  });
}

export async function startRemoteServer({ manager, host = "127.0.0.1", port = 4321 } = {}) {
  const server = createRemoteServer(manager);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return { server, url: `http://${host}:${address.port}` };
}
