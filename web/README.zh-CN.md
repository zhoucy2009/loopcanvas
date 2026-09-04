# DSH Workflow Web

把 LoopCanvas 工作台迁移到浏览器，并用独立角色完成智能路由：Sol high/xhigh 只读规划，Luna high、Terra high 或 Sol low 按节点执行，Sol high 逐步审核，Sol xhigh 在交付前最终裁决；学习与搜索使用 Luna low（界面显示 light）。不同角色使用独立会话与各自职责提示词；执行、步骤审核和最终审核共享版本化交接契约，明确继承原始需求、硬约束、交付规格、传递依赖中的用户决定和结果证据，不依赖上一会话的隐含记忆。项目之间使用独立工作目录隔离 Agent 会话；支持项目改名、项目级 AGENTS.md 与宪法、完整对话记录和安全产物预览。Node.js 只在 `127.0.0.1` 启动服务；账户与 API Key 继续由用户自己的执行引擎管理。

顶部可切换执行、学习和探索三种模式。学习模式可读取项目目录、用户明确添加的本机文件夹和导入的公开 GitHub 仓库，并保留同片段多轮问答；探索模式检索公开 GitHub、官方文档、论文和文章，并按可信度与项目相关性展示来源。三种模式的产物、片段和来源可相互拖放为参考。学习和探索请求都在一次性临时目录中调用 DeepSeek Harness，不把项目目录作为可写工作目录。

探索支持多搜索标签页：技术和艺术、同类的多个搜索页可同时检索；点击“新搜索”或标签栏“＋”新增页面。每页独立保留输入草稿、结果、滚动位置和失败信息，后台完成不切换当前页；左右方向键及 Home/End 可切换标签。项目与全局分别保留打开的页面，同一对话仍按顺序提交。检索中的页面可切换但暂不能关闭，已完成页面关闭后仍可从历史记录打开。打开的标签与未发送草稿仅在当前浏览器页面会话内保留，刷新后从历史重新打开已完成搜索；多个检索会分别消耗 Agent 用量。

多节点执行中，规格文档、测试报告等中间产物保留在所属节点，只有匹配锁定入口的主产物会更新项目预览；最终交付仍校验入口、文件与验证结论。执行状态由后台活动调用确认；若原执行响应延迟，前端可通过只读轮询恢复结束状态，不重复提交任务。页面刷新、网络短暂中断或旧响应晚到不应被当成再次执行的授权。

## 一致性与恢复

- 需求、节点反馈与调试输入按项目保存在当前标签页的 `sessionStorage`，模式切换、添加参考和刷新不会清空文字。附件暂存仍是全局队列，尚未改为项目级草稿。
- 旧状态响应不能覆盖更新版本或切走用户当前选中的项目；调试定位结果还要匹配发起请求时的项目和预览 iframe。
- 并行节点会等待同批调用结束再释放执行锁；一个失败不会丢弃成功兄弟节点。执行完成但独立审核失败时保留产物，可只重试审核。
- 验证不通过不等于调用崩溃：保留明确的失败结论、证据和阻断问题，可手动返回实际依赖的制作节点返修，不能直接冒充验收通过。
- HTML 单一画布可声明 `artifact.previewViewport: { width, height }`，或在实际产品根元素标记 `data-loopcanvas-preview-root`。预览按可用空间缩小适配、不强制放大；长文档仍可滚动，不自动裁掉正文。
- 页面刷新和切换项目只恢复显示；新增付费执行需要提交、执行或恢复等明确操作。

连接同一个 Codex 账户不等于具备 Codex 桌面端全部功能：当前客户端仍使用临时会话，未实现通用客户端工具/审批转发和图片像素输入；智能路由也会覆盖按角色使用的模型。此次问题证据、修复和剩余边界见[整体审查报告](../docs/workflow-review-2026-09-04.md)。

## 本地运行

需要 Node.js 20 或更高版本。智能路由使用已登录的本机 Codex App Server；也可关闭智能路由并使用 DeepSeek Harness 兼容模式，后者先启动/配置：

```sh
npx @deepseek-ai/dsh web
```

