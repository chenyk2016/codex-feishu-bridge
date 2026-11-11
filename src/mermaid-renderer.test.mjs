/** Offline extraction, private cache and failure checks; browser integration is explicitly opt-in. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMermaidRenderer, extractMermaidBlocks, pngDimensions, validateMermaidSource, isTransientMermaidBrowserFailure } from './mermaid-renderer.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6f4sAAAAASUVORK5CYII=', 'base64');
const SOURCE = 'flowchart LR\n A[收到图片] --> B[查看图片]';

/** Give every check private isolated storage and an explicit fake PNG adapter. */
function fixture(t, adapter = async () => PNG) {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-mermaid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, renderer: createMermaidRenderer({ directory, renderPng: adapter }) };
}

test('extract only actual Mermaid fences with exact original offsets, including CRLF and tilde fences', () => {
  const text = '前文\r\n```javascript\r\n```mermaid should stay code\r\n```\r\n\r\n~~~~Mermaid\r\nflowchart TB\r\nA-->B\r\n~~~~\r\n后文';
  const blocks = extractMermaidBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, 'flowchart TB\nA-->B');
  assert.equal(blocks[0].closed, true);
  assert.match(text.slice(blocks[0].start, blocks[0].end), /^~~~~Mermaid\r\n/);
  assert.match(text.slice(blocks[0].start, blocks[0].end), /~~~~\r\n$/);
  const truncated = extractMermaidBlocks('```mermaid\nflowchart LR\nA-->B');
  assert.equal(truncated[0].closed, false);
  assert.equal(truncated[0].end, '```mermaid\nflowchart LR\nA-->B'.length);
  assert.equal(extractMermaidBlocks('ordinary text').length, 0);
});

test('too many diagrams and oversized Markdown are explicit failures, never silent omissions', () => {
  const blocks = Array.from({ length: 5 }, () => '```mermaid\nflowchart LR\nA-->B\n```').join('\n');
  assert.throws(() => extractMermaidBlocks(blocks), /too_many_blocks/);
  assert.throws(() => extractMermaidBlocks('字'.repeat(100001)), /invalid_markdown/);
});

test('diagram input is bounded and cannot enable external assets, navigation or security overrides', () => {
  assert.equal(validateMermaidSource('  ' + SOURCE.replaceAll('\n', '\r\n') + '\n'), SOURCE);
  assert.equal(validateMermaidSource('sequenceDiagram\nAlice->>Bob: 中文消息'), 'sequenceDiagram\nAlice->>Bob: 中文消息');
  for (const value of [null, '', ' ', '字'.repeat(16001), 'flowchart LR\0A-->B']) assert.throws(() => validateMermaidSource(value), /invalid_source/);
  for (const value of [
    '%%{init:{"securityLevel":"loose"}}%%\nflowchart LR\nA-->B',
    '---\nconfig:\n securityLevel: loose\n---\nflowchart LR\nA-->B',
    'flowchart LR\nA-->B\nclick A callback',
    'flowchart LR\nA[https://example.com/private]',
    'flowchart LR\nA[<script>alert(1)</script>]',
    'flowchart LR\nA@{ shape: image, img: "/private/file.png" }',
  ]) assert.throws(() => validateMermaidSource(value), /external_or_active_content/);
});

test('render creates real private PNG files and validates source/content identity when reusing cache', async (t) => {
  let calls = 0;
  const f = fixture(t, async (source, options) => {
    calls++; assert.equal(source, SOURCE); assert.equal(options.timeoutMs, 25000); return PNG;
  });
  const result = await f.renderer.render(SOURCE);
  assert.equal(result.status, 'rendered'); assert.equal(result.cached, false);
  assert.equal(result.width, 1); assert.equal(result.height, 1);
  assert.equal(result.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.deepEqual(readFileSync(result.path), PNG);
  assert.equal(statSync(result.path).mode & 0o777, 0o600);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  const restarted = createMermaidRenderer({ directory: f.directory, renderPng: async () => { throw new Error('must use validated cache'); } });
  const cached = await restarted.render(SOURCE);
  assert.equal(cached.cached, true); assert.equal(cached.path, result.path); assert.equal(calls, 1);
  writeFileSync(result.path, Buffer.from('bad'), { mode: 0o600 });
  await assert.rejects(restarted.render(SOURCE), /invalid_png/);
});

test('simultaneous identical sources share one local render and distinct sources remain distinct', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 15)); return PNG; });
  const [one, two] = await Promise.all([f.renderer.render(SOURCE), f.renderer.render(SOURCE)]);
  assert.equal(calls, 1); assert.equal(one.path, two.path);
  const other = await f.renderer.render(SOURCE + '\nB-->C');
  assert.notEqual(other.path, one.path); assert.equal(calls, 2);
});

