# PTC 模式（code）

> Agent 模式（preset） · 官方 Agent 模式 · 默认关闭（需手动启用）

## 这个插件在干什么

具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具：模型用一个 TypeScript 程序组合多步操作，一次执行。

## 解决什么问题

常规工具调用下，多步操作需要多轮往返，时延和 token 消耗都偏高；把一连串动作写成一段程序可以一次跑完。

## 推荐使用人群

处理长链条、多步骤自动化任务的高级用户；愿意接受用 TypeScript 程序表达操作序列的开发者。

## 元信息

- **包 / preset**：`preset:code`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：dsh 设置中选择 Agent 模式为「PTC 模式」。
- **标签**：模式、Code Mode、自动化

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
