import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicSourceURL, extractPublicSource, extractReadableContent, isBlockedSourceAddress, validatePublicAddresses
} from "../src/source-content.js";

test("来源读取拒绝本机、私网、保留地址与自定义端口", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.2", "169.254.1.1", "::1", "fc00::1", "2001:db8::1"]) {
    assert.equal(isBlockedSourceAddress(address), true, address);
  }
  assert.throws(() => assertPublicSourceURL("http://localhost/page"), /本机或内部网络/);
  assert.throws(() => assertPublicSourceURL("http://[::1]/page"), /私网或保留地址/);
  assert.throws(() => assertPublicSourceURL("https://example.com:8443/page"), /标准 80\/443 端口/);
  assert.throws(() => validatePublicAddresses("mixed.example", [{ address: "93.184.216.34" }, { address: "127.0.0.1" }]), /私网或保留地址/);
});

test("HTML 来源优先提取正文并保留代码块", () => {
  const html = `<!doctype html><html><body><nav>菜单噪音</nav><main><h1>解析标题</h1><p>这里是足够长的正文内容，用于确认学习模式拿到的是网页内容而不只是探索简介。</p><pre><code>const answer = 42;\nconsole.log(answer);</code></pre></main><footer>页脚噪音</footer></body></html>`;
  const result = extractReadableContent(html, "text/html; charset=utf-8");
  assert.match(result.content, /解析标题/);
  assert.match(result.content, /```\nconst answer = 42/);
  assert.doesNotMatch(result.content, /菜单噪音|页脚噪音/);
  assert.equal(result.codeBlockCount, 1);
});

test("来源解析返回正文及可追溯元数据", async () => {
  const result = await extractPublicSource({ url: "https://example.com/data.json" }, {
    transport: async () => ({ body: JSON.stringify({ component: "canvas", enabled: true }), contentType: "application/json", finalUrl: "https://example.com/data.json" })
  });
  assert.match(result.content, /"component": "canvas"/);
  assert.equal(result.metadata.contentType, "application/json");
  assert.equal(result.metadata.finalUrl, "https://example.com/data.json");
  assert.equal(result.metadata.truncated, false);
});

test("SVG 来源保留可供 Agent 审计的矢量源码", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#615ced" d="M8 32c0-14 10-24 24-24s24 10 24 24-10 24-24 24S8 46 8 32Z"/></svg>`;
  const result = extractReadableContent(svg, "image/svg+xml");
  assert.match(result.content, /viewBox="0 0 64 64"/);
  assert.match(result.content, /fill="#615ced"/);
});

test("来源正文限制为 80000 字符并标记截断", () => {
  const result = extractReadableContent("x".repeat(90_000), "text/plain");
  assert.equal(result.content.length, 80_000);
  assert.equal(result.truncated, true);
});
