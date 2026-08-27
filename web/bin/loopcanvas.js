#!/usr/bin/env node

import { spawn } from "node:child_process";
import { startServer } from "../src/server.js";

function parseArguments(argv) {
  const result = { port: 4317, open: true, remote: process.env.LOOPCANVAS_REMOTE_ENABLED === "1", remoteHost: "127.0.0.1", remotePort: 4321, remoteURL: process.env.LOOPCANVAS_REMOTE_URL ?? "", remoteInsecure: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--no-open") result.open = false;
    if (argv[index] === "--port") result.port = Number(argv[index + 1] || 4317);
    if (argv[index] === "--remote") result.remote = true;
    if (argv[index] === "--remote-host") result.remoteHost = String(argv[index + 1] || "127.0.0.1");
    if (argv[index] === "--remote-port") result.remotePort = Number(argv[index + 1] || 4321);
    if (argv[index] === "--remote-url") result.remoteURL = String(argv[index + 1] || "");
    if (argv[index] === "--remote-insecure-test") result.remoteInsecure = true;
  }
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) {
    throw new Error("--port 必须是 0–65535 之间的整数。");
  }
  if (!Number.isInteger(result.remotePort) || result.remotePort < 0 || result.remotePort > 65535) throw new Error("--remote-port 必须是 0–65535 之间的整数。");
  if (result.remote && !result.remoteURL) throw new Error("开启 Remote 必须通过 --remote-url 或 LOOPCANVAS_REMOTE_URL 提供公共 HTTPS 地址。");
  return result;
}

const list = (value) => String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

try {
  const options = parseArguments(process.argv.slice(2));
  const runtime = await startServer({
    port: options.port,
    remoteHost: options.remoteHost,
    remotePort: options.remotePort,
    remote: {
      enabled: options.remote,
      baseURL: options.remoteURL,
      allowInsecure: options.remoteInsecure,
      wechatToken: process.env.LOOPCANVAS_WECHAT_TOKEN,
      wechatAllowedOpenIDs: list(process.env.LOOPCANVAS_WECHAT_OPENIDS),
      whatsappAppSecret: process.env.LOOPCANVAS_WHATSAPP_APP_SECRET,
      whatsappVerifyToken: process.env.LOOPCANVAS_WHATSAPP_VERIFY_TOKEN,
      whatsappAllowedNumbers: list(process.env.LOOPCANVAS_WHATSAPP_NUMBERS)
    }
  });
  console.log(`DSH Workflow Web 已启动：${runtime.url}`);
  if (runtime.remoteServer) console.log(`Remote 受限入口已启动：${options.remoteURL}（本地代理目标 ${runtime.remoteURL}）`);
  console.log("管理界面和完整 API 仅保留在本机。按 Ctrl+C 停止。");
  if (options.open) openBrowser(runtime.url);
  const stop = () => {
    runtime.remoteServer?.close();
    runtime.server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error) {
  console.error(`DSH Workflow Web 启动失败：${error.message}`);
  process.exit(1);
}
