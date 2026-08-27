# Code Mode 呈现（agent-tool-presentation）

> 呈现组件 · 工具呈现 · 默认关闭（需手动启用）

## 这个插件在干什么

Agent 平面的呈现选择器：把一个 Agent 的工具组合呈现为 Code Mode、原生工具或两者，供模型编写程序组合多步操作。

## 解决什么问题

逐工具调用在多步任务中往返次数多；Code Mode 让模型写一个 TypeScript 程序一次执行一串操作。

## 推荐使用人群

PTC 模式用户；处理多步骤、可程序化任务的开发者。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-agent-tool-presentation`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：仅在 PTC 模式（code preset）中加载。
- **标签**：Code Mode、呈现、SDK

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
