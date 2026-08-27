# 基础上下文压缩（compaction-basic）

> 系统组件 · 上下文与压缩 · 默认启用

## 这个插件在干什么

基于 token 计量驱动的压缩策略与 LLM 摘要后端：上下文接近窗口上限时自动压缩历史。

## 解决什么问题

长会话超出上下文窗口后模型表现明显下降；需要自动压缩历史并保留关键信息。

## 推荐使用人群

长会话、多轮大任务用户；会话经常跑很长的开发者。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-compaction-basic`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载。
- **标签**：压缩、上下文、长会话

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
