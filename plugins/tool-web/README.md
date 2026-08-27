# 网页检索（tool-web）

> 工具 · 检索与信息 · 默认启用

## 这个插件在干什么

为 Agent 提供 web_search / web_fetch 工具：检索网页并抓取内容，让模型获取训练截止时间之后的信息。

## 解决什么问题

模型知识有截止时间，无法回答时效性问题和核实最新事实；离线时 Agent 对最新信息一无所知。

## 推荐使用人群

需要联网调研、查最新资料、核实事实与来源的用户。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-tool-web`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载。当前官方配置 fetch: false，仅搜索不抓取正文。
- **标签**：搜索、联网、调研

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
