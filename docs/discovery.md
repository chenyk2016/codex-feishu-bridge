# 搜索与项目资料

这份资料供维护者填写 GitHub About、发布介绍和文档站元信息。公开信息以代码、[兼容性记录](compatibility.md)和已发布版本为依据，不把本机验证写成所有环境可用。

## 一句话介绍

**中文：** Codex Feishu Bridge 是一个在 Mac 上运行的开源社区桥接，让你在飞书私聊里继续 Codex 桌面聊天、接收回复，并回答异步问题。

**English:** A self-hosted macOS bridge to continue Codex desktop chats from Feishu, receive reports, and answer asynchronous questions.

项目名统一使用 **Codex Feishu Bridge**，公开仓库为 [chenyk2016/codex-feishu-bridge](https://github.com/chenyk2016/codex-feishu-bridge)。这是社区项目，与 OpenAI、飞书无官方隶属关系。当前实现使用 Feishu 域名；Lark 国际版尚未验证。

## GitHub About

公开仓库已配置 Description 与 Topics，并启用私下漏洞报告。文档目前可直接在 GitHub 阅读；独立文档站与社交分享封面上传仍按发布流程处理。

| 字段 | 内容 |
| --- | --- |
| Description | Self-hosted macOS bridge for Codex desktop and Feishu: chat routing, reports, media, and async questions. |
| Website | 填写实际部署成功的文档站地址 |
| Topics | `codex`, `feishu`, `macos`, `chatbot`, `self-hosted`, `developer-tools`, `notifications`, `human-in-the-loop` |
| Social preview | 上传 `docs/public/images/social-card.png`，尺寸 1200 × 630 |
| License | MIT |
| 讨论与问题 | 使用仓库 Issues；漏洞优先走私下报告入口 |

`package.json` 已填写真实 `repository`、GitHub README `homepage` 与 `bugs` 地址；README 使用实际克隆命令。独立文档站上线后再替换 Website，不编造下载量、星标或推荐评价。

## SEO：让读者和搜索引擎找到内容

文档站从 Markdown 生成可直接读取的 HTML，包含逐页标题与摘要、清晰的导航、图示替代文字、中文站内搜索，以及中文/英文项目入口。设置 `DOCS_SITE_URL` 后生成 canonical（页面的正式地址）、sitemap、robots.txt、Open Graph 分享元信息和首页的 `SoftwareSourceCode` 结构化数据；设置 `DOCS_REPOSITORY_URL` 后补上真实源码地址。

未设置正式地址的本地预览带 `noindex`，不生成虚构 canonical 或 sitemap。GitHub 项目 Pages 的路径前缀从实际地址读取；部署流程见[发布维护](releasing.md#文档站与-github-pages)。

## GEO：让答案容易理解与核对

GEO 在这里指让生成式搜索和 AI 阅读工具准确理解项目。采用的做法是：

- 在项目介绍第一段给出明确用途、平台和使用者。
- 在 FAQ 直接回答真实问题，并链接安装、行为和限制的原文。
- 把默认能力、可选能力和实验功能分开，明确问题框不会自动关闭。
- 图示旁保留文字说明，重要信息不只放在图片里。
- 提供可选 `llms.txt` 阅读索引，链接到同一份文档，不另外维护一套事实。

这些做法不保证排名、收录或 AI 引用。Google 的官方说明强调常规 SEO、可抓取内容及可靠信息；并不要求特殊 AI 标记或新的 AI 文本文件。[官方说明](https://developers.google.com/search/docs/appearance/ai-features)

## 公开后的核验

1. 核对站点首页、安装、FAQ 和英文入口均能直接打开；手机菜单、搜索、图片也可用。
2. 检查页面源代码中的 canonical、Open Graph 图片、语言链接，以及 sitemap 的域名和路径前缀。
3. GitHub 项目站的 `robots.txt` 位于子路径，爬虫通常读取域名根目录；需要爬虫规则时在域名根站点管理。不要把子路径文件当作全域控制。
4. 使用实际站点所有权验证后，再向搜索站长工具提交 sitemap；记录真实索引情况。
5. 按用户会搜索的问题抽样核对答案是否引用正确版本和限制。引用与排名属于发布后的观察结果，不纳入本地构建“通过”的承诺。

相关依据：[Google SEO 入门](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)、[VitePress 部署](https://vitepress.dev/guide/deploy)、[站点地图](https://vitepress.dev/guide/sitemap-generation)。
