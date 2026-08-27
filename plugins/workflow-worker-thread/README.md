# 工作流引擎（workflow-worker-thread）

> 服务 · 委派与协作 · 默认启用

## 这个插件在干什么

worker-thread 工作流引擎：在宿主事件循环之外执行模型编写的编排脚本，把 agent() 调用桥回子代理缝。

## 解决什么问题

大规模并行编排会在宿主事件循环上阻塞主线程；需要独立工作线程执行编排脚本。

## 推荐使用人群

使用工作流工具编排大量子代理的用户；一般随 tool-workflow 一起启用。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-workflow-worker-thread`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载。
- **标签**：工作流、引擎、并行

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
