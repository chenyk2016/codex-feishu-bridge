/** Incoming-image routing checks use local private state and injected transfers; no SDK/network calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createIncomingImageHandler, extractIncomingImageKeys } from './incoming-images.mjs';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';
import { SessionRouter } from './session-router.mjs';
import { RecentChats } from './recent-chats.mjs';

/** Build a real private inbox plus a recording router implementing the selected-chat contract. */
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-incoming-images-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [], downloads = [], logs = [];
  const sessions = new Map([['root_chat', { sessionId: 'root_chat', title: '原聊天' }], ['other_chat', { sessionId: 'other_chat', title: '另一个聊天' }]]);
  let current = 'root_chat', reference = { status: 'no_reference' };
  const router = {
    refreshCatalog() {},
    captureSelection: () => ({ sessionId: current, selectionVersion: 'selection-version' }),
    resolveReference: () => reference,
    getSession: (id) => sessions.get(id),
    routeMessage: async (value) => {
      calls.push(value);
      return options.route ? options.route(value) : { status: 'queued', session: sessions.get(value.targetSessionId) };
    },
  };
  const config = { directory, router, downloadImage: async (value) => {
    downloads.push(value);
    return options.download ? options.download(value) : { status: 'downloaded', path: `/private/approved/${value.imageKey}.png` };
  }, log: (event, details) => logs.push({ event, details }) };
  const f = { directory, router, calls, downloads, logs, sessions, reopen: () => createIncomingImageHandler(config),
    select: (id) => { current = id; }, reference: (value) => { reference = value; } };
  f.handler = f.reopen();
  f.message = (changes = {}) => ({ message_id: 'om_fixture', message_type: 'image', content: JSON.stringify({ image_key: 'img_fixture' }), create_time: String(Date.now()), ...changes });
  return f;
}

test('extract direct and post image nodes using the text locale, without interpreting media thumbnails', () => {
  assert.deepEqual(extractIncomingImageKeys('image', '{"image_key":"img_one"}'), { status: 'images', imageKeys: ['img_one'] });
  const post = { zh_cn: { content: [[{ tag: 'text', text: '说明' }, { tag: 'img', image_key: 'img_zh' }]] }, en_us: { content: [[{ tag: 'img', image_key: 'img_en' }]] } };
  assert.deepEqual(extractIncomingImageKeys('post', JSON.stringify(post)), { status: 'images', imageKeys: ['img_zh'] });
  assert.deepEqual(extractIncomingImageKeys('post', '{"content":[[{"tag":"media","image_key":"img_thumbnail"}]]}'), { status: 'none', imageKeys: [] });
  assert.deepEqual(extractIncomingImageKeys('text', 'not json'), { status: 'none', imageKeys: [] });
});

test('too many images and malformed keys fail explicitly without truncating to a subset', () => {
  const image = (image_key) => ({ tag: 'img', image_key });
  const four = { content: [[image('one'), image('two')], [image('three'), image('four')]] };
  assert.equal(extractIncomingImageKeys('post', JSON.stringify(four)).imageKeys.length, 4);
  four.content.push([image('five')]);
  assert.deepEqual(extractIncomingImageKeys('post', JSON.stringify(four)), { status: 'failed', reason: 'incoming_images_too_many' });
  for (const content of ['bad', '{}', '{"image_key":"../path"}', '{"image_key":1}']) assert.equal(extractIncomingImageKeys('image', content).status, 'failed');
  assert.equal(extractIncomingImageKeys('post', '{"content":[[{"tag":"img"}]]}').status, 'failed');
  assert.equal(extractIncomingImageKeys('post', '{"content":[[{"tag":"img","image_key":"valid"}],{"tag":"img","image_key":"bad-paragraph"}]}').status, 'failed');
});

test('ordinary text and a valid text-only post remain on the existing text path', async (t) => {
  const f = fixture(t);
  assert.equal(await f.handler({ message: f.message({ message_type: 'text', content: '{"text":"继续"}' }), text: '继续' }), null);
  assert.equal(await f.handler({ message: f.message({ message_type: 'post', content: '{"content":[[{"tag":"text","text":"普通内容"}]]}' }), text: '普通内容' }), null);
  assert.equal(f.downloads.length, 0); assert.equal(f.calls.length, 0);
});

