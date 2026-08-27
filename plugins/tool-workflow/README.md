# 工作流工具（tool-workflow）

> 工具 · 委派与协作 · 默认启用

## 这个插件在干什么

为 Agent 提供 workflow 工具：运行 JavaScript 编排脚本，通过 ctx.workflowEngine 批量协调子代理。

## 解决什么问题

逐个手写委派调用效率低、难以组织阶段；脚本化编排可以一次协调大批子代理并汇总结果。

## 推荐使用人群

需要大规模 fan-out、多角度并行研究或迁移审计的用户。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-tool-workflow`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载。
- **标签**：工作流、编排、批量

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
