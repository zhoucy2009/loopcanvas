# 计划模式（plan-mode）

> 工具 · 计划与目标 · 默认启用

## 这个插件在干什么

带日志的按 Agent 计划模式：先只读探索、产出完整计划，经 exit_plan_mode 提交用户审核后才进入实施。

## 解决什么问题

直接动手改代码容易偏离方向、返工成本高；先计划再实施让改动可审查、可预期。

## 推荐使用人群

谨慎执行、重视可审查性的用户；复杂或多文件改动前的默认步骤。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-plan-mode`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载。
- **标签**：计划、plan、审查

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
