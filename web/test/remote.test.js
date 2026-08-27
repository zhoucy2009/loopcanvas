import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseRemoteCommand, RemoteManager, startRemoteServer, verifyWeChatSignature, verifyWhatsAppSignature
} from "../src/remote.js";
import { createLoopCanvasServer } from "../src/server.js";

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-remote-"));
  const manager = await new RemoteManager({
    enabled: true,
    allowInsecure: true,
    baseURL: "http://127.0.0.1:4321",
    dataDirectory: directory,
    ...options
  }).load();
  return { directory, manager };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("remote 命令只接受显式白名单语法", () => {
  assert.deepEqual(parseRemoteCommand("暂停").type, "pause");
  assert.deepEqual(parseRemoteCommand("运行 原设备 https://example.com/a").runLocation, "origin");
  assert.throws(() => parseRemoteCommand("rm -rf /"), /不支持/);
  assert.throws(() => parseRemoteCommand("打开 file:///etc/passwd"), /不支持/);
});

test("一次性配对只签发一枚会话并仅持久化哈希", async () => {
  const { directory, manager } = await fixture();
  try {
    const pairing = await manager.createPairing({ label: "测试手机" });
    assert.match(pairing.qrSVG, /^<svg/);
    const fragment = new URL(pairing.url).hash.slice(1);
    const values = new URLSearchParams(fragment);
    const claimed = await manager.claimPairing({ id: values.get("pairing"), secret: values.get("secret"), deviceName: "iPhone", userAgent: "iPhone" });
    assert.equal(claimed.device.kind, "phone");
    await assert.rejects(() => manager.claimPairing({ id: values.get("pairing"), secret: values.get("secret"), deviceName: "重放" }), /已使用|无效/);
    assert.equal((await manager.authenticate(claimed.token)).id, claimed.device.id);
    const persisted = await readFile(path.join(directory, "remote-state.json"), "utf8");
    assert.doesNotMatch(persisted, new RegExp(claimed.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(persisted, /tokenHash/);
    assert.equal((await stat(path.join(directory, "remote-state.json"))).mode & 0o777, 0o600);
    assert.equal(Object.hasOwn(manager.publicStatus().devices[0], "tokenHash"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Remote 命令默认进入审批，平台重试按消息 ID 去重", async () => {
  const { directory, manager } = await fixture();
  try {
    const first = await manager.enqueueCommand({ channel: "wechat", sender: "openid-1", text: "暂停", messageId: "msg-1" });
    const duplicate = await manager.enqueueCommand({ channel: "wechat", sender: "openid-1", text: "暂停", messageId: "msg-1" });
    assert.equal(first.id, duplicate.id);
    assert.equal(manager.publicStatus().pendingCount, 1);
    assert.equal((await manager.decideCommand(first.id, "approved")).status, "approved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("浏览器设备可接收网页，但不能宣称在本机运行 Agent", async () => {
  const { directory, manager } = await fixture();
  try {
    const pairing = await manager.createPairing();
    const values = new URLSearchParams(new URL(pairing.url).hash.slice(1));
    const claimed = await manager.claimPairing({ id: values.get("pairing"), secret: values.get("secret"), deviceName: "Safari" });
    const event = await manager.createHandoff({ url: "https://example.com", title: "Example", targetDeviceId: claimed.device.id });
    await assert.rejects(() => manager.decideHandoff(claimed.device.id, event.id, "target"), /不能在本设备运行 Agent/);
    assert.equal((await manager.decideHandoff(claimed.device.id, event.id, "origin")).runLocation, "origin");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("微信与 WhatsApp 签名校验拒绝篡改内容", () => {
  const wechat = { token: "token", timestamp: "1700000000", nonce: "nonce" };
  const signature = createHash("sha1").update([wechat.token, wechat.timestamp, wechat.nonce].sort().join("")).digest("hex");
  assert.equal(verifyWeChatSignature({ ...wechat, signature }), true);
  assert.equal(verifyWeChatSignature({ ...wechat, signature: `${signature.slice(0, -1)}0` }), false);
  const rawBody = Buffer.from('{"ok":true}');
  const whatsappSignature = `sha256=${createHmac("sha256", "secret").update(rawBody).digest("hex")}`;
  assert.equal(verifyWhatsAppSignature({ appSecret: "secret", rawBody, signature: whatsappSignature }), true);
  assert.equal(verifyWhatsAppSignature({ appSecret: "secret", rawBody: Buffer.from('{"ok":false}'), signature: whatsappSignature }), false);
});

test("独立 Remote HTTP 服务完成扫码配对并拒绝无令牌控制", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-remote-http-"));
  const manager = await new RemoteManager({ enabled: true, allowInsecure: true, baseURL: "http://127.0.0.1", dataDirectory: directory }).load();
  const runtime = await startRemoteServer({ manager, host: "127.0.0.1", port: 0 });
  try {
    const page = await fetch(`${runtime.url}/remote/`);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(page.headers.get("permissions-policy"), /camera=\(\)/);
    const pairing = await manager.createPairing();
    const values = new URLSearchParams(new URL(pairing.url).hash.slice(1));
    const denied = await fetch(`${runtime.url}/remote/api/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"text":"暂停"}' });
    assert.equal(denied.status, 401);
    const claim = await (await fetch(`${runtime.url}/remote/api/pair/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: values.get("pairing"), secret: values.get("secret"), deviceName: "手机" }) })).json();
    const command = await fetch(`${runtime.url}/remote/api/commands`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${claim.token}` }, body: '{"text":"暂停"}' });
    assert.equal(command.status, 201);
    assert.equal((await command.json()).command.status, "pending");
  } finally {
    await close(runtime.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("本机管理面批准后才把 Remote 消息映射为真实项目暂停", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopcanvas-remote-admin-"));
  const manager = await new RemoteManager({ enabled: true, allowInsecure: true, baseURL: "http://127.0.0.1", dataDirectory: directory }).load();
  const runtime = await createLoopCanvasServer({ dataDirectory: directory, workspace: path.join(directory, "workspace"), remoteManager: manager });
  await new Promise((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(0, "127.0.0.1", resolve);
  });
  const address = runtime.server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
    const headers = { "Content-Type": "application/json", "X-LoopCanvas-Token": bootstrap.token };
    const created = await (await fetch(`${url}/api/projects`, { method: "POST", headers, body: '{"goal":"Remote 审批测试"}' })).json();
    const projectId = created.state.activeProjectId;
    const command = await manager.enqueueCommand({ channel: "whatsapp", sender: "15551234567", text: "暂停", messageId: "admin-e2e-1" });
    assert.equal(runtime.store.project(projectId).isPaused, false);
    const denied = await fetch(`${url}/api/remote/commands/${command.id}/decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"decision":"approved"}' });
    assert.equal(denied.status, 403);
    assert.equal(runtime.store.project(projectId).isPaused, false);
    const approved = await fetch(`${url}/api/remote/commands/${command.id}/decision`, { method: "POST", headers, body: '{"decision":"approved"}' });
    assert.equal(approved.status, 200);
    assert.equal(runtime.store.project(projectId).isPaused, true);
    assert.equal(manager.state.commands.find((item) => item.id === command.id).status, "approved");
  } finally {
    await close(runtime.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("官方 Webhook 路由验证来源和允许发送者", async () => {
  const { directory, manager } = await fixture({
    wechatToken: "wechat-token", wechatAllowedOpenIDs: ["allowed-openid"],
    whatsappAppSecret: "app-secret", whatsappVerifyToken: "verify-token", whatsappAllowedNumbers: ["15551234567"]
  });
  const runtime = await startRemoteServer({ manager, host: "127.0.0.1", port: 0 });
  try {
    const timestamp = "1700000000";
    const nonce = "nonce";
    const signature = createHash("sha1").update(["wechat-token", timestamp, nonce].sort().join("")).digest("hex");
    const verifyURL = `${runtime.url}/webhooks/wechat?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}&echostr=verified`;
    assert.equal(await (await fetch(verifyURL)).text(), "verified");
    const xml = `<xml><ToUserName><![CDATA[service]]></ToUserName><FromUserName><![CDATA[allowed-openid]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[暂停]]></Content><MsgId>wechat-message-1</MsgId></xml>`;
    assert.equal((await fetch(verifyURL, { method: "POST", body: xml })).status, 200);

    const payload = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid-1", from: "15551234567", type: "text", text: { body: "恢复" } }] } }] }] }));
    const waSignature = `sha256=${createHmac("sha256", "app-secret").update(payload).digest("hex")}`;
    const accepted = await fetch(`${runtime.url}/webhooks/whatsapp`, { method: "POST", headers: { "X-Hub-Signature-256": waSignature, "Content-Type": "application/json" }, body: payload });
    assert.equal(accepted.status, 200);
    const tampered = await fetch(`${runtime.url}/webhooks/whatsapp`, { method: "POST", headers: { "X-Hub-Signature-256": waSignature, "Content-Type": "application/json" }, body: '{"tampered":true}' });
    assert.equal(tampered.status, 403);
    assert.equal(manager.state.commands.length, 2);
  } finally {
    await close(runtime.server);
    await rm(directory, { recursive: true, force: true });
  }
});
