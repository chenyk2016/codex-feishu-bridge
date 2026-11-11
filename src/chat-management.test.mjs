/** Offline creation checks use owned temporary files and injected transports, never real chats. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChatManagement, INITIAL_CHAT_PROMPT, claimCreation, completeCreation, parseCreationDetails, readCreationRequest } from './chat-management.mjs';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';
import { SessionRouter } from './session-router.mjs';

const ROOT = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const DETAILS = '标题：飞书新聊天\n任务：只在新聊天里分析这个例子，随后等待指导。';
const FIRST_TASK = parseCreationDetails(DETAILS).firstTask;

/** Reopen the same private state with a real router, while recording every simulated queue. */
function fixture(t, { queueRunner } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-chat-management-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalogPath = join(directory, 'catalog.json');
  const creationDirectory = join(directory, 'creation');
  const catalog = { version: 1, defaultSessionId: ROOT, sessions: [
    { sessionId: ROOT, title: '控制聊天', cwd: '/workspace' },
    { sessionId: OTHER, title: '已存在的另一聊天', cwd: '/workspace' },
  ] };
  writePrivateJson(catalogPath, catalog);
  const calls = [], logs = [];
  const transport = async (binary, sessionId, text) => {
    calls.push({ binary, sessionId, text });
    return queueRunner ? queueRunner(binary, sessionId, text) : { status: 'queued' };
  };
  const f = { directory, catalogPath, creationDirectory, calls, logs };
  f.reopen = () => {
    f.router = new SessionRouter({ catalogPath, storageDirectory: join(directory, 'routing'), binary: '/offline/codex', queueRunner: transport });
    f.manager = new ChatManagement({ directory: creationDirectory, binary: '/offline/codex', controlThreadId: ROOT,
      cwd: '/workspace', router: f.router, queueRunner: transport, log: (event, data) => logs.push({ event, data }) });
  };
  f.begin = () => {
    const snapshot = f.router.captureSelection();
    const result = f.manager.begin(snapshot);
    const draft = readPrivateJson(join(creationDirectory, 'draft.json'));
    return { result, draft, snapshot };
  };
  f.submit = async (messageId = `om_${randomUUID()}`, text = DETAILS) => {
    const { draft } = f.begin();
    const now = Math.max(Date.now(), f.router.activatedAtMs);
    const response = await f.manager.consumeDetails(messageId, text, String(now), now);
    return { requestId: draft.requestId, messageId, response, request: readCreationRequest(creationDirectory, draft.requestId) };
  };
  f.progress = (requestId) => readPrivateJson(join(creationDirectory, 'progress', `${requestId}.json`));
  f.writeProgress = (requestId, value) => writePrivateJson(join(creationDirectory, 'progress', `${requestId}.json`),
    { version: 1, requestId, ...value });
  f.created = (requestId, sessionId = randomUUID()) => {
    assert.equal(claimCreation(creationDirectory, requestId, ROOT).status, 'ready_to_create_once');
    completeCreation(creationDirectory, requestId, ROOT, { status: 'created', sessionId });
    return sessionId;
  };
  f.reopen();
  return f;
}

test('details require explicit ordered title/task fields and preserve the whole task', () => {
  assert.deepEqual(parseCreationDetails('  标题： 新聊天  \r\n任务： 第一行\n第二行  '), { title: '新聊天', firstTask: '第一行\n第二行' });
  assert.deepEqual(parseCreationDetails('标题:ASCII 分隔\n任务:任务'), { title: 'ASCII 分隔', firstTask: '任务' });
  assert.deepEqual(parseCreationDetails(`标题：${'🧪'.repeat(80)}\n任务：${'🙂'.repeat(4000)}`), { title: '🧪'.repeat(80), firstTask: '🙂'.repeat(4000) });
  for (const value of [undefined, null, 1, '', '普通聊天', '标题：只有标题', '任务：任务\n标题：标题',
    '标题：\n任务：任务', '标题：\n任务：不能成为标题\n任务：真正任务', '标题：标题\n任务：  ',
    `标题：${'字'.repeat(81)}\n任务：任务`, `标题：标题\n任务：${'字'.repeat(4001)}`,
    '标题：有\t制表符\n任务：任务', '标题：标题\n任务：含\0字符']) {
    assert.equal(parseCreationDetails(value), null, `unexpectedly accepted ${JSON.stringify(value)}`);
  }
});

