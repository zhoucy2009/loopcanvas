# LoopCanvas 插件接口（Plugin Interface）

LoopCanvas 开放「目录 + 清单」级插件接口：应用自带 `plugins/` 目录，每个插件一个文件夹，
文件夹内放 `plugin.json` 清单（含简介、解决的问题、推荐人群、默认组合状态等）。插件本体由
DeepSeek Harness（dsh）加载，LoopCanvas 负责发现、展示，并把用户明确确认的同步状态注入后续 headless 调用。

## 目录结构

```text
plugins/
  README.md             本文件：接口说明与清单规范
  <plugin-id>/
    plugin.json         插件清单（唯一必需文件）
    README.md           可选：给人类阅读的扩展简介（由 plugin.json 生成）
```

- 自带插件来自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  官方发布：4 个官方 Agent 模式（agent presets）与随 dsh 发布的 `@deepseek-ai/*` 官方插件。
- 用户可以把自定义插件放进数据目录的 `plugins/` 下（Web：`~/Library/Application Support/LoopCanvasWeb/plugins/`，
  原生：`~/Library/Application Support/LoopCanvas/plugins/`），同名 `id` 会覆盖内置清单。
- 遗留兼容：`~/.codex/plugins` 下的 Codex 插件仍以只读方式展示（Web「插件」页底部）。

## plugin.json 规范（schemaVersion 1）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | number | 是 | 清单规范版本，当前为 `1` |
| `id` | string | 是 | 全局唯一标识（建议与文件夹同名，小写连字符） |
| `name` | string | 是 | 展示名称（中文） |
| `kind` | string | 是 | `agent-preset` / `tool` / `skill` / `system` / `service` / `cordis-plugin` |
| `category` | string | 是 | 分组键：`agent-preset` / `shell` / `filesystem` / `retrieval` / `execution` / `delegation` / `planning` / `context` / `identity` / `presentation` / `framework` |
| `package` | string | 是 | npm 包名（`@deepseek-ai/…`）或 preset 标识 |
| `version` | string | 是 | 版本号 |
| `source` | string | 是 | 上游仓库地址 |
| `license` | string | 否 | 许可证 |
| `author` | string | 否 | 作者 |
| `description` | string | 是 | 简介：这个插件在干什么 |
| `problem` | string | 是 | 解决什么问题 |
| `audience` | string | 是 | 推荐使用人群 |
| `defaultEnabled` | boolean | 是 | 官方默认组合（标准模式）下是否启用 |
| `usage` | string | 否 | 在哪里生效、如何启用（对应 dsh 的组合位置） |
| `tags` | string[] | 否 | 标签，用于检索 |

示例：

```json
{
  "schemaVersion": 1,
  "id": "tool-web",
  "name": "网页检索",
  "kind": "tool",
  "category": "retrieval",
  "package": "@deepseek-ai/dsh-tool-web",
  "version": "0.1.0-rc.6",
  "source": "https://github.com/deepseek-ai/deepseek-harness",
  "license": "MIT",
  "author": "DeepSeek AI",
  "description": "为 Agent 提供 web_search / web_fetch 工具，可检索网页并抓取内容。",
  "problem": "模型训练数据有截止时间，无法获取最新信息；时效性问题和事实核实需要联网检索。",
  "audience": "需要查最新资料、做调研或核实事实的用户。",
  "defaultEnabled": true,
  "usage": "标准模式 / PTC 模式 / 创造模式默认加载。",
  "tags": ["搜索", "联网"]
}
```

## 接口语义

- Web 版的“同步开启”会先展示清单已有简介与功能并要求确认，再为后续 LoopCanvas dsh `0.1.0-rc.6` headless 调用附加临时 patch；不会修改用户的 `~/.dsh` profile。
- “同步关闭”会为后续调用附加 `disabled: true`；没有显式同步状态时仍继承用户 dsh profile。没有已验证 headless 行的 preset 或插件不会提供同步按钮。
- 应用端接口：
  - Web：`GET /api/plugins`（目录 + 状态）、`POST /api/plugins/<id>`（`{ "enabled": bool }`）。
  - 原生：设置页「插件」入口。
