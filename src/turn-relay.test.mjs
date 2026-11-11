/** Offline report scoping, identity, safe CLI and durable delivery/queue checks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';
import { TurnRelay, extractMessageText, followupBody, runCodexQueue, validateTurnReport, turnReportCard } from './turn-relay.mjs';

/** Build one independently readable Stop report fixture. */
function report(now) {
  return { version: 1, kind: 'codex_turn_report', eventId: 'a'.repeat(64), sessionId: 'fixed_chat', turnId: 'turn_1',
    createdAtMs: now, lastAssistantMessage: '本轮完成了无害测试。', truncated: false };
}

test('reply cards use Markdown for the body while metadata and controls remain literal', () => {
  const value = { ...report(Date.now()), lastAssistantMessage: '# 标题\n\n**关键结果**\n\n- 项目一\n- 项目二', truncated: true };
  const card = turnReportCard(value, { title: '<at id=all>名称</at>' });
  assert.equal(card.body.elements[0].text.tag, 'plain_text');
  assert.equal(card.body.elements[1].tag, 'markdown');
  assert.match(card.body.elements[1].content, /\*\*关键结果\*\*/);
  assert.match(card.body.elements[1].content, /原回复已截断/);
  assert.equal(card.body.elements.at(-1).text.tag, 'plain_text');
  assert.equal(card.body.elements.some((element) => element.tag === 'button'), false);
});

test('prepared native images and literal notices fit the whole card budget without becoming actions', () => {
  const value = { ...report(Date.now()), lastAssistantMessage: '![]()'.repeat(799) };
  const media = { bodyText: value.lastAssistantMessage, elements: Array.from({ length: 4 }, () => ({
    tag: 'img', img_key: 'img_' + 'a'.repeat(280), alt: { tag: 'plain_text', content: '图'.repeat(200) },
    behaviors: [{ type: 'callback', value: { unexpected: true } }],
  })), notices: ['<at id=all>'.repeat(100)] };
  const card = turnReportCard(value, { title: '名'.repeat(160) }, media);
  assert.equal(card.body.elements.filter((element) => element.tag === 'img').length, 4);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 29000);
  assert.equal(JSON.stringify(card).includes('unexpected'), false);
  const rejected = turnReportCard(value, { title: '原聊天' }, { ...media, elements: [{ tag: 'button' }] });
  assert.equal(rejected.body.elements.some((element) => element.tag === 'button'), false);
  assert.equal(rejected.body.elements.some((element) => element.tag === 'img'), false);
  assert.match(rejected.body.elements.at(-2).text.content, /无法核实/);
});

test('media preparation precedes report send intent and failure still delivers the ordinary reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-report-media-preparation-'));
  try {
    const value = report(Date.now()), statePath = join(dir, '.relay-state', 'reports', `${value.eventId}.json`);
    writePrivateJson(join(dir, `${value.eventId}.json`), value);
    let prepared = 0, sends = 0;
    const relay = new TurnRelay({ outbox: dir, binary: process.execPath, threadId: 'fixed_chat', prepareReportMedia: async () => {
      prepared++;
      assert.throws(() => readPrivateJson(statePath), /ENOENT/);
      throw new Error('synthetic preparation failure');
    } });
    await relay.pollReports(async (card) => {
      sends++;
      assert.equal(readPrivateJson(statePath).status, 'sending');
      assert.match(card.body.elements.at(-2).text.content, /图片准备失败/);
      return 'om_text_delivered';
    });
    assert.equal(prepared, 1); assert.equal(sends, 1);
    assert.equal(readPrivateJson(statePath).status, 'sent');
    await new TurnRelay({ outbox: dir, binary: process.execPath, threadId: 'fixed_chat', prepareReportMedia: () => { throw new Error('no repeat'); } })
      .pollReports(async () => { sends++; return 'om_duplicate'; });
    assert.equal(sends, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extract only rich-text text/link labels and preserve paragraphs; require exact explicit prefix', () => {
  const value = { zh_cn: { title: '忽略标题', content: [
    [{ tag: 'text', text: '继续 第一段' }, { tag: 'a', text: '链接', href: 'ignored' }, { tag: 'img', image_key: 'ignored' }],
    [{ tag: 'text', text: '第二段' }],
  ] } };
  assert.equal(extractMessageText('post', JSON.stringify(value)), '继续 第一段链接\n第二段');
  assert.equal(extractMessageText('text', '{"text":"continue next"}'), 'continue next');
  assert.equal(extractMessageText('post', 'bad json'), '');
  assert.equal(extractMessageText('post', JSON.stringify({ content: [[{ tag: 'md', text: '请分析这张图' }]] })), '请分析这张图');
  assert.deepEqual(followupBody('普通消息'), { status: 'ignored' });
  assert.deepEqual(followupBody(' 继续 未明确开头'), { status: 'ignored' });
  assert.deepEqual(followupBody('continue 第一段\n第二段'), { status: 'ready', body: '第一段\n第二段' });
  assert.equal(followupBody('继续   ').status, 'invalid_instruction');
  assert.equal(followupBody('继续 ' + '字'.repeat(4001)).status, 'instruction_too_long');
});