test('new chat metadata may become ready before a bounded wait without prematurely claiming or duplicating its first task', async t => {
  const f = fixture(t), { requestId } = await f.submit(), id = f.created(requestId);
  let time = Date.now(), availability = 'target_unavailable';
  f.manager.clock = () => time;
  f.router.replyStatus = () => availability;
  const notices = [];
  const send = async text => { notices.push(text); return 'om_creation_ready'; };
  await f.manager.pollResults(send);
  assert.equal(f.progress(requestId).status, 'waiting_for_chat_ready');
  assert.equal(readdirSync(join(f.creationDirectory, 'first-tasks')).length, 0);
  assert.equal(f.calls.length, 1); assert.equal(notices.length, 0);
  f.router.selectRegisteredSession(ROOT);
  time += 29999; await f.manager.pollResults(send);
  assert.equal(f.calls.length, 1);
  availability = 'ready'; await f.manager.pollResults(send);
  assert.equal(f.progress(requestId).status, 'first_task_queued');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].sessionId, id);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /保留当前回复目标/);
  assert.equal(f.router.getCurrentSession().sessionId, ROOT);
  await f.manager.pollResults(send); assert.equal(f.calls.length, 2);
});

test('archived or persistently unavailable new chats never receive an automatic first task', async t => {
  for (const mode of ['session_archived', 'target_unavailable']) await t.test(mode, async t => {
    const f = fixture(t), { requestId } = await f.submit(); f.created(requestId);
    let time = Date.now(); f.manager.clock = () => time; f.router.replyStatus = () => mode;
    const notices = [], send = async text => { notices.push(text); return 'om_creation_blocked'; };
    await f.manager.pollResults(send);
    if (mode === 'target_unavailable') { time += 30000; await f.manager.pollResults(send); }
    assert.equal(f.progress(requestId).status, 'first_task_failed');
    assert.equal(readdirSync(join(f.creationDirectory, 'first-tasks')).length, 0);
    assert.equal(f.calls.length, 1); assert.equal(notices.length, 1);
    assert.match(notices[0], mode === 'session_archived' ? /已归档/ : /尚未准备好/);
    f.reopen(); await f.manager.pollResults(send); assert.equal(f.calls.length, 1);
  });
});

test('an explicit switch can abandon a draft without cancelling an already submitted creation', async (t) => {
  const f = fixture(t);
  f.begin();
  assert.equal(f.manager.cancelDraft(), true);
  assert.equal(await f.manager.consumeDetails('ordinary_after_switch', '请继续当前聊天', String(Date.now())), null);
  const { requestId } = await f.submit();
  assert.equal(f.manager.cancelDraft(), false);
  assert.equal(readCreationRequest(f.creationDirectory, requestId).kind, 'owner_create_chat');
  assert.equal(f.calls.length, 1);
});

test('ordinary text and even a details-shaped message are untouched without an explicit draft', async (t) => {
  const f = fixture(t);
  const now = String(Math.max(Date.now(), f.router.activatedAtMs));
  assert.equal(await f.manager.consumeDetails('om_plain', '帮我继续上一项任务', now), null);
  assert.equal(await f.manager.consumeDetails('om_no_draft', DETAILS, now), null);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readdirSync(join(f.creationDirectory, 'requests')), []);
});

test('drafts require fresh verified messages; invalid input neither creates nor consumes the draft', async (t) => {
  const f = fixture(t);
  const { draft } = f.begin();
  const now = Math.max(Date.now(), f.router.activatedAtMs);
  for (const [messageId, createTime] of [
    ['om_historical', String(f.router.activatedAtMs - 1)], ['om_missing', undefined], ['om_bad', 'NaN'],
    ['om_seconds', String(Math.floor(now / 1000))], ['om_future', String(now + 30001)], ['', String(now)],
  ]) {
    assert.equal((await f.manager.consumeDetails(messageId, DETAILS, createTime, now)).status, 'creation_invalid_message');
  }
  assert.equal((await f.manager.consumeDetails('om_bad_details', '普通正文，不是标题和任务', String(now), now)).status, 'creation_invalid_details');
  assert.equal(readPrivateJson(join(f.creationDirectory, 'draft.json')).requestId, draft.requestId);
  assert.equal(readPrivateJson(join(f.creationDirectory, 'draft.json')).status, 'draft');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readdirSync(join(f.creationDirectory, 'requests')), []);
});

