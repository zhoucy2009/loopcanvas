# Ralph 循环（tool-ralph）

> 工具 · 委派与协作 · 默认启用

## 这个插件在干什么

为 Agent 提供 Ralph 循环工具：每轮启动全新子代理，不携带父对话，围绕不可变目标迭代到完成或阻断。

## 解决什么问题

同一上下文的连续迭代容易带偏或固化错误；需要每轮全新上下文的强制迭代来收敛目标。

## 推荐使用人群

探索型任务、需要独立轮次迭代收敛的目标；适合让 Agent 自主推进的长期目标。

## 元信息

- **包 / preset**：`@deepseek-ai/dsh-tool-ralph`
- **版本**：0.1.0-rc.6
- **来源**：https://github.com/deepseek-ai/deepseek-harness
- **许可证**：MIT · 作者：DeepSeek AI
- **在哪里生效**：标准模式 / PTC 模式 / 创造模式默认加载。
- **标签**：Ralph、迭代、新鲜上下文

---

本文档由 `Scripts/generate-plugin-readmes.mjs` 从 `plugin.json` 生成。
