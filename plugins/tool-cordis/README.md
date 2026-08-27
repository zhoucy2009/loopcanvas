# Cordis 运行时工具（tool-cordis）

> 工具 · 框架与运行时 · 默认关闭（需手动启用）

## 这个插件在干什么

自引用 cordis 工具集：检查运行中的运行时，挂载与卸载模型编写的插件，是「让 Agent 写 Agent」的核心。

## 解决什么问题

想实验插件或自建 preset，但缺少对运行时的检查与安全操作能力；直接改配置文件有破坏风险。

## 推荐使用人群

创造模式用户；编写、实验插件的开发者。该工具是信任边界，请按 shell 访问权限对待。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-tool-cordis`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：仅在创造模式（cordis preset）中加载。
- **标签**：Cordis、运行时、自修改

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
