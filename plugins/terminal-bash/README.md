# 持久 Shell 后端（terminal-bash）

> 服务 · Shell 与命令 · 默认关闭（需手动启用）

## 这个插件在干什么

为持久 shell 提供 PTY 后端：基于子进程终端原语，支撑交互式程序与持续运行的状态。

## 解决什么问题

持久 shell 需要真正的伪终端支持，才能保留交互式程序（如 watch、服务器进程）的状态与输出。

## 推荐使用人群

一般用户无需直接感知；随「持久 Bash」一起启用即可。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-terminal-bash`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：极简模式内部依赖，与持久 Bash 配对加载。
- **标签**：Shell、PTY、服务

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
