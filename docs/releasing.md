# 发布维护

本仓库的开源准备与实际公开发布分开。源码、文档、测试和本地标签准备好，不代表已经创建公开仓库、上线网站或完成新安装的飞书联调。

## 版本与源码

1. 从待发布提交做一次干净检出，运行 `npm ci`、`npm run check`、`npm test`、`npm run docs:build`、`npm run docs:check`。修改图表功能时，在有 Chrome 的 Mac 上运行 `npm run test:mermaid`。
2. 核对 `git ls-files` 和完整 Git 历史。公开内容只包含源码、示例、依赖锁文件、测试和文档。检查凭据、真实聊天 ID、个人目录、聊天正文、日志和数据库是否误入；本机维护用的 `AGENTS.md` 不纳入公开提交。
3. 同步 `package.json`、锁文件版本和 [CHANGELOG](../CHANGELOG.md)。Git 使用不带 `v` 的语义版本标签，例如 `0.2.0`；保留历史标签。
4. 确认公开仓库所有者和名称后配置远程，启用私下漏洞报告，填写 [About 与搜索资料](discovery.md)。`private: true` 防止误发 npm，**不影响 GitHub 开源**；项目当前按源码安装，不提供 npm 全局安装命令。
5. 从另一个目录按[安装指南](setup.md)验证初始化与启停，用独立飞书机器人和测试聊天完成真实往返，再更新该版本的[兼容性记录](compatibility.md)。升级后的本机使用验证不能代替全新用户安装验证。
6. 发布说明保留已知限制、迁移步骤和未验证项。只有实际发布后才增加在线徽章、Release 下载或托管文档入口。

## 文档站与 GitHub Pages

文档采用 VitePress 1.6.4 默认主题，直接读取仓库 Markdown。文档开发依赖将 Vite 固定为 6.4.6，以避开旧依赖的已知安全公告；升级时需同时复验构建、预览、搜索和依赖审计。中英 README 分别作为首页和英文介绍，安装、使用、架构等文档各维护一份。

```sh
npm ci
npm run docs:dev
```

本地预览默认只监听 `127.0.0.1`。查看构建结果：

```sh
npm run docs:build
npm run docs:check
npm run docs:preview
```

当前未配置发布地址时，构建是 `noindex` 预览，不生成 canonical 和 sitemap。正式构建需要这些环境变量：

| 变量 | 填写方式 |
| --- | --- |
| `DOCS_SITE_URL` | 完整 HTTPS 文档地址，包含 GitHub 项目站的路径前缀，以 `/` 结尾 |
| `DOCS_REPOSITORY_URL` | 真实的 `https://github.com/所有者/仓库` 地址 |
| `DOCS_SOURCE_REF` | 对应源码提交或标签；Actions 自动使用当前 commit SHA |

`.github/workflows/docs.yml` 是**手动触发**的 Pages 发布流程。公开仓库准备好后，在 Settings → Pages 选择 GitHub Actions，并在仓库 Actions Variables 设置 `DOCS_SITE_URL`。在 Actions 中运行 “Documentation” 即构建、检查并发布当前选定分支。仓库地址由工作流当前仓库生成。配置地址必须与 Pages 实际站点匹配；本地准备不会启动发布。

如果使用自定义域名，先在 Pages 配置域名与 DNS，再将 `DOCS_SITE_URL` 改为该 HTTPS 地址。检查首页、子页面、图片、站内搜索、canonical 和 sitemap 后，才能更新 About 的网站地址。`docs/.vitepress/dist/` 为构建产物，不提交到源码。

## 图示维护

解释图是 `docs/public/images/` 中的原创 SVG，文字可直接编辑。`social-card.png` 是分享图导出；修改 SVG 后运行 `node scripts/render-social-card.mjs`，需要本机 Google Chrome。README 图用于说明真实流程，不是产品截图。发布前同时检查桌面与窄屏阅读效果。

## 升级与回退

先停止本仓库登录服务并备份仓库之外的私密运行目录，再切换已测试的版本、运行 `npm ci` 并启动。路径移动时需要重新安装登录项并更新 Stop Hook；保留旧配置和回执，不自动删除去重数据。启用新可选功能前阅读配置范围，默认不会因更新代码而主动扩大转发范围。

回退时恢复先前源码和对应私密配置，安装其锁定依赖再启动。结果未知的旧请求不能因回退而重投。`0.x` 阶段尚未承诺跨版本状态文件的普遍兼容性，升级前核对更新日志。
