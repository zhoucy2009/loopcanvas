# LoopCanvas

一个自适应的本机 Harness 工作台：当前 Web 智能模式使用 Codex 独立规划、节点执行、步骤审核与最终裁决；简单任务也使用单节点执行图。关闭智能路由后的兼容模式保留单次调用交付。支持依赖调度、暂停询问和状态回退。当前主入口已迁移为本机 Web UI，原 macOS SwiftUI 版本暂时保留用于对照和回退。

## 本机 Web UI（当前迁移目标）

Web 版不需要安装或签名 macOS `.app`。用户安装 Node.js 20+、配置自己的 Codex 或 dsh 后，在本机启动服务并用浏览器访问；服务只监听 `127.0.0.1`，登录与 API Key 由对应执行引擎管理。

```sh
cd web
npm start
```

包名已确定为 `dshwf-web`。发布到 npm 后，最终用户入口为 `npx dshwf-web`；当前是否已公开发布仍以 npm registry 为准。详见 [`web/README.md`](web/README.md)。

LoopCanvas 支持 `DeepSeek Harness` 与 Codex App Server 作为执行引擎。路由判断和执行通过本机 Agent 完成；已删除需要用户手动搬运 JSON 的 Codex 文件桥接。仓库中现有 `Bridge/` JSON 是历史测试数据，应用不再读写，也不会自动删除。

本轮上下文、失败恢复与界面一致性整理见[整体审查报告](docs/workflow-review-2026-09-04.md)。连接 Codex 不意味着自动继承桌面端的工具、审批或会话记忆；当前支持范围以报告和 Web 文档为准。

macOS 免点击语音唤醒使用独立菜单栏程序：首次授权后，直接说“hey，规划 / 执行 / 审核”，网页关闭时也可唤醒。构建、权限与隐私说明见 [macOS 后台唤醒](docs/macos-wake.md)。

工作台右上角的 [四精灵胶囊](docs/agent-sprites.md) 对应需求接收、计划、执行、审核；工作时跳入左侧执行区，全部工作结束后归队。支持“集合”“开一个新需求”以及手动新建需求。

## 当前能力

- 智能模式首次调用只读规划并返回真实执行图；即使单节点也有独立审核。关闭智能路由的兼容模式才允许简单任务在同次调用完成、验证并交付。
- 执行图基于真实工作节点、依赖、并行机会或方向决策，不填充固定模板或强制选项。
- 输入支持图片、PDF、文本和普通文件；长粘贴可转为附件，文本附件可恢复到输入框。单文件上限 25 MiB，当前输入批次总量上限 100 MiB，相同内容会去重。
- 有依赖的节点等待上游完成；无依赖且写入范围不冲突的节点会让用户选择并行或串行。
- 需要决定目标方向的节点必须暂停并询问用户；其他方向明确、证据充分的节点可自动推进。
- 全局可设置低/中/高谨慎等级，每个执行节点可单独覆盖。
- 验证步骤必须返回明确的客观结果与阻断问题；用户偏好确认不能替代验证。
- 制作、集成和交付步骤必须返回可预览的完整产物；只有文字总结不能冒充完成。
- 每一步决策前和重要执行前只建立一次固定检查点；回退不会新增、删除或消耗检查点，可在已有坐标间反复切换。当前回退只恢复 LoopCanvas 工作流状态，不会自动还原工作目录里的文件。
- 支持 HTML、Markdown 和文本产物预览，以及双版本暂停交接文档。
- 支持多个本机项目；项目可改名、归档和恢复，每个项目最多保留 40 个检查点。
- 每个项目有独立工作目录：创建时自动派生为 `<全局工作目录>/<项目名>-<短ID>`，可显式覆盖；DSH 会话、文件与产物按项目隔离。
- 每个项目自动生成可编辑的 `AGENTS.md`（目标、硬约束、守则）与 `宪法.md`（人类门控、证据优先等底线规则），并注入到每次 Harness 调用。
- 每次规划/单步执行都会把完整 request 与原始输出（脱敏）保存到本机，可在「DSH 记录」中查看和下载 JSON。
- dsh 输出改为流式落盘，不再截断 JSON；超过 256 MiB 安全上限会明确报错。
- Web 侧栏可折叠为图标栏（状态保存在浏览器 localStorage）。
- 学习模式可切换项目目录、本机文件夹和已导入的公开 GitHub 仓库；也可直接搜索 GitHub 并导入仓库。拖动高亮代码会通过 DeepSeek Harness 生成解释，并可把同一片段放入右侧进行多轮追问。内置源码解释、数据结构、语法和运行流程模块。
- 探索模式通过 DeepSeek Harness 检索 GitHub、官方文档、论文和文章，按来源可信度与项目相关性展示，可切换“项目优先”或“全局探索”。
- 执行产物、学习代码片段和探索来源统一为可拖动参考：拖到学习会解析，拖到探索会继续研究，拖到执行会进入项目共享上下文供规划和临摹。
- 学习和探索请求均在一次性临时目录中运行，不把项目目录作为 Harness 的可写工作目录。
- Web 工作流以带 schema 版本的多项目文档保存在 Application Support 的 `LoopCanvasWeb/state.json`；原生 SwiftUI 版本使用 `UserDefaults` 和 `LoopCanvas` 数据目录，两者不是同一份状态。

