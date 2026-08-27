# 后台任务控制（tool-jobs）

> 工具 · 执行与控制 · 默认启用

## 这个插件在干什么

为 Agent 提供后台任务控制工具（job_output / job_list / job_kill），管理 ctx.jobs 注册表中的后台任务。

## 解决什么问题

长时间运行的任务（构建、测试、服务器）会阻塞会话；需要放到后台并随时收集输出或停止。

## 推荐使用人群

需要跑长任务、持续构建或本地服务器的用户。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-tool-jobs`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载。
- **标签**：后台、任务、并发

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
