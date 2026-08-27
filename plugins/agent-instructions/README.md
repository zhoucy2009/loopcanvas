# AGENTS 指令（agent-instructions）

> 系统组件 · 身份与指令 · 默认启用

## 这个插件在干什么

工作区上下文加载器：读取 AGENTS.md / CLAUDE.md 指令文件，随每次请求把项目规则下发给 Agent。

## 解决什么问题

项目规则（约定、禁令、流程）手工复制容易遗漏或过期；需要随项目自动下发并保持最新。

## 推荐使用人群

有项目规范、希望规则随项目生效的团队与个人。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-agent-instructions`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载（极简模式不加载）。
- **标签**：AGENTS.md、规则、项目规范

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
