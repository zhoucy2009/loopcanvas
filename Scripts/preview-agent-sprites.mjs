// Isolated visual test surface: no user projects, microphone or model requests.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const publicRoot = new URL("../web/public/", import.meta.url);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>精灵动画验证</title><link rel="stylesheet" href="/styles.css"><body><div class="app-shell"><aside class="sidebar"><strong>LoopCanvas</strong><p>独立动画验证</p><button id="new" class="primary">开一个新需求</button></aside><main class="main-area"><div id="agent-stage" class="agent-stage"></div><header class="topbar"><h1>精灵动画验证 · 不调用 Agent</h1></header><section class="workspace"><p>使用真实渲染器验证角色切换、并发占用和归队；这里的任务均为测试数据。</p><div style="display:flex;flex-wrap:wrap;gap:12px"><button data-role="intake">提交提示词</button><button data-role="plan">开始计划</button><button data-role="execute">开始执行</button><button data-role="review">开始审核</button><button id="second">再启动一个执行</button><button id="one">结束一个执行</button><button id="done">全部结束</button><button id="reduced">减少动态效果</button><button id="harness">切换 DeepSeek / Codex</button></div><p id="result" role="status"></p><p style="height:1100px">此区域可滚动，胶囊保持右上角。</p></section></main></div><script type="module">
import {AgentSprites} from '/agent-sprites.js';
let reduced=false, deepseek=false;
const stage=new AgentSprites(document.querySelector('#agent-stage'),{reducedMotion:()=>reduced});
let jobs=[], projectId='test', sequence=0;
stage.setProject(projectId);
const report=()=>{document.querySelector('#result').textContent='当前需求：'+projectId+' · 本需求 '+jobs.filter(j=>j.projectId===projectId).length+' 个测试工作 · 全部需求 '+jobs.length+' 个测试工作';stage.sync(jobs)};
const projects=document.createElement('div');document.querySelector('#result').before(projects);
const addProjectButton=(id)=>{const button=document.createElement('button');button.textContent='切换到 '+id;button.onclick=()=>{projectId=id;stage.setProject(id);report()};projects.append(button)};
addProjectButton(projectId);
document.querySelector('#new').onclick=()=>{projectId='new-'+(++sequence);addProjectButton(projectId);stage.setProject(projectId);report();stage.gather()};
document.querySelectorAll('[data-role]').forEach(button=>button.onclick=()=>{const role=button.dataset.role;if(role==='intake'){stage.handoff(projectId);return;}jobs.push({id:crypto.randomUUID(),role,projectId});report()});
document.querySelector('#second').onclick=()=>{jobs.push({id:crypto.randomUUID(),role:'execute',projectId});report()};
document.querySelector('#one').onclick=()=>{const index=jobs.findIndex(j=>j.role==='execute'&&j.projectId===projectId);if(index>=0)jobs.splice(index,1);report()};
document.querySelector('#done').onclick=()=>{jobs=jobs.filter(j=>j.projectId!==projectId);report()};
document.querySelector('#reduced').onclick=()=>{reduced=!reduced;document.querySelector('#reduced').textContent=reduced?'减少动态效果：开启':'减少动态效果：关闭'};
document.querySelector('#harness').onclick=()=>{deepseek=!deepseek;stage.setHarness(deepseek?'dsh':'codex')};
report();
</script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.url === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return; }
  const asset = ({ "/assets/deepseek-sprites.png": "image/png", "/styles.css": "text/css", "/agent-sprites.js": "text/javascript", "/i18n.js": "text/javascript", "/translations.js": "text/javascript" })[request.url];
  if (!asset) { response.writeHead(404); response.end(); return; }
  response.setHeader("Content-Type", asset + "; charset=utf-8");
  response.end(await readFile(new URL(request.url.slice(1), publicRoot)));
});
const port = Number(process.env.SPRITE_PREVIEW_PORT || 4327);
server.listen(port, "127.0.0.1", () => console.log(`Sprite-only test: http://127.0.0.1:${port}`));
