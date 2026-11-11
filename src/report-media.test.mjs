/** Offline media preparation checks use real private state and injected transports only. */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReportMediaPreparer, extractReportMedia } from './report-media.mjs';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';

/** Build a bounded Stop reply fixture without relying on the extractor to create its expectations. */
function report(text, id = 'a') {
  return { version: 1, eventId: id.repeat(64), sessionId: 'original_chat', turnId: 'turn_1', lastAssistantMessage: text, truncated: false };
}

/** Allocate exclusively owned local state and remove it when the check ends. */
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-report-media-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const uploads = [], renders = [];
  const config = { directory,
    uploadImage: async (path) => { uploads.push(path); return { status: 'uploaded', imageKey: `img_v3_fixture_${uploads.length}` }; },
    renderMermaid: async (source) => { renders.push(source); return { status: 'rendered', path: '/private/generated/flow.png' }; },
    ...overrides };
  return { directory, uploads, renders, config, prepare: createReportMediaPreparer(config) };
}

test('extract only explicit local images and fenced Mermaid outside ordinary code in source order', () => {
  const text = ['![外链](https://example.org/x.png)', '`![行内代码](/private/ignored.png)`',
    '```text', '![代码](/private/code.png)', '```',
    '![截图](</private/with spaces/result.png>)',
    '```mermaid', 'flowchart LR', 'A-->B', '```', '![文件](file:///private/a%20b.jpg)'].join('\n');
  const items = extractReportMedia(text);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(({ kind, source, complete }) => ({ kind, source, complete })), [
    { kind: 'image', source: '/private/with spaces/result.png', complete: true },
    { kind: 'mermaid', source: 'flowchart LR\nA-->B', complete: true },
    { kind: 'image', source: '/private/a b.jpg', complete: true },
  ]);
  assert.equal(text.slice(items[0].start, items[0].end), '![截图](</private/with spaces/result.png>)');
});

test('confirmed uploads become native images and survive restart without rendering or uploading again', async (t) => {
  const f = fixture(t);
  const value = report('结果：\n![截图](/private/screenshot.png)\n\n```mermaid\nflowchart LR\nA-->B\n```\n完成。');
  const first = await f.prepare(value);
  assert.deepEqual(f.uploads, ['/private/screenshot.png', '/private/generated/flow.png']);
  assert.deepEqual(f.renders, ['flowchart LR\nA-->B']);
  assert.equal(first.elements.length, 2);
  assert.ok(first.elements.every((element) => element.tag === 'img' && element.alt.tag === 'plain_text'));
  assert.match(first.bodyText, /图片 1见下图/);
  assert.match(first.bodyText, /流程图 2见下图/);
  assert.doesNotMatch(first.bodyText, /A-->B|\/private\/screenshot/);
  assert.deepEqual(first.notices, []);
  const restarted = createReportMediaPreparer({ ...f.config, uploadImage: () => { throw new Error('must not upload'); }, renderMermaid: () => { throw new Error('must not render'); } });
  assert.deepEqual(await restarted(value), first);
});

test('incomplete Mermaid never renders, including a Stop reply cut at the current character limit', async (t) => {
  const f = fixture(t), value = { ...report('说明\n```mermaid\nflowchart LR\nA-->'), truncated: true };
  const result = await f.prepare(value);
  assert.equal(f.uploads.length, 0); assert.equal(f.renders.length, 0);
  assert.deepEqual(result.elements, []);
  assert.match(result.notices.join(''), /代码不完整/);
  assert.doesNotMatch(result.bodyText, /flowchart/);
});

test('failed rendering and explicit upload rejection preserve text and do not retry on restart', async (t) => {
  const f = fixture(t, { renderMermaid: async () => { throw new Error('syntax error'); }, uploadImage: async () => ({ status: 'failed', reason: 'permission_denied' }) });
  const value = report('![图片](/private/a.png)\n```mermaid\nflowchart LR\nA-->B\n```\n正常文字');
  const result = await f.prepare(value);
  assert.equal(result.elements.length, 0);
  assert.match(result.notices.join(''), /处理失败/);
  assert.match(result.notices.join(''), /生成失败/);
  assert.match(result.bodyText, /正常文字/);
  const restart = createReportMediaPreparer({ ...f.config, uploadImage: () => { throw new Error('unexpected retry'); }, renderMermaid: () => { throw new Error('unexpected retry'); } });
  assert.deepEqual(await restart(value), result);
});

test('unknown and crash-left uploads are not replayed and never become successful image elements', async (t) => {
  const f = fixture(t, { uploadImage: async () => ({ status: 'unknown' }) });
  const value = report('![图片](/private/a.png)');
  let result = await f.prepare(value);
  assert.equal(result.elements.length, 0);
  assert.match(result.notices[0], /结果不确定/);
  const path = join(f.directory, readdirSync(f.directory).find((name) => name.endsWith('.json')));
  const state = readPrivateJson(path);
  writePrivateJson(path, { ...state, status: 'attempting' });
  const restarted = createReportMediaPreparer({ ...f.config, uploadImage: () => { throw new Error('unexpected retry'); } });
  result = await restarted(value);
  assert.equal(readPrivateJson(path).status, 'unknown');
  assert.equal(result.elements.length, 0);
  assert.match(result.notices[0], /不会重复上传/);
});

test('two preparers cannot upload the same in-flight item twice', async (t) => {
  let finish, calls = 0;
  const f = fixture(t, { uploadImage: async () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const value = report('![图片](/private/a.png)');
  const first = f.prepare(value);
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await createReportMediaPreparer(f.config)(value);
  assert.equal(concurrent.elements.length, 0);
  assert.match(concurrent.notices[0], /结果不确定/);
  finish({ status: 'uploaded', imageKey: 'img_v3_confirmed' });
  assert.equal((await first).elements[0].img_key, 'img_v3_confirmed');
  assert.equal(calls, 1);
  assert.equal((await createReportMediaPreparer(f.config)(value)).elements[0].img_key, 'img_v3_confirmed');
  assert.equal(calls, 1);
});

test('only four images are attempted and excess or remote links never trigger hidden fetches', async (t) => {
  const f = fixture(t);
  const value = report(Array.from({ length: 5 }, (_, index) => `![图${index}](/private/${index}.png)`).join('\n') + '\n![外部](https://example.org/external.png)');
  const result = await f.prepare(value);
  assert.equal(f.uploads.length, 4); assert.equal(result.elements.length, 4);
  assert.match(result.notices.join(''), /超过本轮4张/);
  assert.equal(f.uploads.some((path) => path.startsWith('http')), false);
});

test('no-media replies remain unchanged and bad configuration or over-limit reports fail explicitly', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.prepare(report('普通文字')), { elements: [], notices: [], bodyText: '普通文字' });
  assert.throws(() => createReportMediaPreparer({ ...f.config, maxImages: 5 }), /invalid_configuration/);
  await assert.rejects(() => f.prepare(report('字'.repeat(4001))), /invalid_report/);
  assert.throws(() => extractReportMedia(null), /invalid_text/);
});

test('desktop absolute image paths retain literal spaces', () => {
  assert.equal(extractReportMedia('![图](/Users/test/Library/Application Support/media/flow.png)')[0].source, '/Users/test/Library/Application Support/media/flow.png');
});