包发布后，最终用户直接运行：

```sh
npx dshwf-web
```

在本仓库中开发运行：

```sh
cd web
npm start
```

不希望自动打开浏览器时：

```sh
npm start -- --no-open
```

## Remote：扫码、微信与 WhatsApp

Remote 采用两个隔离的服务面：

- `127.0.0.1:4317` 是完整管理界面和 API，始终只允许 localhost，不能暴露给局域网或公网。
- `127.0.0.1:4321` 是受限 Remote listener，只包含扫码配对、已配对设备命令和官方 Webhook。公网 HTTPS 反向代理只能指向这个端口。

Remote 默认关闭。启用时必须提供一个实际可访问的公共 HTTPS 基址；凭据应由 launchd、systemd、容器 Secret 或等价的系统密钥机制注入，不要写进仓库、配置样例或 shell 历史。支持的变量如下：

```text
LOOPCANVAS_REMOTE_ENABLED=1
LOOPCANVAS_REMOTE_URL=https://remote.example.com

LOOPCANVAS_WECHAT_TOKEN=<微信服务号回调 Token>
LOOPCANVAS_WECHAT_OPENIDS=<允许控制的 OpenID，逗号分隔>

LOOPCANVAS_WHATSAPP_APP_SECRET=<Meta App Secret>
LOOPCANVAS_WHATSAPP_VERIFY_TOKEN=<Webhook 验证 Token>
LOOPCANVAS_WHATSAPP_NUMBERS=<允许控制的 E.164 号码，逗号分隔>
```

配置好 HTTPS 反向代理与密钥注入后，以 `npm start -- --remote` 启动。可用 `--remote-host` 和 `--remote-port` 修改反向代理的本地目标；`--remote-insecure-test` 只用于可丢弃测试环境，不能用于真实手机或账号。

在 LoopCanvas 的 Remote 面板中生成二维码。链接中的 256-bit 密钥位于 URL fragment，不进入代理请求日志；配对码五分钟过期且只能使用一次。设备会话只以 SHA-256 哈希写入权限为 `0600` 的 `remote-state.json`，可在本机面板撤销。手机发送的“暂停、恢复、打开、运行”命令先进入本机审批队列；没有本机会话令牌不能批准。任意 shell 文本不在协议白名单中。

