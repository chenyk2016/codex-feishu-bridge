/** Pure rendering checks; no platform requests, uploads or external image fetches. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReportMarkdown } from './report-renderer.mjs';

test('keep common Markdown text, lists, tables, headings and public links renderable', () => {
  const text = '# 标题\n\n**重点**与*斜体*\n- 第一项\n1. 有序项\n\n| 名称 | 状态 |\n| --- | --- |\n| A | 好 |\n\n[文档](https://example.com/docs?a=1&b=2)';
  assert.equal(renderReportMarkdown(text), text);
  assert.equal(renderReportMarkdown('[含括号](https://example.com/a_(b))'), '[含括号](https://example.com/a_%28b%29)');
  assert.equal(renderReportMarkdown('<https://example.com/>'), '[https://example.com/](https://example.com/)');
});

test('HTML-like extensions and encoded mentions remain visible inert text outside code', () => {
  const rendered = renderReportMarkdown('<at id=all></at> <person id=ou_x></person> <button>x</button> <font color=red>红</font> &lt;at id=all&gt;');
  assert.equal(rendered, '&lt;at id=all&gt;&lt;/at&gt; &lt;person id=ou_x&gt;&lt;/person&gt; &lt;button&gt;x&lt;/button&gt; &lt;font color=red&gt;红&lt;/font&gt; &amp;lt;at id=all&amp;gt;');
  assert.equal(rendered.includes('<at'), false);
  assert.equal(renderReportMarkdown('``<at id=all>`'), '``&lt;at id=all&gt;`');
});

test('preserve line-start Markdown blockquotes while escaping raw platform tags inside them', () => {
  assert.equal(renderReportMarkdown('> 引用 **重点**\n> 第二行\n\n>> 嵌套\n  > 缩进引用'), '> 引用 **重点**\n> 第二行\n\n>> 嵌套\n  > 缩进引用');
  assert.equal(renderReportMarkdown('> <at id=all></at>\n普通 a > b'), '> &lt;at id=all&gt;&lt;/at&gt;\n普通 a &gt; b');
});

test('local and unsupported inline links cannot become active remote navigation', () => {
  assert.equal(renderReportMarkdown('[架构](/Users/example/Project/ARCHITECTURE.md:8)'), '架构（本机文件）');
  assert.equal(renderReportMarkdown('[有空格](</Users/example/My Project/file.md>)'), '有空格（本机文件）');
  assert.equal(renderReportMarkdown('[文件](file:///private/tmp/a.png)'), '文件（本机文件）');
  assert.equal(renderReportMarkdown('[桌面](codex://review?id=1)'), '桌面（桌面链接）');
  for (const target of ['javascript:alert(1)', 'java&#x73;cript:alert(1)', 'data:text/html,abc', 'mailto:me@example.com']) {
    assert.equal(renderReportMarkdown(`[不启用](${target})`), '不启用（链接未启用）');
  }
  assert.equal(renderReportMarkdown('file:///a codex://task mailto:x@y javascript:alert(1)'), 'file：///a codex：//task mailto：x@y javascript：alert(1)');
});

test('reference links are resolved through the same HTTP-only rule and definitions disappear', () => {
  const text = '[安全][S] [本机][local] [坏][bad]\n\n[S]: https://example.com/docs\n[local]: /Users/example/a.md\n[bad]: javascript:alert(1)';
  const rendered = renderReportMarkdown(text);
  assert.ok(rendered.startsWith('[安全](https://example.com/docs) 本机（本机文件） 坏（链接未启用）'));
  assert.equal(rendered.includes('[bad]:'), false);
  assert.equal(rendered.includes('javascript:'), false);
  assert.equal(renderReportMarkdown('[快捷]\n[快捷]: https://example.com/'), '[快捷](https://example.com/)\n');
  assert.equal(renderReportMarkdown('[x]\n> [x]: /Users/example/a.md'), '[x]\n> \\[x\\]: /Users/example/a.md');
});

test('normalized loopback links become desktop-only labels while public and LAN navigation survives', () => {
  for (const target of ['http://localhost:65522/', 'https://preview.localhost/a', 'http://localhost./',
    'http://127.0.0.1:65522/', 'http://127.3.4.5/', 'http://127.1/', 'http://2130706433/',
    'http://0.0.0.0:3000/', 'http://[::1]:3000/', 'http://[0:0:0:0:0:0:0:1]/']) {
    assert.equal(renderReportMarkdown(`[预览](${target})`), '预览（本机页面）');
  }
  assert.equal(renderReportMarkdown('[公网](https://example.com/a)'), '[公网](https://example.com/a)');
  assert.equal(renderReportMarkdown('[局域网](http://192.168.1.8:3000/a)'), '[局域网](http://192.168.1.8:3000/a)');
  assert.equal(renderReportMarkdown('[引用本机][r]\n[r]: http://127.1/'), '引用本机（本机页面）\n');
  assert.equal(renderReportMarkdown('<http://127.1:3000/>'), 'http：//127.1:3000/（本机页面）');
  assert.equal(renderReportMarkdown('打开 http://2130706433:3000/。'), '打开 http：//2130706433:3000/（本机页面）。');
  assert.equal(renderReportMarkdown('访问 https://example.com/ 和 http://192.168.1.8:3000/'), '访问 https://example.com/ 和 http://192.168.1.8:3000/');
});

test('images degrade to their alt label without uploading or producing an image element', () => {
  assert.equal(renderReportMarkdown('![截图](/private/tmp/a.png)'), '截图（图片待接入）');
  assert.equal(renderReportMarkdown('![公开图](https://example.com/image.png)'), '公开图（图片待接入）');
  assert.equal(renderReportMarkdown('![引用图][img]\n[img]: https://example.com/a.png'), '引用图（图片待接入）\n');
  assert.equal(renderReportMarkdown('![]()'), '图片（图片待接入）');
});

test('normal fenced and inline code retain their literal text including extension syntax and local links', () => {
  const text = '正文 `<at id=all></at> [a](file:///a)`\n\n```js\nconst html = "<button>";\n// [a](file:///a)\n```\n\n结尾';
  assert.equal(renderReportMarkdown(text), text);
  assert.equal(renderReportMarkdown('``a ` b <at id=all>``'), '``a ` b <at id=all>``');
  assert.equal(renderReportMarkdown('`第一行\n[例子]: file:///a\n最后`'), '`第一行\n[例子]: file:///a\n最后`');
  assert.equal(renderReportMarkdown('```txt\n未闭合 <at id=all>'), '```txt\n未闭合 <at id=all>\n```');
  assert.equal(renderReportMarkdown('~~~json\n{"a":"<at id=all>"}\n~~~'), '```json\n{"a":"<at id=all>"}\n```');
});

test('Mermaid fences become a clear desktop placeholder rather than raw graph source or a fake image', () => {
  assert.equal(renderReportMarkdown('之前\n```mermaid\nflowchart LR\nA-->B\n```\n之后'), '之前\n（流程图请在桌面聊天查看）\n之后');
  assert.equal(renderReportMarkdown('```Mermaid\nsequenceDiagram\nA->>B:hi'), '（流程图请在桌面聊天查看）');
});

test('invalid inputs are rejected and escaped expansion stays within the card byte budget', () => {
  for (const text of [null, undefined, 1, '字'.repeat(4001)]) assert.throws(() => renderReportMarkdown(text), /report_markdown_invalid_input/);
  assert.equal(renderReportMarkdown('🙂'.repeat(4000)), '🙂'.repeat(4000));
  const expanded = renderReportMarkdown('![]'.repeat(1333));
  assert.ok(Buffer.byteLength(expanded) <= 24 * 1024);
  assert.ok(expanded.endsWith('（飞书排版超出长度限制，余下内容请在桌面聊天查看）'));
  const codeAfterExpansion = renderReportMarkdown('![]'.repeat(900) + '\n```js\n<at id=all>\n```');
  assert.ok(Buffer.byteLength(codeAfterExpansion) <= 24 * 1024);
  assert.ok(!codeAfterExpansion.includes('```') || codeAfterExpansion.match(/```/g).length === 2);
});