test('messages predating this draft cannot submit details or cancel the new input step', async (t) => {
  const f = fixture(t);
  const previousMessageTime = Math.max(Date.now(), f.router.activatedAtMs);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { draft } = f.begin();
  assert.ok(draft.createdAtMs > previousMessageTime);
  assert.equal((await f.manager.consumeDetails('om_previous_details', DETAILS, String(previousMessageTime))).status, 'creation_invalid_message');
  assert.equal((await f.manager.consumeDetails('om_previous_cancel', '取消新建', String(previousMessageTime))).status, 'creation_invalid_message');
  assert.equal(readPrivateJson(join(f.creationDirectory, 'draft.json')).status, 'draft');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readdirSync(join(f.creationDirectory, 'requests')), []);
});

test('a second new click retains its live draft, cancellation and expiry do not create chats', async (t) => {
  const f = fixture(t);
  const first = f.begin();
  assert.equal(f.begin().draft.requestId, first.draft.requestId);
  const now = Math.max(Date.now(), f.router.activatedAtMs);
  assert.equal((await f.manager.consumeDetails('om_cancel', '取消新建', String(now), now)).status, 'creation_cancelled');
  assert.equal(await f.manager.consumeDetails('om_after_cancel', DETAILS, String(now), now), null);
  const fresh = f.begin();
  assert.notEqual(fresh.draft.requestId, first.draft.requestId);
  assert.equal((await f.manager.consumeDetails('om_expired', DETAILS, String(now), fresh.draft.expiresAtMs)).status, 'creation_draft_expired');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readdirSync(join(f.creationDirectory, 'requests')), []);
});

test('submission persists private request and dispatch intent before sending only a control request to root', async (t) => {
  let f;
  f = fixture(t, { queueRunner: async (_binary, sessionId, prompt) => {
    const names = readdirSync(join(f.creationDirectory, 'requests'));
    assert.equal(names.length, 1);
    const request = readPrivateJson(join(f.creationDirectory, 'requests', names[0]));
    assert.equal(f.progress(request.requestId).status, 'control_dispatching');
    assert.equal(sessionId, ROOT);
    assert.match(prompt, new RegExp(request.requestId));
    assert.match(prompt, /create_thread/);
    assert.equal(prompt.includes(FIRST_TASK), false);
    assert.equal(statSync(join(f.creationDirectory, 'requests', names[0])).mode & 0o777, 0o600);
    return { status: 'queued' };
  } });
  const submitted = await f.submit();
  assert.equal(submitted.response.status, 'creation_queued');
  assert.equal(submitted.request.title, '飞书新聊天');
  assert.equal(submitted.request.firstTask, FIRST_TASK);
  assert.equal(submitted.request.controlThreadId, ROOT);
  assert.equal(submitted.request.cwd, '/workspace');
  assert.equal(typeof submitted.request.selectionSnapshot.selectionVersion, 'string');
  assert.equal(f.progress(submitted.requestId).status, 'waiting_for_creation');
  assert.equal(f.calls.length, 1);
  assert.equal(f.router.currentSessionId, ROOT);
});

test('only the fixed root can claim, and an immutable claim never grants creation a second time', async (t) => {
  const f = fixture(t), { requestId, request } = await f.submit();
  assert.throws(() => claimCreation(f.creationDirectory, requestId, OTHER), /wrong_control_chat/);
  const claim = claimCreation(f.creationDirectory, requestId, ROOT);
  assert.deepEqual(claim, { status: 'ready_to_create_once', requestId, title: request.title, cwd: '/workspace', initialPrompt: INITIAL_CHAT_PROMPT });
  assert.equal(JSON.stringify(claim).includes(FIRST_TASK), false);
  assert.equal(claimCreation(f.creationDirectory, requestId, ROOT).status, 'already_claimed_do_not_create_again');
  f.reopen();
  assert.equal(claimCreation(f.creationDirectory, requestId, ROOT).status, 'already_claimed_do_not_create_again');
  assert.equal(claimCreation(f.creationDirectory, requestId, ROOT, request.expiresAtMs).status, 'expired');
  assert.throws(() => readCreationRequest(f.creationDirectory, '../outside'), /invalid_request_id/);
});

test('claim rejects an unclaimed expired request without leaving a claim', async (t) => {
  const f = fixture(t), { requestId, request } = await f.submit();
  assert.equal(claimCreation(f.creationDirectory, requestId, ROOT, request.expiresAtMs + 1).status, 'expired');
  assert.deepEqual(readdirSync(join(f.creationDirectory, 'claims')), []);
});

