# 贡献指南

欢迎修复、文档建议与兼容性报告。提交前请描述你的系统版本、期望行为、实际行为与可公开的最小复现。安全问题按[安全政策](SECURITY.md)私下报告。

1. 使用 Node.js 24+ 与 macOS 系统 Python，运行 `npm ci`。
2. 修改相关模块，保持一条消息或任务的身份、去重和结果可追溯。
3. 运行 `npm run check` 和 `npm test`。修改图表渲染时，在有 Chrome 的 Mac 上跑 `npm run test:mermaid`。
4. 提交说明写清影响与验证范围。提交可使用 Conventional Commits，例如 `fix(relay): preserve the selected reply target`。

测试请使用模拟输入和独立的私密目录。贡献内容只使用可分发的素材。提交贡献意味着同意按项目的 [MIT 许可证](LICENSE)分发该贡献。
