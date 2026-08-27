# 子代理控制（tool-subagent-control）

> 工具 · 委派与协作 · 默认启用

## 这个插件在干什么

提供全局命名的 send_message / interrupt_agent / list_agents 工具，管理 ctx.subagents 上的子代理续对话。

## 解决什么问题

委派之后需要与子代理继续通信、中断跑偏的任务、列出所有子代理；缺少统一控制入口。

## 推荐使用人群

深度使用子代理与并行委派的用户。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-tool-subagent-control`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载。
- **标签**：子代理、控制、通信

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