## 插件接口

LoopCanvas 开放「目录 + 清单」级插件接口：仓库自带 [`plugins/`](plugins/README.md) 目录，
内置 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方推荐的
4 个 Agent 模式（极简 / 标准 / PTC / 创造）与 30 个官方插件，每个插件都有
`plugin.json` 清单，说明**这个插件在干什么、解决什么问题、推荐使用人群**。

- Web 版：「能力 → 插件」标签页按分类浏览插件卡片。点击“同步开启”后会先展示清单中已有的简介与功能并要求确认；确认状态保存在本机 `state.json`，随后以临时 patch 注入 LoopCanvas 发起的 dsh `0.1.0-rc.6` headless 调用。
- 同步不会改写用户的 `~/.dsh` profile；“同步关闭”会撤销该插件对后续 LoopCanvas 调用的覆盖。没有已验证 headless 行的 preset 或插件只读展示，不提供伪开启。
- 原生版：设置页「插件」入口，同样支持浏览与启停（状态保存在 `UserDefaults`）。
- 用户可把自定义插件放进数据目录的 `plugins/`（Web：`~/Library/Application Support/LoopCanvasWeb/plugins/`，
  原生：`~/Library/Application Support/LoopCanvas/plugins/`），同名 `id` 覆盖内置清单。
- 遗留兼容：`~/.codex/plugins` 下的 Codex 插件以只读方式展示。
- 清单规范见 [`plugins/README.md`](plugins/README.md)；每个插件目录内的 README.md 由
  `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成，修改清单后运行该脚本同步。
- Web 接口：`GET /api/plugins`（目录 + 状态）、`POST /api/plugins/<id>`（`{ "enabled": bool }`）。

## DeepSeek Harness 连接

在需求页点击齿轮，或进入工作区左侧“Agent 连接”配置：

- 面向无法使用 GitHub 的用户，先从 [Node.js 官方中文下载页](https://nodejs.org/zh-cn/download)安装 LTS 版本，再在终端运行 `npx @deepseek-ai/dsh web`。
- 连接页会先检测 Node.js，再自动寻找 PATH、`~/.npm/_npx/*/node_modules/.bin/dsh` 和 headless profile 中的 dsh；无需从 GitHub 下载，也无需手工寻找 npx 缓存路径。
- “复制命令并打开终端”不会自动粘贴或执行命令。账户和 API Key 由用户在 dsh 中自行配置；LoopCanvas 不要求、读取或保存 API Key。
- `dsh` 可执行文件留空时自动检测，也可填写完整路径。
- 显式填写的工作目录必须已经存在且是文件夹；留空时，开发运行使用当前 Swift 包的 `Deliverables/`，安装版使用 `~/Documents/LoopCanvas/Deliverables/`。
- 全局工作目录只作为“项目级工作目录”的根：每个项目默认在全局目录下自动派生独立子目录，也可在项目的“工作目录”里单独设置（显式路径必须已存在且是文件夹，留空恢复自动派生）。
- 可选择 `deepseek-v4-pro` 或 `deepseek-v4-flash`，并设置 off、high、max 三档推理强度。
- “检测本机 Harness”当前验证可执行文件和版本；真实任务仍需端到端验证。

LoopCanvas 会拒绝 `artifact.projectRoot` 位于该项目工作目录之外的回复，但这是应用层返回值校验，不是操作系统级命令沙盒。是否具有更强的文件、网络和命令隔离取决于实际安装的 DeepSeek Harness 及其配置。

也可通过环境变量覆盖：

```sh
export LOOPCANVAS_DEEPSEEK_HARNESS_EXECUTABLE=/full/path/to/dsh
export LOOPCANVAS_DEEPSEEK_HARNESS_WORKSPACE=/full/path/to/project
export LOOPCANVAS_DSH_MODEL=deepseek-v4-pro
export LOOPCANVAS_DSH_REASONING_EFFORT=high
```

旧版本保存的 `fileBridge`、`openAICompatible` 等模式会迁移为 `deepSeekHarness`。

## 运行与测试

```sh
cd /path/to/loopcanvas
swift run LoopCanvas
swift test
```

## 生成 `.app`

```sh
sh Scripts/package-app.sh
```

生成位置为本地运行用的 `dist/LoopCanvas.app`，以及经过“压缩 → 临时解压 → 严格签名复验”的 `dist/LoopCanvas-release.zip`。当前脚本仍只做本地 ad-hoc 签名，没有 Developer ID 签名、notarization 或自动更新，不适合直接公开分发。
