# Agent 人格（persona）

> 系统组件 · 身份与指令 · 默认启用

## 这个插件在干什么

组合书写的部署人格段：设定 Agent 的身份与系统提示，支持 {{model}}、{{cwd}} 等占位符解析。

## 解决什么问题

固定系统提示不适用于所有场景；不同任务需要不同的身份与行为设定。

## 推荐使用人群

想自定义 Agent 身份、行为风格或系统提示的用户。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-persona`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：每个 Agent preset 自带人格段，标准模式 / 极简模式 / PTC 模式 / 创造模式都会加载。
- **标签**：人格、系统提示、身份

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
