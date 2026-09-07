#!/usr/bin/env node

import { spawn } from "node:child_process";
import { startCodexAutoUpdates } from "../src/codex-installation.js";


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
    throw new Error("--port must be an integer between 0 and 65535.");
  }
  if (!Number.isInteger(result.remotePort) || result.remotePort < 0 || result.remotePort > 65535) throw new Error("--remote-port must be an integer between 0 and 65535.");
  if (result.remote && !result.remoteURL) throw new Error("Remote requires a public HTTPS URL via --remote-url or LOOPCANVAS_REMOTE_URL.");
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
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 or newer is required. Please upgrade Node.js before starting LoopCanvas.");
  const { startServer } = await import("../src/server.js");
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
  console.log(`LoopCanvas is running at ${runtime.url}`);
  if (runtime.remoteServer) console.log(`Restricted Remote listener: ${options.remoteURL} (local proxy target: ${runtime.remoteURL})`);
  console.log("The admin UI and full API are local only. Press Ctrl+C to stop.");
  const codexUpdates = startCodexAutoUpdates({
    settings: () => runtime.store.state.settings,
    onResult: (result) => {
      if (result.status === "updated") console.log(`Codex updated: ${result.before} → ${result.after}. New calls use the newest installed version.`);
      if (result.status === "current") console.log(`Codex ${result.after} is up to date. Next check in 6 hours.`);
    },
    onError: (error) => console.warn(`Codex auto-update failed; the installed runtime remains available. Will retry in 6 hours: ${error.message}`)
  });
  runtime.server.once("close", () => codexUpdates.stop());
  if (options.open) openBrowser(runtime.url);
  const stop = () => {
    codexUpdates.stop();
    runtime.remoteServer?.close();
    runtime.server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error) {
  console.error(`LoopCanvas failed to start: ${error.message}`);
  process.exit(1);
}
