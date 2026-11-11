# 发布维护

## 版本发布

1. 运行 `npm ci`、`npm run check`、`npm test`、`npm run docs:build` 和 `npm run docs:check`。图表渲染变更另跑 `npm run test:mermaid`。
2. 检查待提交文件不含凭据、聊天记录、日志或本机路径。
3. 更新版本、锁文件和 [CHANGELOG](../CHANGELOG.md)，使用不带 `v` 的版本标签，保留历史标签。
4. 按[安装指南](setup.md)检查安装和真实收发，在发布说明中写明变更与已知限制。

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

`.github/workflows/docs.yml` 是**手动触发**的 Pages 发布流程。在 Settings → Pages 选择 GitHub Actions，并在仓库 Actions Variables 设置 `DOCS_SITE_URL`。在 Actions 中运行 “Documentation” 即构建、检查并发布当前选定分支。仓库地址由工作流当前仓库生成。配置地址必须与 Pages 实际站点匹配。

如果使用自定义域名，先在 Pages 配置域名与 DNS，再将 `DOCS_SITE_URL` 改为该 HTTPS 地址。检查首页、子页面、图片、站内搜索、canonical 和 sitemap 后，才能更新 About 的网站地址。`docs/.vitepress/dist/` 为构建产物，不提交到源码。

## 图示维护

解释图是 `docs/public/images/` 中的原创 SVG，文字可直接编辑。`social-card.png` 是分享图导出；修改 SVG 后运行 `node scripts/render-social-card.mjs`，需要本机 Google Chrome。这些原创图示使用项目 MIT 许可证，修改时同步更新旁边的文字说明。发布前同时检查桌面与窄屏阅读效果。

## 升级与回退

先停止本仓库登录服务并备份仓库之外的私密运行目录，再切换已测试的版本、运行 `npm ci` 并启动。路径移动时需要重新安装登录项并更新 Stop Hook；保留旧配置和回执，不自动删除去重数据。启用新可选功能前阅读配置范围，默认不会因更新代码而主动扩大转发范围。

回退时恢复先前源码和对应私密配置，安装其锁定依赖再启动。结果未知的旧请求不能因回退而重投。`0.x` 阶段尚未承诺跨版本状态文件的普遍兼容性，升级前核对更新日志。