test('complete requires the claim and a real distinct UUID; same result is idempotent and conflicts fail', async (t) => {
  const f = fixture(t), { requestId } = await f.submit(), sessionId = randomUUID();
  assert.throws(() => completeCreation(f.creationDirectory, requestId, ROOT, { status: 'created', sessionId }));
  claimCreation(f.creationDirectory, requestId, ROOT);
  assert.throws(() => completeCreation(f.creationDirectory, requestId, OTHER, { status: 'created', sessionId }), /wrong_control_chat/);
  for (const value of ['not_a_real_uuid', ROOT, undefined]) {
    assert.throws(() => completeCreation(f.creationDirectory, requestId, ROOT, { status: 'created', sessionId: value }), /invalid_result/);
  }
  const result = completeCreation(f.creationDirectory, requestId, ROOT, { status: 'created', sessionId });
  const saved = readPrivateJson(join(f.creationDirectory, 'results', `${requestId}.json`));
  assert.equal(result.sessionId, sessionId);
  assert.deepEqual(completeCreation(f.creationDirectory, requestId, ROOT, { status: 'created', sessionId }, Date.now() + 10), result);
  assert.deepEqual(readPrivateJson(join(f.creationDirectory, 'results', `${requestId}.json`)), saved);
  assert.equal(claimCreation(f.creationDirectory, requestId, ROOT).status, 'already_completed');
  assert.throws(() => completeCreation(f.creationDirectory, requestId, ROOT, { status: 'created', sessionId: randomUUID() }), /conflicting_result/);
  assert.throws(() => completeCreation(f.creationDirectory, requestId, ROOT, { status: 'create_unknown' }), /conflicting_result/);
});

test('a submitted Feishu message cannot be reused across restart or consume a newly opened draft', async (t) => {
  const f = fixture(t), { requestId, messageId } = await f.submit('om_repeat_submission');
  f.reopen();
  const { draft } = f.begin();
  assert.notEqual(draft.requestId, requestId);
  assert.equal((await f.manager.consumeDetails(messageId, DETAILS, String(Date.now()))).status, 'creation_duplicate');
  assert.equal(readPrivateJson(join(f.creationDirectory, 'draft.json')).status, 'draft');
  assert.equal(readdirSync(join(f.creationDirectory, 'requests')).length, 1);
  assert.equal(f.calls.length, 1);
  const hash = createHash('sha256').update(messageId).digest('hex');
  assert.equal(readPrivateJson(join(f.creationDirectory, 'submitted', `${hash}.json`)).requestId, requestId);
});

test('unconfirmed control delivery stays durable and is not automatically retried', async (t) => {
  const f = fixture(t, { queueRunner: async () => { throw new Error('simulated lost queue response'); } });
  const { requestId, messageId, response } = await f.submit();
  assert.equal(response.status, 'creation_dispatch_unconfirmed');
  assert.equal(f.progress(requestId).status, 'control_dispatch_unknown');
  f.reopen();
  assert.equal((await f.manager.consumeDetails(messageId, DETAILS, String(Date.now()))).status, 'creation_duplicate');
  await f.manager.pollResults(async () => assert.fail('no creation result exists'));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(readdirSync(join(f.creationDirectory, 'claims')), []);
});

test('confirmed result is registered on disk before its exact first task, and restart never replays it', async (t) => {
  let f, createdId;
  f = fixture(t, { queueRunner: async (_binary, sessionId, text) => {
    if (sessionId !== ROOT) {
      assert.equal(sessionId, createdId);
      assert.equal(text, FIRST_TASK);
      const catalog = readPrivateJson(f.catalogPath);
      assert.equal(catalog.sessions.find((session) => session.sessionId === createdId).title, '飞书新聊天');
      assert.equal(f.router.getSession(createdId).cwd, '/workspace');
      assert.equal(f.router.currentSessionId, createdId);
      const [requestFile] = readdirSync(join(f.creationDirectory, 'requests'));
      assert.equal(f.progress(requestFile.slice(0, -5)).status, 'first_task_dispatching');
    }
    return { status: 'queued' };
  } });
  const { requestId } = await f.submit();
  createdId = f.created(requestId);
  const messages = [];
  await f.manager.pollResults(async (text) => { messages.push(text); return 'om_creation_done'; });
  assert.equal(f.progress(requestId).status, 'first_task_queued');
  assert.equal(f.progress(requestId).notificationStatus, 'sent');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /当前回复目标为该聊天/);
  assert.match(messages[0], /第一条任务已加入新聊天/);
  assert.deepEqual(f.calls.map((call) => call.sessionId), [ROOT, createdId]);
  assert.equal(readPrivateJson(f.catalogPath).defaultSessionId, ROOT);
  f.reopen();
  await f.manager.pollResults(async () => assert.fail('confirmed report must not repeat'));
  assert.equal(f.router.currentSessionId, createdId);
  assert.equal(f.calls.length, 2);
});