test('reports must match the exact fixed chat, stable file ID and bounded Unicode content', () => {
  const now = Date.now(); const value = report(now);
  assert.equal(validateTurnReport(value, value.eventId, 'fixed_chat', now), value);
  assert.throws(() => validateTurnReport(value, value.eventId, 'other_chat', now), /wrong_identity/);
  assert.throws(() => validateTurnReport({ ...value, command: 'anything' }, value.eventId, 'fixed_chat', now), /invalid_fields/);
  assert.throws(() => validateTurnReport({ ...value, lastAssistantMessage: '字'.repeat(4001) }, value.eventId, 'fixed_chat', now), /invalid_content/);
});

test('reports acknowledge API success, survive restart without duplicate sends, and retry at most three times', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-turn-reports-'));
  try {
    const now = Date.now(); const value = report(now); writePrivateJson(join(dir, `${value.eventId}.json`), value);
    const config = { outbox: dir, binary: process.execPath, threadId: 'fixed_chat' };
    let sends = 0;
    const relay = new TurnRelay(config);
    await relay.pollReports(async (card, uuid) => { sends++; assert.equal(card.header.title.content, '原聊天 · 本轮回复'); assert.equal(uuid.length, 36); return 'om_fixture'; }, now);
    const restarted = new TurnRelay(config);
    await restarted.pollReports(async () => { sends++; return 'om_duplicate'; }, now + 1);
    assert.equal(sends, 1);
    const second = { ...value, eventId: 'b'.repeat(64) }; writePrivateJson(join(dir, `${second.eventId}.json`), second);
    let attempts = 0; const fail = async () => { attempts++; throw new Error('synthetic network error'); };
    await restarted.pollReports(fail, now);
    await restarted.pollReports(fail, now + 1999); assert.equal(attempts, 1);
    await restarted.pollReports(fail, now + 2000); assert.equal(attempts, 2);
    await restarted.pollReports(fail, now + 12000); assert.equal(attempts, 3);
    await restarted.pollReports(fail, now + 99999); assert.equal(attempts, 3);
    assert.equal(readPrivateJson(join(dir, '.relay-state', 'reports', `${second.eventId}.json`)).status, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('queue once per message across restarts and never replay an ambiguous/crashed attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-turn-followups-'));
  try {
    let calls = 0;
    const config = { outbox: dir, binary: process.execPath, threadId: 'fixed_chat', queueRunner: async (_bin, id, body) => {
      calls++; assert.equal(id, 'fixed_chat'); assert.equal(body, '下一步\n保留段落'); return { status: 'queued' };
    } };
    const relay = new TurnRelay(config);
    assert.equal((await relay.queueFollowup('om_owner1', '继续 下一步\n保留段落')).status, 'queued');
    const restarted = new TurnRelay(config);
    assert.equal((await restarted.queueFollowup('om_owner1', '继续 下一步\n保留段落')).status, 'duplicate');
    const hash = createHash('sha256').update('om_uncertain').digest('hex');
    writePrivateJson(join(dir, '.relay-state', 'queued-messages', `${hash}.json`), { version: 1, messageId: 'om_uncertain', sessionId: 'fixed_chat', status: 'attempting', createdAtMs: Date.now() });
    assert.equal((await restarted.queueFollowup('om_uncertain', 'continue 重启不能重放')).status, 'duplicate');
    assert.equal(calls, 1);
    assert.equal((await restarted.queueFollowup('om_normal', '这是一条普通消息')).status, 'ignored');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('official queue invocation uses an argument array with no shell or resume flag', async () => {
  const body = '保留 $(not-a-command) `not-shell` "quotes"\n新段落';
  let observed;
  const result = await runCodexQueue('/official/codex', 'fixed_chat', body, { spawnImpl: (binary, args, options) => {
    observed = { binary, args, options }; const child = new EventEmitter(); child.kill = () => true;
    queueMicrotask(() => child.emit('close', 0)); return child;
  } });
  assert.equal(result.status, 'queued');
  assert.deepEqual(observed, { binary: '/official/codex', args: ['queue', '--thread', 'fixed_chat', '--message', body], options: { shell: false, stdio: 'ignore' } });
  assert.equal(observed.args.includes('--resume'), false);
});

test('registered reports use dynamic metadata, actual-chat acknowledgements and the source-aware callback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-registered-reports-'));
  try {
    const now = Date.now();
    const sessions = new Map([['fixed_chat', { sessionId: 'fixed_chat', title: '原聊天名称' }]]);
    const config = { outbox: dir, binary: process.execPath, threadId: 'fixed_chat', sessionLookup: (id) => sessions.get(id) };
    const relay = new TurnRelay(config);
    sessions.set('registered_child', { sessionId: 'registered_child', title: '新建聊天标题' });
    const value = { ...report(now), eventId: 'c'.repeat(64), sessionId: 'registered_child' };
    writePrivateJson(join(dir, `${value.eventId}.json`), value);
    let sends = 0;
    await relay.pollReports(async (card, uuid, source) => {
      sends++;
      assert.equal(source.sessionId, 'registered_child');
      assert.equal(uuid.length, 36);
      assert.equal(card.body.elements[0].text.tag, 'plain_text');
      assert.equal(card.body.elements[0].text.content, '新建聊天标题（ed_child）');
      assert.match(card.body.elements.at(-1).text.content, /菜单/);
      return 'om_registered';
    }, now);
    const ack = readPrivateJson(join(dir, '.relay-state', 'reports', `${value.eventId}.json`));
    assert.equal(ack.sessionId, 'registered_child');
    assert.equal(ack.status, 'sent');
    await new TurnRelay(config).pollReports(async () => { sends++; return 'om_duplicate'; }, now + 1);
    assert.equal(sends, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('default scope remains root-only and rejected/unregistered reports never replay after registration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-unregistered-reports-'));
  try {
    const now = Date.now(); const value = { ...report(now), eventId: 'd'.repeat(64), sessionId: 'unregistered_chat' };
    writePrivateJson(join(dir, `${value.eventId}.json`), value);
    const config = { outbox: dir, binary: process.execPath, threadId: 'fixed_chat' };
    let sends = 0; const send = async () => { sends++; return 'om_unexpected'; };
    await new TurnRelay(config).pollReports(send, now);
    const ack = readPrivateJson(join(dir, '.relay-state', 'reports', `${value.eventId}.json`));
    assert.equal(ack.sessionId, value.sessionId);
    assert.equal(ack.status, 'rejected');
    await new TurnRelay({ ...config, sessionLookup: (id) => ({ sessionId: id, title: '刚登记' }) }).pollReports(send, now + 1);
    assert.equal(sends, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('removed registrations stop future reports without misattributing them to the root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-removed-reports-'));
  try {
    const now = Date.now(); const sessions = new Map([['child_chat', { sessionId: 'child_chat', title: 'Child' }]]);
    const relay = new TurnRelay({ outbox: dir, binary: process.execPath, threadId: 'fixed_chat', sessionLookup: (id) => sessions.get(id) });
    sessions.delete('child_chat');
    const value = { ...report(now), eventId: 'e'.repeat(64), sessionId: 'child_chat' };
    writePrivateJson(join(dir, `${value.eventId}.json`), value);
    let sends = 0;
    await relay.pollReports(async () => { sends++; return 'om_unexpected'; }, now);
    assert.equal(sends, 0);
    const ack = readPrivateJson(join(dir, '.relay-state', 'reports', `${value.eventId}.json`));
    assert.equal(ack.sessionId, 'child_chat'); assert.equal(ack.status, 'rejected');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('disconnected, unknown and crashed registered deliveries are not automatically replayed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-ambiguous-reports-'));
  try {
    const now = Date.now(); const value = { ...report(now), eventId: 'f'.repeat(64), sessionId: 'child_chat' };
    const config = { outbox: dir, binary: process.execPath, threadId: 'fixed_chat', sessionLookup: (id) => ({ sessionId: id, title: 'Child' }) };
    writePrivateJson(join(dir, `${value.eventId}.json`), value);
    const relay = new TurnRelay(config); let attempts = 0;
    await relay.pollReports(async () => { attempts++; throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' }); }, now);
    assert.equal(readPrivateJson(join(dir, '.relay-state', 'reports', `${value.eventId}.json`)).status, 'unknown');
    const crashed = { ...value, eventId: '1'.repeat(64) };
    writePrivateJson(join(dir, `${crashed.eventId}.json`), crashed);
    writePrivateJson(join(dir, '.relay-state', 'reports', `${crashed.eventId}.json`), {
      version: 1, eventId: crashed.eventId, sessionId: 'child_chat', attempts: 1, status: 'sending',
    });
    const restarted = new TurnRelay(config);
    await restarted.pollReports(async () => { attempts++; return 'om_unexpected'; }, now + 100000);
    assert.equal(attempts, 1);
    const ack = readPrivateJson(join(dir, '.relay-state', 'reports', `${crashed.eventId}.json`));
    assert.equal(ack.sessionId, 'child_chat'); assert.equal(ack.status, 'unknown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('report heading identifies the source chat using bounded literal Unicode text', () => {
  const value = report(Date.now());
  const card = turnReportCard(value, { title: '轻量服务器应用创建和发布产品' });
  assert.equal(card.header.title.content, '轻量服务器应用创建和发布产品 · 本轮回复');
  assert.equal(card.header.title.tag, 'plain_text');
  const long = turnReportCard(value, { title: '😀'.repeat(160) });
  assert.equal([...long.header.title.content].length, 67);
  assert.ok(long.header.title.content.endsWith('… · 本轮回复'));
  const controls = turnReportCard(value, { title: '第一行\n第二行\0' });
  assert.equal(controls.header.title.content, '第一行 第二行 · 本轮回复');
  const archived = turnReportCard(value, { title: '归档任务', isArchived: true, recentRepliesEnabled: true });
  assert.match(archived.body.elements.at(-1).text.content, /仅汇报，未切换回复目标/);
});

test('confirmed delivery persists route context before effects and retries local failures without resending', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-delivery-effects-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const value = report(Date.now()), path = join(dir, '.relay-state', 'reports', `${value.eventId}.json`);
  writePrivateJson(join(dir, `${value.eventId}.json`), value);
  let sends = 0, effects = 0, blocks = 0;
  const config = { outbox: dir, binary: process.execPath, threadId: value.sessionId,
    sessionLookup: id => ({ sessionId: id, title: '来源任务', cwd: '/workspace' }), recentRepliesEnabled: true,
    onDeliveryPending: () => blocks++, onReportSent: async ({ session, deliveryContext, recovered }) => {
      effects++;
      assert.equal(readPrivateJson(path).status, 'sent');
      assert.equal(session.cwd, '/workspace'); assert.equal(deliveryContext.selectionSnapshot.selectionVersion, 'v1');
      if (effects === 1) { assert.equal(recovered, false); throw new Error('local disk unavailable'); }
      assert.equal(recovered, true);
    } };
  await new TurnRelay(config).pollReports(async card => {
    sends++; assert.match(card.body.elements.at(-1).text.content, /最近10/);
    return { messageId: 'om_success', deliveryContext: { selectionSnapshot: { sessionId: value.sessionId, selectionVersion: 'v1' } } };
  });
  assert.equal(readPrivateJson(path).status, 'sent'); assert.equal(blocks, 1);
  const restarted = new TurnRelay({ ...config, sessionLookup: () => { throw new Error('metadata temporarily unavailable'); } });
  await restarted.reconcileSentReports();
  assert.equal(readPrivateJson(path).replyDeliveryApplied, true);
  await restarted.pollReports(async () => { sends++; return 'om_duplicate'; });
  assert.equal(sends, 1); assert.equal(effects, 2);
});

test('unknown delivery blocks target choice without retrying or manufacturing a successful route', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-delivery-unknown-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const value = report(Date.now()); writePrivateJson(join(dir, `${value.eventId}.json`), value);
  let effects = 0, blocks = 0, sends = 0;
  const relay = new TurnRelay({ outbox: dir, binary: process.execPath, threadId: value.sessionId,
    onReportSent: () => effects++, onDeliveryPending: () => blocks++ });
  await relay.pollReports(async () => { sends++; throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' }); });
  await relay.reconcileSentReports();
  await relay.pollReports(async () => { sends++; return 'om_never'; });
  assert.equal(sends, 1); assert.equal(effects, 0); assert.ok(blocks >= 1);
});

test('unknown-send intent is timed after slow media work, so a manual choice during preparation cannot hide it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-delivery-intent-time-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const started = Date.now(); let current = started;
  t.mock.method(Date, 'now', () => current);
  const value = report(started); writePrivateJson(join(dir, `${value.eventId}.json`), value);
  let pending;
  const relay = new TurnRelay({ outbox: dir, binary: process.execPath, threadId: value.sessionId,
    prepareReportMedia: async () => { current += 100; }, onReportSent() {}, onDeliveryPending: receipt => { pending = receipt; } });
  await relay.pollReports(async () => { throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' }); }, started);
  const ack = readPrivateJson(join(dir, '.relay-state', 'reports', `${value.eventId}.json`));
  assert.equal(ack.attemptedAtMs, started + 100); assert.equal(pending.sentAtMs, started + 100);
});

test('resuming skips queued reports from before the cutoff and delivers new reports only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-turn-resume-'));
  try {
    const now = Date.now();
    const old = report(now - 1);
    const fresh = { ...report(now), eventId: 'b'.repeat(64), turnId: 'turn_2' };
    for (const value of [old, fresh]) writePrivateJson(join(dir, `${value.eventId}.json`), value);
    const relay = new TurnRelay({ outbox: dir, binary: process.execPath, threadId: 'fixed_chat' });
    const delivered = [];
    await relay.pollReports(async (_card, _uuid, value) => {
      delivered.push(value.eventId);
      return 'om_new_report';
    }, now, now);
    assert.deepEqual(delivered, [fresh.eventId]);
    assert.equal(readPrivateJson(join(dir, '.relay-state', 'reports', `${old.eventId}.json`)).reason, 'before_connection_resumed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
