# 工具结果裁剪（compaction-tool-result-pruner）

> 系统组件 · 上下文与压缩 · 默认启用

## 这个插件在干什么

对工具结果表面节点做无模型的头/中/尾裁剪（阈值 8192 字符），可重放安全，不依赖 LLM。

## 解决什么问题

大工具输出（大文件读取、长列表、grep 洪泛）会快速撑爆上下文；需要确定性的自动裁剪。

## 推荐使用人群

工具输出量大的用户；处理大文件、长日志的场景。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-compaction-tool-result-pruner`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载。
- **标签**：裁剪、上下文、工具结果

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
