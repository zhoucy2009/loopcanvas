# 配置热更新（cordis-plugin-hmr）

> Cordis 框架插件 · 框架与运行时 · 默认启用

## 这个插件在干什么

Cordis 热模块替换插件：组合配置变化时热更新已加载的插件，无需整进程重启。

## 解决什么问题

修改组合配置后需要重启进程才能生效，开发迭代慢；热更新让配置实验更快。

## 推荐使用人群

开发、调试插件与组合配置的用户；一般运行用户无需感知。

## 元信息

- **包 / preset**：`@deepseek-ai/cordis-plugin-hmr`
- **版本**：1.0.16
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：随 dsh 基础组合加载；官方 web / headless profile 出于重载生命周期原因显式关闭（disabled: true）。
- **标签**：热更新、HMR、开发

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