微信接入的是官方服务号或测试号回调，不是个人微信自动化。当前实现验证 `signature/timestamp/nonce`，只接受 OpenID 白名单中的文本消息，并使用明文回调模式；尚未实现安全模式的 AES 消息解密。配置 URL 为 `https://remote.example.com/webhooks/wechat`。参考[微信官方接收消息文档](https://developers.weixin.qq.com/doc/service/guide/product/message/Receiving_standard_messages.html)。

WhatsApp 接入官方 Cloud API Webhook。当前实现验证 `X-Hub-Signature-256`、验证 Token 和号码白名单，并接收入站文本命令；没有实现主动发消息回复。配置 Callback URL 为 `https://remote.example.com/webhooks/whatsapp`。参考 [Meta 官方 WhatsApp Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)。

### Apple 设备接续

同一 Apple ID 的 Safari 浏览活动由 macOS/iOS 自带 Handoff 管理。LoopCanvas 不会、也不能通过公开 API 枚举该 Apple ID 下的设备或读取任意浏览历史。原生 App 若要主动发布当前网页，需要已签名的 Apple bundle、Associated Domains entitlement、实际 HTTPS 域名上的 `apple-app-site-association`，并用 `NSUserActivity.webpageURL` 发布当前活动；在实际域名、Team ID 和签名能力确定前，不会把设备列表或 Handoff 状态伪造成已连接。参考 [Apple Associated Domains](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.associated-domains) 与 [`NSUserActivity.webpageURL`](https://developer.apple.com/documentation/foundation/nsuseractivity/webpageurl)。

## 当前发布状态

包名已经设置为 `dshwf-web`，但只有用户本人完成 npm 登录和首次发布后，公网的 `npx dshwf-web` 才会生效。不要把 npm token、dsh 凭证或 API Key 交给协作者或写入仓库。

发布前由用户本人在 `web` 目录执行：

```sh
npm login
npm publish
```

首次发布前还应确认包名仍可用、许可证/主体信息和隐私说明满足你的发布要求。

## 本地数据

- 状态：`~/Library/Application Support/LoopCanvasWeb/state.json`
- 全局默认工作目录：`~/Documents/LoopCanvas/Deliverables`
- 可用 `LOOPCANVAS_DATA_DIR` 和 `LOOPCANVAS_WORKSPACE` 覆盖。
- 每个项目有独立工作目录：创建时自动派生为 `<全局工作目录>/<项目名>-<短ID>`，可在“工作目录”中显式覆盖（显式路径必须已存在且是文件夹，留空恢复自动派生）。DSH 调用、AGENTS.md、产物与对话记录都按项目目录隔离。
- 插件目录：内置 `plugins/`（随包发布，含 DeepSeek Harness 官方插件清单）；用户自定义插件放 `<数据目录>/plugins/<id>/plugin.json`，可覆盖内置同名插件。插件启用状态保存在 `state.json` 的 `pluginStates`。

诊断文件记录脱敏错误摘要；对话记录可能包含脱敏后的完整请求和原始输出，包括失败尝试，应视为可能含项目内容的本机私有数据，不应直接公开。取消的规划/执行请求会保留重试信息，但不会自动重新发送，避免重复计费。

所有写接口都要求当前进程生成的随机会话令牌；服务只接受 localhost Host，并只监听 `127.0.0.1`。

## 项目能力

- **智能路由与独立审核**：规划始终只读并返回 1–12 个真实 Graph 节点；简单任务使用单节点 Graph，也会经过独立执行、Sol high 步骤审核和 Sol xhigh 最终裁决。智能模式要求 Codex App Server；选择 DSH 时会明确阻断，不会把 DeepSeek 模型冒充为 Sol、Terra 或 Luna。
- **依赖、并行与方向门控**：依赖节点按拓扑顺序推进；相互独立且写入范围不冲突的节点由用户选择并行或串行；需要确定目标方向的节点暂停等待明确回复。
- **谨慎等级**：设置页提供全局低/中/高谨慎等级，执行图中的每个节点可覆盖该值并随节点请求传给 Harness。
- **检查点与回退边界**：每批节点执行前自动建立状态检查点；节点回退会重开其下游，但不会还原 Agent 已经写入工作目录的文件。
- **改名**：项目卡片上的“改名”可修改标题；改名不会移动已有工作目录。
- **项目规则（AGENTS.md + 宪法）**：每次调用 Harness 前，会在项目工作目录自动生成 `AGENTS.md`（项目目标、硬约束、工作守则）与 `宪法.md`（人类门控、证据优先、目录边界等底线规则），并把两者注入到本次调用的提示词中。“项目规则”可以随时编辑并保存。
- **完整 DSH 对话记录**：每次规划/单步执行的完整 request 与原始输出（脱敏）会写入 `~/Library/Application Support/LoopCanvasWeb/conversations/<项目ID>/`，可在“DSH 记录”中查看与下载 JSON；列表只读元数据，不会因记录变大而拖慢页面。
- **插件目录**：“能力 → 插件”展示内置 DeepSeek Harness 官方插件（4 个 Agent 模式 + 30 个插件），每个插件卡片含简介、解决的问题、推荐使用人群，可启用/停用（状态保存在本机）；`~/.codex/plugins` 的 Codex 插件以只读方式并列展示。清单规范见仓库根目录 `plugins/README.md`。
- **侧栏折叠**：侧栏底部按钮可折叠为图标栏，状态保存在浏览器 localStorage；移动端自动恢复展开。
- **JSON 截断修复**：dsh 输出改为流式写入临时文件，不再有 10 MiB 内存截断；解析时从尾部提取最后一个括号平衡的 JSON 对象，容忍说明文字与尾随内容；模型输出在结尾漏掉 `}`/`]` 时自动补全再解析；超过 256 MiB 安全上限会明确报错而不是静默截断。
