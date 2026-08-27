# Bash 命令执行（tool-bash）

> 工具 · Shell 与命令 · 默认启用

## 这个插件在干什么

为 Agent 提供 bash 工具：在沙盒与权限策略下执行 shell 命令并返回输出，支持可选的后台任务与沙盒升级。

## 解决什么问题

编码任务需要运行构建、测试、安装依赖和脚本，模型没有可执行环境就无法验证和交付成果。

## 推荐使用人群

所有使用 dsh 编码的用户；几乎是每类任务都依赖的基础工具。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-tool-bash`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载（Windows 上自动替换为 pwsh）。
- **标签**：Shell、命令、基础

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
