import { defineConfig } from 'vitepress';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
// Publication identity is supplied by the owner, never guessed from a local path.
const rawUrl = process.env.DOCS_SITE_URL;
const site = rawUrl ? new URL(rawUrl) : null;
if (site && (site.protocol !== 'https:' || site.search || site.hash || site.username || site.password)) {
  throw new Error('DOCS_SITE_URL must be an HTTPS site URL without credentials, query or fragment.');
}
if (site && !site.pathname.endsWith('/')) site.pathname += '/';
const base = site?.pathname || '/';
const repo = (process.env.DOCS_REPOSITORY_URL || '').replace(/\/$/, '');
if (repo && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Use the public GitHub repository URL.');
const ref = process.env.DOCS_SOURCE_REF || 'HEAD';
const description = '在飞书私聊里继续 Mac 上的 Codex 桌面聊天，接收回复、图片和异步问题。单人配对、本机运行的开源社区桥接。';
const summaries = {
  'index.md': description,
  'en/index.md': 'A self-hosted macOS bridge for continuing Codex desktop chats from a Feishu bot, receiving reports and answering asynchronous questions.',
  'docs/setup.md': '从飞书自建应用、Codex CLI 到私聊配对、Stop Hook 和登录服务：Codex Feishu Bridge 安装步骤。',
  'docs/usage.md': '飞书续聊、切换聊天、图片和异步问答的操作方法，以及收发失败、暂停和卸载说明。',
  'docs/faq.md': '回答 Codex 飞书连接是否官方、是否支持 Lark、桌面问题框为何保留、数据去向及使用条件。',
  'docs/compatibility.md': '查看 Codex Feishu Bridge 的支持环境、自动测试、真实使用验证和仍未验证的范围。',
  'docs/architecture.md': '了解 Feishu 长连接、本机桥接、Codex 队列与 Stop Hook 的数据流、状态和源码职责。',
  'docs/discovery.md': '项目的 GitHub 简介、主题、搜索与 AI 检索信息，以及公开发布后的验证步骤。',
  'docs/releasing.md': '从干净安装、隐私核对到版本标签和 GitHub Pages 的开源发布流程。',
};

export default defineConfig({
  srcDir: '../',
  vite: { publicDir: resolve(root, 'docs/public') },
  srcExclude: ['node_modules/**', 'AGENTS.md', '.github/**', 'docs/.vitepress/**', 'docs/public/**'],
  rewrites: { 'README.md': 'index.md', 'README.en.md': 'en/index.md' },
  title: 'Codex Feishu Bridge', description, lang: 'zh-CN', base,
  cleanUrls: false,
  lastUpdated: true,
  useWebFonts: false,
  sitemap: site ? { hostname: site.href } : undefined,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}images/favicon.svg` }]],
  locales: {
    root: { label: '简体中文', lang: 'zh-CN', link: '/' },
    en: { label: 'English overview', lang: 'en-US', link: '/en/' },
  },
  themeConfig: {
    i18nRouting: false,
    logo: '/images/favicon.svg',
    nav: [
      { text: '安装', link: '/docs/setup' },
      { text: '使用', link: '/docs/usage' },
      { text: '常见问题', link: '/docs/faq' },
      { text: '开发与发布', link: '/docs/architecture' },
    ],
    sidebar: [{ text: '开始使用', items: [
      { text: '项目介绍', link: '/' },
      { text: '安装与配对', link: '/docs/setup' },
      { text: '使用与排障', link: '/docs/usage' },
      { text: '常见问题', link: '/docs/faq' },
      { text: '兼容性与验证', link: '/docs/compatibility' },
    ] }, { text: '参与项目', items: [
      { text: '架构与源码', link: '/docs/architecture' },
      { text: '贡献指南', link: '/CONTRIBUTING' },
      { text: '安全与数据', link: '/SECURITY' },
      { text: '行为准则', link: '/CODE_OF_CONDUCT' },
      { text: '更新日志', link: '/CHANGELOG' },
      { text: '发布维护', link: '/docs/releasing' },
      { text: '搜索与项目资料', link: '/docs/discovery' },
    ] }],
    socialLinks: repo ? [{ icon: 'github', link: repo }] : [],
    outline: { label: '本页内容', level: [2, 3] },
    sidebarMenuLabel: '目录',
    returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换浅色模式',
    darkModeSwitchTitle: '切换深色模式',
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最近更新', formatOptions: { dateStyle: 'medium' } },
    search: { provider: 'local', options: {
      // Intl.Segmenter provides useful word boundaries for Chinese full-text search.
      miniSearch: { options: { tokenize: text => [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)].filter(s => s.isWordLike).map(s => s.segment) } },
      translations: { button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' }, modal: { noResultsText: '未找到相关结果', resetButtonTitle: '清空搜索', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } } },
    } },
    footer: { message: '独立社区项目，与 OpenAI、飞书无官方隶属关系。', copyright: 'MIT License · Codex Feishu Bridge contributors' },
  },
  markdown: {
    config(md) {
      const open = md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
      const close = md.renderer.rules.link_close || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const href = tokens[idx].attrGet('href') || '';
        if (!/^(?:[a-z]+:|\/|#)/i.test(href) && /\.md(?:#.*)?$/.test(href)) {
          const [file, hash] = href.split('#');
          const original = relative(root, resolve(dirname(env.realPath || env.path), file));
          const mapped = ({ 'README.md': 'index.md', 'README.en.md': 'en/index.md' })[original] || original;
          tokens[idx].attrSet('href', `/${mapped}${hash ? '#' + hash : ''}`);
        }
        const source = href.match(/^(?:\.\.\/|\.\/)?((?:src|examples)\/[^#]+|manage\.py)$/);
        if (source) {
          if (repo) tokens[idx].attrSet('href', `${repo}/blob/${encodeURIComponent(ref)}/${source[1]}`);
          else { for (let j = idx + 1; j < tokens.length; j++) if (tokens[j].type === 'link_close') { tokens[j].meta = { sourceLabel: true }; break; } return '<span title="文件位于下载后的源码仓库">'; }
        }
        if (/^(\.\.\/)?LICENSE$/.test(href)) tokens[idx].attrSet('href', '/license.txt');
        return open(tokens, idx, options, env, self);
      };
      md.renderer.rules.link_close = (tokens, idx, options, env, self) => tokens[idx].meta?.sourceLabel ? '</span>' : close(tokens, idx, options, env, self);
    },
  },
  transformPageData(page) {
    page.description = page.frontmatter.description || summaries[page.relativePath] || `${page.title} · Codex Feishu Bridge 项目文档。`;
  },
  transformHead({ pageData }) {
    const english = pageData.relativePath.startsWith('en/');
    const canonicalPath = pageData.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '.html');
    const canonical = site ? new URL(canonicalPath, site).href : null;
    const title = pageData.title === 'Codex Feishu Bridge' ? pageData.title : `${pageData.title} | Codex Feishu Bridge`;
    const tags = [
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: 'Codex Feishu Bridge' }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: pageData.description }],
      ['meta', { property: 'og:locale', content: english ? 'en_US' : 'zh_CN' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'robots', content: site && pageData.relativePath !== '404.md' ? 'index,follow' : 'noindex,nofollow' }],
    ];
    if (canonical && pageData.relativePath !== '404.md') tags.push(
      ['link', { rel: 'canonical', href: canonical }],
      ['meta', { property: 'og:url', content: canonical }],
      ['meta', { property: 'og:image', content: new URL('images/social-card.png', site).href }],
      ['meta', { property: 'og:image:width', content: '1200' }],
      ['meta', { property: 'og:image:height', content: '630' }],
      ['meta', { property: 'og:image:alt', content: 'Codex Feishu Bridge: continue desktop chats from Feishu' }],
    );
    if (site && ['index.md', 'en/index.md'].includes(pageData.relativePath)) {
      tags.push(...[['zh-CN', ''], ['en', 'en/'], ['x-default', '']].map(([lang, path]) => ['link', { rel: 'alternate', hreflang: lang, href: new URL(path, site).href }]));
      tags.push(['script', { type: 'application/ld+json' }, JSON.stringify({
        '@context': 'https://schema.org', '@type': 'SoftwareSourceCode', name: 'Codex Feishu Bridge',
        description: pageData.description, url: canonical, version: pkg.version,
        programmingLanguage: ['JavaScript', 'Python'], runtimePlatform: 'macOS, Node.js 24+, Python 3',
        license: new URL('license.txt', site).href,
        ...(repo ? { codeRepository: repo } : {}),
      }).replace(/</g, '\\u003c')]);
    }
    return tags;
  },
  buildEnd(config) {
    writeFileSync(resolve(config.outDir, 'license.txt'), readFileSync(resolve(root, 'LICENSE')));
    writeFileSync(resolve(config.outDir, 'robots.txt'), site ? `User-agent: *\nAllow: /\nSitemap: ${new URL('sitemap.xml', site).href}\n` : 'User-agent: *\nDisallow: /\n');
    // A concise optional reading index; no claim that it affects search rankings.
    const link = path => site ? new URL(path, site).href : `${base}${path}`;
    writeFileSync(resolve(config.outDir, 'llms.txt'), `# Codex Feishu Bridge\n\n> A community macOS bridge between Codex desktop and a Feishu bot.\n\nSingle paired user. Runs on the user's Mac. Requires a compatible Codex desktop CLI. Feishu answers return as queued messages; native desktop question cards remain open. Synchronous input and general approval forwarding are not supported. Lark international is unverified.\n\n## Documentation\n\n- [Overview](${link('')}): capabilities and quick start\n- [English overview](${link('en/')}): English introduction\n- [Setup](${link('docs/setup.html')}): installation and pairing\n- [Usage](${link('docs/usage.html')}): commands and troubleshooting\n- [FAQ](${link('docs/faq.html')}): direct answers and limitations\n- [Compatibility](${link('docs/compatibility.html')}): verified scope\n- [Architecture](${link('docs/architecture.html')}): transport and state\n- [Security](${link('SECURITY.html')}): data and trust boundaries\n\nThis optional index is for readers and tools; it is not a search-engine requirement or a guarantee of AI citation.\n`);
  },
});