test('a late control-queue acknowledgement cannot erase an already delivered creation result', async (t) => {
  let f, createdId;
  const messages = [];
  f = fixture(t, { queueRunner: async (_binary, sessionId) => {
    if (sessionId === ROOT) {
      const [requestFile] = readdirSync(join(f.creationDirectory, 'requests'));
      const requestId = requestFile.slice(0, -5);
      createdId = f.created(requestId);
      await f.manager.pollResults(async (text) => { messages.push(text); return 'om_result_before_ack'; });
    }
    return { status: 'queued' };
  } });
  const { requestId } = await f.submit();
  assert.equal(f.progress(requestId).status, 'first_task_queued');
  assert.equal(f.progress(requestId).notificationStatus, 'sent');
  assert.equal(messages.length, 1);
  f.reopen();
  await f.manager.pollResults(async () => assert.fail('an acknowledged result must not be reported twice'));
  assert.deepEqual(f.calls.map((call) => call.sessionId), [ROOT, createdId]);
});

test('a later explicit choice of even the same root survives a late creation result and restart', async (t) => {
  const f = fixture(t), { requestId, request } = await f.submit();
  const peer = new SessionRouter({ catalogPath: f.catalogPath, storageDirectory: join(f.directory, 'routing'), binary: '/offline/codex',
    queueRunner: async () => assert.fail('selecting never executes') });
  peer.selectRegisteredSession(ROOT);
  assert.notEqual(peer.captureSelection().selectionVersion, request.selectionSnapshot.selectionVersion);
  const lateId = f.created(requestId);
  const messages = [];
  await f.manager.pollResults(async (text) => { messages.push(text); return 'om_late_creation'; });
  assert.equal(f.router.currentSessionId, ROOT);
  assert.equal(f.router.getSession(lateId).title, request.title);
  assert.equal(f.calls.at(-1).sessionId, lateId);
  assert.equal(f.calls.at(-1).text, FIRST_TASK);
  assert.match(messages[0], /保留当前回复目标/);
  f.reopen();
  await f.manager.pollResults(async () => assert.fail('late result report already sent'));
  assert.equal(f.router.currentSessionId, ROOT);
  assert.equal(f.calls.length, 2);
});

test('both unknown first-task responses and thrown responses are recorded once and never replayed', async (t) => {
  for (const outcome of ['unknown', 'throw']) {
    await t.test(outcome, async (st) => {
      const f = fixture(st, { queueRunner: async (_binary, sessionId) => {
        if (sessionId === ROOT) return { status: 'queued' };
        if (outcome === 'throw') throw new Error('simulated first-task timeout');
        return { status: 'unknown' };
      } });
      const { requestId } = await f.submit();
      f.created(requestId);
      const messages = [];
      await f.manager.pollResults(async (text) => { messages.push(text); return 'om_task_uncertain'; });
      assert.equal(f.progress(requestId).status, 'first_task_unknown');
      assert.match(messages[0], /是否送达暂不确定/);
      f.reopen();
      await f.manager.pollResults(async () => assert.fail('uncertain task must not replay'));
      assert.equal(f.calls.length, 2);
    });
  }
});

test('crash-left dispatching, unknown and queued first-task intents prevent resend before report recovery', async (t) => {
  for (const status of ['first_task_dispatching', 'first_task_unknown', 'first_task_queued', 'first_task_failed']) {
    await t.test(status, async (st) => {
      const f = fixture(st), { requestId } = await f.submit();
      const sessionId = f.created(requestId);
      f.router.registerSession({ sessionId, title: '飞书新聊天', cwd: '/workspace' }, { select: true, expectedSelection: f.router.captureSelection() });
      f.writeProgress(requestId, { status, sessionId, autoSelected: true });
      f.reopen();
      const messages = [];
      await f.manager.pollResults(async (text) => { messages.push(text); return `om_recovered_${status}`; });
      assert.equal(f.calls.length, 1, 'only the original control prompt was sent');
      assert.equal(f.progress(requestId).status, status === 'first_task_dispatching' ? 'first_task_unknown' : status);
      assert.equal(messages.length, 1);
      f.reopen();
      await f.manager.pollResults(async () => assert.fail('recovered report must not repeat'));
      assert.equal(f.calls.length, 1);
    });
  }
});

