# 持久 Bash（tool-bash-persistent）

> 工具 · Shell 与命令 · 默认关闭（需手动启用）

## 这个插件在干什么

提供跨调用保留状态的持久 bash 工具（PTY 后端）：环境变量、工作目录与后台进程在会话内连续。

## 解决什么问题

每次调用都重新启动 shell 会丢失环境、目录和进程状态，连续多步的脚本任务难以推进。

## 推荐使用人群

极简模式用户；需要连续 shell 会话、长脚本任务的场景。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-tool-bash-persistent`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：极简模式的默认 shell 工具；标准模式使用一次性 bash 工具。
- **标签**：Shell、持久会话、PTY

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