test('unsafe output, oversized dimensions and renderer failures do not become cached success', async (t) => {
  const f = fixture(t, async () => { throw new Error('synthetic_failure'); });
  await assert.rejects(f.renderer.render(SOURCE), /synthetic_failure/);
  const g = fixture(t, async () => Buffer.from('not a PNG'));
  await assert.rejects(g.renderer.render(SOURCE), /invalid_png/);
  const oversized = Buffer.from(PNG); oversized.writeUInt32BE(12001, 16);
  assert.throws(() => pngDimensions(oversized), /dimensions_exceeded/);
  assert.throws(() => pngDimensions(Buffer.alloc(10 * 1024 * 1024 + 1)), /invalid_png/);
});

test('shared folders, final-component aliases and redirected cache files are rejected', async (t) => {
  const f = fixture(t);
  assert.throws(() => createMermaidRenderer({ directory: 'relative' }), /absolute_directory/);
  assert.throws(() => createMermaidRenderer({ directory: f.directory, timeoutMs: 999 }), /invalid_options/);
  const alias = join(f.directory, 'alias'); symlinkSync(f.directory, alias);
  assert.throws(() => createMermaidRenderer({ directory: alias }), /private_directory/);
  const result = await f.renderer.render(SOURCE);
  rmSync(result.path); symlinkSync(join(f.directory, 'unknown'), result.path);
  await assert.rejects(f.renderer.render(SOURCE));
});

test('real installed Mermaid and isolated Chrome render a Chinese diagram and reuse its PNG', {
  skip: process.env.RUN_MERMAID_BROWSER_TEST !== '1' || !existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  timeout: 35000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-mermaid-browser-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const renderer = createMermaidRenderer({ directory });
  const result = await renderer.render(SOURCE);
  assert.equal(result.cached, false); assert.ok(result.width > 100); assert.ok(result.height > 100);
  assert.ok(result.width <= 12000 && result.height <= 12000);
  assert.equal((await renderer.render(SOURCE)).cached, true);
  await assert.rejects(renderer.render('this is not mermaid syntax'), /mermaid_render_failed/);
});


test('only transient local browser failure retries once within the same budget and emits safe codes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-mermaid-retry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const logs = [], budgets = []; let calls = 0;
  const renderer = createMermaidRenderer({ directory, log: (event, details) => logs.push({ event, ...details }),
    renderPng: async (_source, options) => { budgets.push(options.timeoutMs); calls++;
      if (calls === 1) { const error = new Error('raw private browser context'); error.code = 'mermaid_launch_failed'; error.retryable = true; throw error; }
      return PNG;
    } });
  assert.equal((await renderer.render(SOURCE)).status, 'rendered');
  assert.equal(calls, 2); assert.ok(budgets[1] <= budgets[0]);
  assert.equal(logs[0].retry, true); assert.equal(logs[0].code, 'mermaid_launch_failed');
  assert.doesNotMatch(JSON.stringify(logs), /raw private|收到图片|\/private/);
  assert.equal((await renderer.render(SOURCE)).cached, true); assert.equal(calls, 2);
});

test('persistent browser failures stop after two, while parser and unclassified errors never retry', async (t) => {
  for (const code of ['mermaid_launch_failed', 'mermaid_diagram_failed', 'sensitive other error']) {
    const directory = mkdtempSync(join(tmpdir(), 'feishu-mermaid-failed-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
    let calls = 0;
    const renderer = createMermaidRenderer({ directory, renderPng: async () => { calls++; const error = new Error('failure');
      error.code = code; error.retryable = code !== 'mermaid_diagram_failed'; throw error; } });
    await assert.rejects(renderer.render(SOURCE));
    assert.equal(calls, code === 'mermaid_launch_failed' ? 2 : 1);
  }
});


test('diagram text echoed by parser errors cannot impersonate browser closure signals', () => {
  assert.equal(isTransientMermaidBrowserFailure(new Error('page.evaluate: Error: Parse error on line 1:\nbrowser closed\npage is closed')) , false);
  assert.equal(isTransientMermaidBrowserFailure(new Error('page.evaluate: Error: Target page, context or browser has been closed')), false);
  assert.equal(isTransientMermaidBrowserFailure(new Error('page.evaluate: Target page, context or browser has been closed')), true);
  const closed = new Error('transport closed'); closed.name = 'TargetClosedError';
  assert.equal(isTransientMermaidBrowserFailure(closed), true);
});