test('failed-before-create and creation-unknown results report distinct outcomes without task or registration', async (t) => {
  for (const status of ['failed_before_create', 'create_unknown']) {
    await t.test(status, async (st) => {
      const f = fixture(st), { requestId } = await f.submit();
      claimCreation(f.creationDirectory, requestId, ROOT);
      completeCreation(f.creationDirectory, requestId, ROOT, { status });
      const messages = [];
      await f.manager.pollResults(async (text) => { messages.push(text); return `om_${status}`; });
      assert.equal(f.progress(requestId).status, status);
      assert.match(messages[0], status === 'create_unknown' ? /创建结果暂不确定/ : /创建未能开始/);
      assert.equal(readPrivateJson(f.catalogPath).sessions.length, 2);
      assert.equal(f.calls.length, 1);
      f.reopen();
      await f.manager.pollResults(async () => assert.fail('failure report must not repeat'));
      assert.equal(claimCreation(f.creationDirectory, requestId, ROOT).status, 'already_completed');
    });
  }
});

test('lost notification responses and crash-left sending markers are never automatically resent', async (t) => {
  for (const mode of ['throw', 'no_message_id', 'crashed_sending']) {
    await t.test(mode, async (st) => {
      const f = fixture(st), { requestId } = await f.submit();
      const sessionId = f.created(requestId);
      let sends = 0;
      if (mode === 'crashed_sending') {
        f.router.registerSession({ sessionId, title: '飞书新聊天', cwd: '/workspace' });
        f.writeProgress(requestId, { status: 'first_task_queued', sessionId, notificationStatus: 'sending' });
      } else {
        await f.manager.pollResults(async () => { sends++; if (mode === 'throw') throw new Error('simulated lost send response'); });
        assert.equal(f.progress(requestId).notificationStatus, 'unknown');
      }
      f.reopen();
      await f.manager.pollResults(async () => { sends++; assert.fail('uncertain notification must not replay'); });
      assert.equal(sends, mode === 'crashed_sending' ? 0 : 1);
      assert.equal(f.calls.length, mode === 'crashed_sending' ? 1 : 2);
    });
  }
});

test('cross-manager first-task and notice claims prevent replay even before progress is updated', async (t) => {
  const f = fixture(t), { requestId } = await f.submit();
  const sessionId = f.created(requestId);
  assert.equal(f.progress(requestId).status, 'waiting_for_creation');
  const firstTaskClaim = { version: 1, requestId, sessionId, attemptedAtMs: Date.now() };
  writeFileSync(join(f.creationDirectory, 'first-tasks', `${requestId}.json`), `${JSON.stringify(firstTaskClaim)}\n`, { mode: 0o600, flag: 'wx' });
  const firstManager = f.manager;
  f.reopen();
  const secondManager = f.manager;
  const messages = [];
  const sendText = async (text) => { messages.push(text); return 'om_should_not_be_sent'; };
  await Promise.all([firstManager.pollResults(sendText), secondManager.pollResults(sendText)]);
  assert.deepEqual(f.calls.map((call) => call.sessionId), [ROOT], 'the existing first-task claim wins before any progress update');
  assert.deepEqual(messages, [], 'an unconfirmed claimed task must not produce a success report');
  assert.equal(f.progress(requestId).status, 'waiting_for_creation');
  assert.equal(f.router.getSession(sessionId).title, '飞书新聊天');
  f.reopen();
  await f.manager.pollResults(sendText);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(messages, []);

  // Another listener claimed the notice after confirming delivery, but crashed before recording notificationStatus.
  f.writeProgress(requestId, { status: 'first_task_queued', sessionId, autoSelected: true });
  const noticeClaim = { version: 1, requestId, attemptedAtMs: Date.now() };
  writeFileSync(join(f.creationDirectory, 'notices', `${requestId}.json`), `${JSON.stringify(noticeClaim)}\n`, { mode: 0o600, flag: 'wx' });
  await Promise.all([firstManager.pollResults(sendText), secondManager.pollResults(sendText), f.manager.pollResults(sendText)]);
  assert.deepEqual(f.calls.map((call) => call.sessionId), [ROOT]);
  assert.deepEqual(messages, [], 'a notice claim prevents a second report even without notificationStatus');
  assert.deepEqual(readPrivateJson(join(f.creationDirectory, 'first-tasks', `${requestId}.json`)), firstTaskClaim);
  assert.deepEqual(readPrivateJson(join(f.creationDirectory, 'notices', `${requestId}.json`)), noticeClaim);
});