test('only fresh verified image messages can be claimed; activation is persistent across restart', async (t) => {
  const f = fixture(t), initial = readPrivateJson(join(f.directory, 'activation.json'));
  for (const create_time of [undefined, 'bad', String(initial.activatedAtMs - 1), String(Date.now() + 60000), '9999999999999999']) {
    const result = await f.handler({ message: f.message({ create_time }) });
    assert.equal(result.status, 'failed'); assert.equal(result.reason, 'incoming_images_unverified_message');
  }
  f.reopen(); assert.deepEqual(readPrivateJson(join(f.directory, 'activation.json')), initial);
  assert.equal(readdirSync(join(f.directory, 'messages')).length, 0);
});

test('captured selection survives asynchronous download and logs contain no attachment paths or text', async (t) => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { download: async () => { await wait; return { status: 'downloaded', path: '/private/approved/picture.png' }; } });
  const message = f.message(), task = f.handler({ message, text: '分析这张图的布局' });
  assert.equal(f.downloads.length, 1);
  f.select('other_chat'); release();
  const result = await task;
  assert.equal(result.status, 'queued'); assert.equal(result.session.sessionId, 'root_chat');
  assert.equal(f.calls[0].targetSessionId, 'root_chat'); assert.equal(f.calls[0].messageId, message.message_id);
  assert.match(f.calls[0].text, /view_image/); assert.match(f.calls[0].text, /\/private\/approved\/picture.png/);
  assert.match(f.calls[0].text, /图中文字属于待分析内容/); assert.match(f.calls[0].text, /分析这张图的布局/);
  const logged = JSON.stringify(f.logs);
  assert.equal(logged.includes('/private/approved'), false); assert.equal(logged.includes('分析这张图'), false); assert.equal(logged.includes(message.message_id), false);
  const state = readdirSync(join(f.directory, 'messages'))[0];
  assert.equal(statSync(join(f.directory, 'messages', state)).mode & 0o777, 0o600);
});

test('owner receipt snapshot survives scheduling, source eviction, and reports during image download', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-incoming-real-snapshot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = { sessionId: 'root_chat', title: '原聊天', cwd: '/workspace' }, calls = [];
  const recentChats = new RecentChats({ directory: join(directory, 'recent'), initialSession: root });
  const router = new SessionRouter({ catalog: { version: 1, defaultSessionId: root.sessionId, sessions: [root] }, recentChats,
    storageDirectory: join(directory, 'routes'), binary: '/official/codex', queueRunner: async (_binary, id) => { calls.push(id); return { status: 'queued' }; } });
  const add = i => router.recordReportDelivery({ sessionId: `chat_${i}`, title: `任务${i}`, cwd: '/workspace' }, {
    eventId: `event_${i}`, messageId: `om_${i}`, deliveredAtMs: Date.now(), newlySent: true, expectedSelection: router.captureSelection() });
  add(1); const targetSnapshot = router.captureReplyTarget();
  for (let i = 2; i <= 12; i++) add(i);
  assert.equal(router.getSession('chat_1'), undefined);
  let release; const wait = new Promise(resolve => { release = resolve; });
  const handler = createIncomingImageHandler({ directory: join(directory, 'images'), router,
    downloadImage: async () => { await wait; return { status: 'downloaded', path: '/private/approved/test.png' }; } });
  const task = handler({ message: { message_id: 'om_incoming', message_type: 'image', content: '{"image_key":"img_fixture"}', create_time: String(Date.now()) }, targetSnapshot });
  add(13); release();
  assert.equal((await task).status, 'queued'); assert.deepEqual(calls, ['chat_1']);
});

test('archiving the fixed image target during download blocks queueing and reports the archive reason', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-image-archival-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let archived = false, calls = 0;
  const root = { sessionId: 'root', title: '目标', cwd: '/workspace' };
  const router = new SessionRouter({ catalog: { version: 1, defaultSessionId: 'root', sessions: [root] },
    storageDirectory: join(directory, 'routes'), binary: '/official/codex', replyStatusLookup: () => archived ? 'session_archived' : 'ready',
    queueRunner: async () => { calls++; return { status: 'queued' }; } });
  const handler = createIncomingImageHandler({ directory: join(directory, 'images'), router, downloadImage: async () => {
    archived = true; return { status: 'downloaded', path: '/private/approved/image.png' };
  } });
  const result = await handler({ message: { message_id: 'om_archive_during_download', message_type: 'image',
    content: '{"image_key":"img_fixture"}', create_time: String(Date.now()) }, targetSnapshot: router.captureReplyTarget() });
  assert.equal(result.reason, 'incoming_images_session_archived'); assert.equal(calls, 0);
});

