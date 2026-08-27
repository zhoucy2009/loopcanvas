# 子代理委派（tool-subagent）

> 工具 · 委派与协作 · 默认启用

## 这个插件在干什么

为 Agent 提供 subagent / subagent_fork 委派工具：把独立任务交给子代理，返回结构化结果。

## 解决什么问题

主代理上下文有限，长任务全部自己做会溢出且串行低效；委派并行子任务可显著提速。

## 推荐使用人群

复杂多任务、需要并行调研或分块实现的用户。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-tool-subagent`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载（spawn 与 fork 两种后端）。
- **标签**：子代理、委派、并行

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
