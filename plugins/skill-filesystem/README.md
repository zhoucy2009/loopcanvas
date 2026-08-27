# 本地技能发现（skill-filesystem）

> 技能 · 检索与信息 · 默认启用

## 这个插件在干什么

本地文件系统技能提供器：从项目、用户目录的技能根（.agents/skills 等）发现 SKILL.md 技能。

## 解决什么问题

技能散落在项目、用户目录等多个位置时难以统一发现；需要一个本地文件系统提供器把它们收进目录。

## 推荐使用人群

使用 Skills 的用户；技能分布在多个目录的团队。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-skill-filesystem`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载；创造模式额外注入自定义技能目录。
- **标签**：技能、发现、SKILL.md

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
