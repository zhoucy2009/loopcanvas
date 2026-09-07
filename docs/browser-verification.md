# 本地浏览器验收

Codex 执行节点通过 `loopcanvas_verify_browser` 调用 LoopCanvas 宿主的隔离无头浏览器。执行 Agent 仍使用 `workspace-write` 和 `approvalPolicy: never`；不通过关闭执行沙盒或自动批准 shell 命令来运行 Chrome。客户端只接收已注册、属于当前会话的浏览器工具请求，其他审批请求继续阻断。

## 使用

安装 `web` 的依赖并重启 LoopCanvas 服务。宿主必须允许启动子进程，且已安装 Chromium 或 Chrome。也可由启动服务的人设置 `LOOPCANVAS_BROWSER_EXECUTABLE`。Agent 不能指定可执行文件、启动参数、个人 profile 或任意 URL。

工具接受项目相对 HTML 路径及可选视口 `width` / `height`。每次运行使用独立 profile、清理临时运行数据，在项目 `.loopcanvas-browser/run-*` 保存 `screen.png`、`print.pdf`、`report.json`；失败保存 `failure.json`。报告含源文件和产物 SHA-256、浏览器版本、屏幕尺寸、打印页数及每页尺寸（单位 pt）、加载错误。报告不自动给出验收通过；Agent 必须查看实际截图与打印输出，并按当前节点要求判断。

浏览器保留 Chromium sandbox，不连接用户日常浏览器或登录资料。只通过拦截请求读取项目内允许的静态资源，拒绝隐藏路径、目录穿越、越界符号链接、非 GET、WebSocket、外网与其他本机服务。外部字体/CDN/API 会受阻并记录，因此使用这些依赖的页面需先将所需资源合法保存到项目内，或另行设计明确授权的联网验收流程。当前工具不替代需要后端服务或登录状态的交互式端到端测试。

本入口目前接入 Codex App Server 的执行角色；DeepSeek Harness 继续使用它实际已启用的工具。审核角色保持只读，可复核已保存证据。

## 项目规则

默认第 3 条改为：项目文件与验收证据写入项目内；命令以项目为工作目录，可调用已安装工具；宿主管理的隔离浏览器可使用专用临时目录并清理。原版默认 `AGENTS.md` 和宪法中的对应行会在下次执行准备时精确迁移，其他自定义规则保留。

六条规则的原则均有必要，但应避免把原则写成阻碍正常生产的绝对措辞：

| 规则 | 生产用法 |
| --- | --- |
| 人类门控 | 关键目标、范围和高影响选择不明确时询问；已授权的常规实现细节可自行决定。并行策略遵守已有选择，无需重复征求同意。 |
| 证据优先 | 保留。按成果选择测试、截图、输出文件等证据；不要求所有任务都运行浏览器。 |
| 目录边界 | 保留写入边界，区分命令工作目录、已安装工具路径和宿主管理的临时目录。 |
| 浏览器与外部操作 | 保留。隔离本地验收应有预先授权的专用工具；发布、发送消息等操作按用户授权范围处理。 |
| 凭证保护 | 禁止模型读取或泄露原始凭证；正常服务认证应由宿主管理的安全注入或已授权连接器完成。不能把“保护凭证”误解为“禁止一切认证调用”。 |
| 透明失败 | 保留。明确区分启动失败、资源缺失、验收未通过，并报告可恢复原因；不能把生成 PDF 等同于版面合格。 |

## 验证

`npm run check` 检查语法；`node --test test/codex.test.js test/capabilities.test.js test/browser-verifier.test.js` 验证协议处理和路径边界。真实浏览器测试需在允许启动隔离浏览器的宿主运行：

```sh
LOOPCANVAS_TEST_BROWSER=1 node --test test/browser-verifier.test.js
```

如果宿主本身被系统限制而无法启动 Chrome，工具会保留具体启动错误；它不会绕过系统限制。

协议参考：[OpenAI App Server 动态工具](https://developers.openai.com/codex/app-server#dynamic-tool-calls-experimental)。