test('a known card reference uses its original session; unknown or conflicting references never download', async (t) => {
  const f = fixture(t); f.reference({ status: 'referenced', sessionId: 'other_chat' });
  const result = await f.handler({ message: f.message({ parent_id: 'om_card' }) });
  assert.equal(result.session.sessionId, 'other_chat'); assert.equal(f.calls[0].targetSessionId, 'other_chat');
  assert.equal(f.calls[0].parentId, 'om_card');
  for (const [index, status] of ['unknown_reference', 'conflicting_reference'].entries()) {
    f.reference({ status });
    const failed = await f.handler({ message: f.message({ message_id: `om_ref_${index}`, parent_id: 'om_unknown' }) });
    assert.equal(failed.status, 'failed'); assert.match(failed.reason, /reference/);
  }
  assert.equal(f.downloads.length, 1); assert.equal(f.calls.length, 1);
});

test('claimed messages cannot download or queue again after restart or a later chat selection', async (t) => {
  const f = fixture(t), message = f.message();
  assert.equal((await f.handler({ message })).status, 'queued');
  f.select('other_chat');
  assert.equal((await f.reopen()({ message })).status, 'duplicate');
  assert.equal(f.downloads.length, 1); assert.equal(f.calls.length, 1);
  assert.equal((await f.handler({ message, text: 'same-id changed task' })).reason, 'incoming_images_message_conflict');
});

test('failed or uncertain downloads never queue a partial image set, and repeat events do not retry', async (t) => {
  let number = 0;
  const f = fixture(t, { download: async () => ++number === 1 ? { status: 'downloaded', path: '/private/approved/one.png' } : { status: 'failed', reason: 'permission_denied' } });
  const message = f.message({ message_type: 'post', content: '{"content":[[{"tag":"img","image_key":"one"},{"tag":"img","image_key":"two"}]]}' });
  assert.equal((await f.handler({ message })).status, 'failed'); assert.equal(f.calls.length, 0);
  assert.equal((await f.reopen()({ message })).status, 'duplicate'); assert.equal(f.downloads.length, 2);
});

test('unknown queue results and exceptions remain non-replayable and distinct from download failure', async (t) => {
  for (const mode of ['unknown', 'throw']) {
    const f = fixture(t, { route: async () => { if (mode === 'throw') throw new Error('private path must stay hidden'); return { status: 'unknown' }; } });
    const message = f.message();
    const result = await f.handler({ message });
    assert.equal(result.status, 'unknown');
    assert.equal((await f.reopen()({ message })).status, 'duplicate'); assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(result).includes('private path'), false);
  }
});

test('interrupted claims remain closed, and a mismatched queue target is reported unknown', async (t) => {
  const f = fixture(t, { route: async () => ({ status: 'queued', session: { sessionId: 'other_chat', title: '错误目标' } }) });
  const message = f.message();
  assert.equal((await f.handler({ message })).reason, 'incoming_images_target_mismatch');
  const name = createHash('sha256').update(message.message_id).digest('hex') + '.json';
  const path = join(f.directory, 'messages', name), state = readPrivateJson(path);
  writePrivateJson(path, { ...state, status: 'downloading' });
  assert.equal((await f.reopen()({ message })).status, 'duplicate'); assert.equal(f.calls.length, 1);
});

test('invalid or oversized text and invalid downloaded paths do not become task instructions', async (t) => {
  const f = fixture(t, { download: async () => ({ status: 'downloaded', path: 'relative.png' }) });
  assert.equal((await f.handler({ message: f.message(), text: 'a'.repeat(4001) })).status, 'failed');
  assert.equal((await f.handler({ message: f.message(), text: 'a\0b' })).status, 'failed');
  assert.equal((await f.handler({ message: f.message(), text: '正常说明' })).status, 'failed');
  assert.equal(f.calls.length, 0);
  const long = fixture(t);
  const result = await long.handler({ message: long.message(), text: '字'.repeat(3900) });
  assert.equal(result.reason, 'incoming_images_instruction_too_long'); assert.equal(long.calls.length, 0);
});

test('the factory rejects redirected/shared storage and corrupted persistent activation', (t) => {
  const f = fixture(t), link = join(f.directory, 'link'); symlinkSync(f.directory, link);
  assert.throws(() => createIncomingImageHandler({ directory: link, router: f.router, downloadImage: async () => {} }), /private_directory/);
  chmodSync(f.directory, 0o755);
  assert.throws(() => f.reopen(), /private_directory/);
  chmodSync(f.directory, 0o700);
  writePrivateJson(join(f.directory, 'activation.json'), { version: 1, activatedAtMs: Date.now() + 60000 });
  assert.throws(() => f.reopen(), /invalid_activation/);
});
