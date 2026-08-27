# 文件系统工具（tool-fs）

> 工具 · 文件与编辑 · 默认启用

## 这个插件在干什么

为 Agent 提供文件系统工具（读取、写入、编辑），通过 Harness 的文件系统缝（ctx.fs）操作项目文件。

## 解决什么问题

编码任务必须实际改动文件；模型需要受控、可审计的文件访问能力，而不是无界地读写磁盘。

## 推荐使用人群

所有编码用户；文件读写是交付产物最基本的能力。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-tool-fs`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载。
- **标签**：文件、读写、基础

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
