# 配置包含（cordis-plugin-include）

> Cordis 框架插件 · 框架与运行时 · 默认启用

## 这个插件在干什么

在 Cordis 配置中通过 include 引用其它配置文件，把组合配置模块化、可复用。

## 解决什么问题

组合配置分散在多个文件时难以复用与维护；需要把公共片段抽出来被多处引用。

## 推荐使用人群

管理复杂 Cordis 组合、维护多 profile 的用户。

## 元信息

- **包 / preset**：`@deepseek-ai/cordis-plugin-include`
- **版本**：1.0.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：配置加载期生效，随 dsh 基础组合加载。
- **标签**：配置、include、模块化

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
