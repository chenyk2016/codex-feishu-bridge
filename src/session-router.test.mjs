/** Offline routing checks use synthetic catalogs and never touch real chats or queue processes. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionRouter, loadSessionCatalog, shortSessionId } from './session-router.mjs';
import { readPrivateJson, writePrivateJson, testCard } from './probe-core.mjs';
import { validateRequest } from './bridge-queue.mjs';
import { RecentChats } from './recent-chats.mjs';

const CATALOG = { version: 1, defaultSessionId: 'root_chat', sessions: [
  { sessionId: 'root_chat', title: '原聊天', cwd: '/workspace' },
  { sessionId: 'test_a', title: '测试 A', cwd: '/workspace', testCommandTag: 'allow' },
  { sessionId: 'test_b', title: '测试 B', cwd: '/workspace', testCommandTag: 'deny' },
] };

/** Make one timestamped owner instruction after this router was explicitly activated. */
function message(router, messageId, text, extra = {}) {
  return { messageId, text, createTime: String(Math.max(Date.now(), router.activatedAtMs)), ...extra };
}

/** Exercise the injected production store in private temporary files, with no network or real chat calls. */
function recentRouter(dir, extra = {}) {
  const catalog = structuredClone(CATALOG);
  const catalogPath = join(dir, 'catalog.json'); writePrivateJson(catalogPath, catalog);
  const recentChats = new RecentChats({ directory: join(dir, 'recent'), initialSession: catalog.sessions[0] });
  const calls = [];
  const router = new SessionRouter({ catalog, catalogPath, recentChats, storageDirectory: join(dir, 'routes'), binary: '/official/codex',
    queueRunner: async (_bin, id, body) => { calls.push({ id, body }); return { status: 'queued' }; }, ...extra });
  return { router, recentChats, calls, catalogPath };
}

function delivered(router, session, serial, extra = {}) {
  return router.recordReportDelivery(session, { eventId: `event_${serial}`, messageId: `om_report_${serial}`,
    deliveredAtMs: router.activatedAtMs + serial, expectedSelection: router.captureSelection(), newlySent: true, ...extra });
}

function pickerChoices(card) {
  return card.body.elements.flatMap((element) => element.columns ?? []).flatMap((column) => column.elements)
    .flatMap((element) => element.behaviors ?? []).map((behavior) => behavior.value).filter((value) => value.route === 'select_session');
}

test('archived chats are hidden from fresh pickers and stale buttons cannot select them', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-archive-picker-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archived = new Set();
  const { router, calls } = recentRouter(dir, { replyStatusLookup: id => archived.has(id) ? 'session_archived' : 'ready' });
  delivered(router, { sessionId: 'old_chat', title: '后来归档', cwd: '/workspace' }, 1);
  const old = router.createPicker(); router.noteControlSent(old.selectionId, 'om_old_picker');
  const choice = pickerChoices(old.card).find(value => value.session_id === 'old_chat');
  archived.add('old_chat');
  assert.equal(pickerChoices(router.createPicker().card).some(value => value.session_id === 'old_chat'), false);
  assert.equal(router.selectSession(choice, 'om_old_picker').status, 'invalid_selection');
  assert.equal(router.captureReplyTarget().status, 'session_archived');
  assert.equal((await router.routeMessage(message(router, 'om_archived', '归档后任务'))).status, 'session_archived');
  assert.equal(calls.length, 0);
  archived.delete('old_chat');
  assert.equal(router.captureReplyTarget().status, 'ready');
});

test('archival after receipt stops a captured task without redirecting it or issuing a queue call', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-archive-snapshot-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let status = 'ready'; const { router, calls } = recentRouter(dir, { replyStatusLookup: () => status });
  const snapshot = router.captureReplyTarget(); status = 'session_archived';
  const result = await router.routeMessage(message(router, 'om_late_archive', '已收消息', { targetSnapshot: snapshot }));
  assert.equal(result.status, 'session_archived'); assert.equal(calls.length, 0);
  status = 'target_unavailable';
  assert.equal(router.captureReplyTarget().status, 'target_unavailable');
  assert.match(router.createPicker().card.body.elements[0].text.content, /暂无可用/);
});

test('private catalog validates defaults and duplicate entries, and approval labels match registered test chats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-catalog-test-'));
  try {
    const path = join(dir, 'catalog.json'); writePrivateJson(path, CATALOG);
    assert.deepEqual(loadSessionCatalog(path), CATALOG);
    writePrivateJson(path, { ...CATALOG, sessions: [...CATALOG.sessions, CATALOG.sessions[1]] });
    assert.throws(() => loadSessionCatalog(path), /invalid/);
    const now = Date.now(); const runtime = { bridgeRunId: randomUUID(), expiresAtMs: now + 1000000 };
    const request = { version: 1, requestId: randomUUID(), kind: 'codex_permission', harmlessTest: 'allow', sessionId: 'test_a',
      turnId: 'turn1', bridgeRunId: runtime.bridgeRunId, createdAtMs: now, expiresAtMs: now + 600000 };
    assert.deepEqual(validateRequest(request, request.requestId, runtime, now, CATALOG), request);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('catalog approvals reject unregistered chats, a missing tag, and another chat test label', () => {
  const now = Date.now(); const runtime = { bridgeRunId: randomUUID(), expiresAtMs: now + 1000000 };
  const request = { version: 1, requestId: randomUUID(), kind: 'codex_permission', harmlessTest: 'allow', sessionId: 'test_a',
    turnId: 'turn1', bridgeRunId: runtime.bridgeRunId, createdAtMs: now, expiresAtMs: now + 600000 };
  for (const sessionId of ['not_registered', 'root_chat', 'test_b']) {
    assert.throws(() => validateRequest({ ...request, sessionId }, request.requestId, runtime, now, CATALOG), /not_registered/);
  }
  const label = '测试 A（test_a）\n目录：/workspace';
  assert.equal(testCard(request.requestId, undefined, 'allow', label).body.elements[0].text.content, label);
});

test('selection switches without executing, ordinary messages use selection, approvals and replies do not change it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-routing-test-'));
  try {
    const calls = [];
    const options = { catalog: CATALOG, storageDirectory: dir, binary: '/official/codex', queueRunner: async (_bin, id, body) => { calls.push({ id, body }); return { status: 'queued' }; } };
    const router = new SessionRouter(options);
    assert.equal(router.currentSessionId, 'root_chat');
    const picker = await router.routeMessage(message(router, 'om_switch', '切换聊天'));
    router.notePickerSent(picker.selectionId, 'om_picker');
    const choice = { route: 'select_session', selection_id: picker.selectionId, session_id: 'test_b' };
    assert.equal(router.selectSession(choice, 'wrong_message').status, 'invalid_selection');
    assert.equal(router.selectSession(choice, 'om_picker').status, 'switched');
    assert.equal(calls.length, 0);
    assert.equal(router.selectSession(choice, 'om_picker').status, 'invalid_selection');
    router.bindCard('om_card_a', 'test_a', { kind: 'approval', requestId: randomUUID(), turnId: 'turn_a' });
    router.bindCard('om_root_report', 'root_chat', { kind: 'report' });
    assert.equal(router.currentSessionId, 'test_b');
    assert.equal((await router.routeMessage(message(router, 'om_plain', '普通一句话'))).status, 'queued');
    assert.equal((await router.routeMessage(message(router, 'om_reply', '继续 引用A', { parentId: 'om_card_a' }))).status, 'queued');
    assert.equal(router.currentSessionId, 'test_b');
    assert.equal((await router.routeMessage(message(router, 'om_unknown', '未知引用不执行', { parentId: 'unknown' }))).status, 'unknown_reference');
    assert.equal((await router.routeMessage(message(router, 'om_conflict', '冲突引用不执行', { parentId: 'om_card_a', rootId: 'om_root_report' }))).status, 'conflicting_reference');
    assert.equal((await router.routeMessage(message(router, 'om_new', '新建'))).status, 'new_chat_requested');
    assert.deepEqual(calls, [{ id: 'test_b', body: '普通一句话' }, { id: 'test_a', body: '引用A' }]);
    const restarted = new SessionRouter(options);
    assert.equal(restarted.currentSessionId, 'test_b');
    assert.equal(restarted.activatedAtMs, router.activatedAtMs);
    assert.equal((await restarted.routeMessage(message(restarted, 'om_reply', '引用重放', { rootId: 'om_card_a' }))).status, 'duplicate');
    assert.equal(calls.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('activation cutoff is persistent and historical or unverifiable ordinary messages cannot execute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-cutoff-test-'));
  try {
    let calls = 0; const options = { catalog: CATALOG, storageDirectory: dir, binary: '/official/codex', queueRunner: async () => { calls++; return { status: 'queued' }; } };
    const router = new SessionRouter(options);
    assert.equal((await router.routeMessage(message(router, 'om_old_pair', 'probe-historical', { createTime: String(router.activatedAtMs - 1) }))).status, 'historical_message_ignored');
    assert.equal((await router.routeMessage({ messageId: 'om_no_time', text: '没有时间' })).status, 'unverified_message_time');
    assert.equal((await router.routeMessage(message(router, 'om_bad_time', '非法时间', { createTime: 'oops' }))).status, 'unverified_message_time');
    const restarted = new SessionRouter(options);
    assert.equal(restarted.activatedAtMs, readPrivateJson(join(dir, 'activation.json')).activatedAtMs);
    assert.equal((await restarted.routeMessage(message(restarted, 'om_old_retry', '旧事件重推', { createTime: String(router.activatedAtMs - 1) }))).status, 'historical_message_ignored');
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('management entry points and fresh issued menu callbacks never execute tasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-management-test-'));
  try {
    let calls = 0;
    const router = new SessionRouter({ catalog: structuredClone(CATALOG), storageDirectory: dir, binary: '/official/codex', queueRunner: async () => { calls++; return { status: 'queued' }; } });
    const menu = await router.routeMessage({ text: '菜单' });
    assert.equal(menu.status, 'session_menu');
    const buttons = menu.card.body.elements[1].columns.map((column) => column.elements[0]);
    assert.deepEqual(buttons.map((button) => button.text.content), ['新建聊天', '切换聊天', '当前聊天']);
    const createAction = buttons[0].behaviors[0].value;
    assert.equal(router.handleControlAction(createAction, 'unissued_message').status, 'invalid_selection');
    router.noteControlSent(menu.controlId, 'om_menu');
    assert.equal(router.handleControlAction(createAction, 'wrong_message').status, 'invalid_selection');
    const createRequest = router.handleControlAction(createAction, 'om_menu');
    assert.equal(createRequest.status, 'new_chat_requested');
    assert.equal(createRequest.selectionSnapshot.sessionId, 'root_chat');
    assert.notEqual(createRequest.controlId, menu.controlId);
    assert.equal(createRequest.card.body.elements[1].columns.length, 3);
    const stillUsable = createRequest.card.body.elements[1].columns[2].elements[0].behaviors[0].value;
    assert.equal(router.handleControlAction(stillUsable, 'om_menu').status, 'current_session');
    assert.equal(router.handleControlAction(createAction, 'om_menu').status, 'invalid_selection');
    assert.equal(router.handleControlAction({ route: 'session_menu', action: 'new_chat', control_id: randomUUID() }, 'om_report').status, 'invalid_selection');
    const current = await router.routeMessage({ text: '当前聊天' });
    assert.equal(current.status, 'current_session');
    assert.notEqual(current.controlId, menu.controlId);
    router.noteControlSent(current.controlId, 'om_current');
    const switchAction = current.card.body.elements[1].columns[1].elements[0].behaviors[0].value;
    const picker = router.handleControlAction(switchAction, 'om_current');
    assert.equal(picker.status, 'choose_session');
    assert.equal(picker.replaceMessage, true);
    assert.notEqual(picker.controlId, current.controlId);
    const switched = router.selectSession({ route: 'select_session', selection_id: picker.selectionId, session_id: 'test_a' }, 'om_current');
    assert.equal(switched.status, 'switched');
    assert.equal(switched.card.header.title.content, '已切换聊天');
    assert.equal(switched.card.body.elements[1].columns.length, 3);
    assert.notEqual(switched.controlId, picker.controlId);
    const switchAgain = switched.card.body.elements[1].columns[1].elements[0].behaviors[0].value;
    const nextPicker = router.handleControlAction(switchAgain, 'om_current');
    assert.equal(nextPicker.status, 'choose_session');
    const switchedAgain = router.handleControlAction({ route: 'select_session', selection_id: nextPicker.selectionId, session_id: 'test_b' }, 'om_current');
    assert.equal(switchedAgain.status, 'switched');
    assert.equal(router.currentSessionId, 'test_b');
    assert.equal(router.handleControlAction(switchAgain, 'om_current').status, 'invalid_selection');
    router.bindCard('om_fixed_approval', 'test_a', { kind: 'approval' });
    assert.throws(() => router.bindCard('om_fixed_approval', 'test_b', { kind: 'selection' }), /binding_conflict/);
    assert.equal((await router.routeMessage({ text: '新建聊天' })).status, 'new_chat_requested');
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pickers paginate eight chats at a time and reject hidden, expired or replayed controls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-pages-test-'));
  try {
    const many = { version: 1, defaultSessionId: 'root_chat', sessions: [CATALOG.sessions[0], ...Array.from({ length: 18 }, (_, index) => ({ sessionId: `chat_${index}`, title: `聊天${index}`, cwd: '/workspace' }))] };
    const router = new SessionRouter({ catalog: many, storageDirectory: dir, binary: '/official/codex' });
    const first = router.createPicker();
    const choices = (card) => card.body.elements.flatMap((element) => element.columns ?? []).flatMap((column) => column.elements).flatMap((element) => element.behaviors ?? []).map((behavior) => behavior.value).filter((value) => value.route === 'select_session');
    assert.equal(choices(first.card).length, 8);
    router.noteControlSent(first.controlId, 'om_pages');
    assert.equal(router.selectSession({ route: 'select_session', selection_id: first.selectionId, session_id: 'chat_17' }, 'om_pages').status, 'invalid_selection');
    assert.equal(router.handleControlAction({ route: 'session_page', selection_id: first.selectionId, page: 2 }, 'om_pages').status, 'invalid_selection');
    const second = router.handleControlAction({ route: 'session_page', selection_id: first.selectionId, page: 1 }, 'om_pages');
    assert.equal(second.page, 1); assert.equal(second.totalPages, 3); assert.equal(choices(second.card).length, 8);
    assert.notEqual(second.controlId, first.controlId);
    assert.equal(router.handleControlAction({ route: 'session_page', selection_id: first.selectionId, page: 1 }, 'om_pages').status, 'invalid_selection');
    const third = router.handleControlAction({ route: 'session_page', selection_id: second.selectionId, page: 2 }, 'om_pages');
    assert.equal(choices(third.card).length, 3);
    assert.equal(router.selectSession({ route: 'select_session', selection_id: third.selectionId, session_id: 'chat_17' }, 'om_pages', Date.now() + 600001).status, 'invalid_selection');
    assert.equal(router.currentSessionId, 'root_chat');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('atomic external catalog updates and another router selection are visible without restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-refresh-test-'));
  try {
    const catalogPath = join(dir, 'catalog.json'); writePrivateJson(catalogPath, CATALOG);
    const calls = [];
    const options = { catalogPath, storageDirectory: join(dir, 'state'), binary: '/official/codex', queueRunner: async (_bin, sessionId) => { calls.push(sessionId); return { status: 'queued' }; } };
    const router = new SessionRouter(options);
    const newChat = { sessionId: 'new_real_id', title: '新增聊天', cwd: '/workspace' };
    writePrivateJson(catalogPath, { ...CATALOG, sessions: [...CATALOG.sessions, newChat] });
    assert.equal(router.getSession(newChat.sessionId).title, newChat.title);
    assert.equal(router.createPicker().card.body.elements.some((element) => element.text?.content.includes('新增聊天')), true);
    router.selectRegisteredSession(newChat.sessionId);
    await router.routeMessage(message(router, 'om_added', '发到新增会话'));
    const peer = new SessionRouter(options); peer.selectRegisteredSession('test_b');
    await router.routeMessage(message(router, 'om_peer_selection', '发到另一进程已选会话'));
    assert.deepEqual(calls, ['new_real_id', 'test_b']);
    writePrivateJson(catalogPath, { ...CATALOG, defaultSessionId: 'test_a' });
    assert.throws(() => router.createMenu(), /root_changed/);
    assert.equal(calls.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('late creation registers its real ID but never overrides a later explicit selection version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-register-test-'));
  try {
    const catalogPath = join(dir, 'catalog.json'); writePrivateJson(catalogPath, CATALOG);
    const router = new SessionRouter({ catalogPath, storageDirectory: join(dir, 'state'), binary: '/official/codex' });
    const original = router.captureSelection();
    router.selectRegisteredSession('root_chat');
    assert.notEqual(router.captureSelection().selectionVersion, original.selectionVersion);
    const created = { sessionId: 'confirmed_real_id', title: '真实创建结果', cwd: '/workspace' };
    const late = router.registerSession(created, { expectedSelection: original, select: true });
    assert.equal(late.registered, true); assert.equal(late.selected, false); assert.equal(router.currentSessionId, 'root_chat');
    assert.equal(readPrivateJson(catalogPath).defaultSessionId, 'root_chat');
    const fresh = router.captureSelection();
    const selected = router.registerSession(created, { expectedSelection: fresh, select: true });
    assert.equal(selected.registered, false); assert.equal(selected.selected, false); assert.equal(router.currentSessionId, 'root_chat');
    assert.equal(router.captureSelection().selectionVersion, fresh.selectionVersion);
    const another = { sessionId: 'another_confirmed_id', title: '另一个真实创建结果', cwd: '/workspace' };
    const chosen = router.registerSession(another, { expectedSelection: fresh, select: true });
    assert.equal(chosen.registered, true); assert.equal(chosen.selected, true); assert.equal(router.currentSessionId, another.sessionId);
    const firstSelectedVersion = router.captureSelection().selectionVersion;
    router.registerSession(another, { expectedSelection: fresh, select: true });
    assert.equal(router.captureSelection().selectionVersion, firstSelectedVersion);
    router.selectRegisteredSession('test_b');
    const later = router.captureSelection();
    router.registerSession(another, { expectedSelection: later, select: true });
    assert.equal(router.currentSessionId, 'test_b');
    assert.equal(router.captureSelection().selectionVersion, later.selectionVersion);
    assert.equal(readPrivateJson(catalogPath).sessions.filter((item) => item.sessionId === created.sessionId).length, 1);
    assert.throws(() => router.registerSession({ ...created, title: '不能覆盖已有元数据' }), /registration_conflict/);
    assert.throws(() => router.registerSession({ ...created, testCommandTag: 'allow' }), /registration_invalid/);
    assert.throws(() => router.registerSession({ ...created, sessionId: 'another_id' }, { select: true }), /expected_selection_required/);
    writePrivateJson(`${catalogPath}.lock`, { test: true });
    assert.throws(() => router.registerSession({ ...created, sessionId: 'lock_blocked' }), /state_busy/);
    unlinkSync(`${catalogPath}.lock`);
    assert.equal(readPrivateJson(catalogPath).sessions.some((item) => item.sessionId === 'lock_blocked'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('catalog capacity is one hundred and short identifiers distinguish shared prefixes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-capacity-test-'));
  try {
    const catalogPath = join(dir, 'catalog.json');
    const full = { version: 1, defaultSessionId: 'root_chat', sessions: [CATALOG.sessions[0], ...Array.from({ length: 99 }, (_, index) => ({ sessionId: `registered_${index}`, title: `聊天${index}`, cwd: '/workspace' }))] };
    writePrivateJson(catalogPath, full); assert.equal(loadSessionCatalog(catalogPath).sessions.length, 100);
    const router = new SessionRouter({ catalogPath, storageDirectory: join(dir, 'state'), binary: '/official/codex' });
    assert.throws(() => router.registerSession({ sessionId: 'overflow', title: '超过上限', cwd: '/workspace' }), /catalog_invalid/);
    assert.equal(readPrivateJson(catalogPath).sessions.length, 100);
    const a = shortSessionId('10000000-0000-4000-8000-000000e93d77');
    const b = shortSessionId('10000000-0000-4000-8000-0000003cfe1f');
    assert.notEqual(a, b); assert.match(a, /e93d77$/); assert.match(b, /3cfe1f$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('image routing retains captured target across a later selection and rejects conflicting references', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-image-target-'));
  try {
    const calls = [];
    const router = new SessionRouter({ catalog: CATALOG, storageDirectory: dir, binary: '/official/codex',
      queueRunner: async (_bin, id, body) => { calls.push({ id, body }); return { status: 'queued' }; } });
    const captured = router.currentSessionId;
    const picker = router.createPicker(); router.notePickerSent(picker.selectionId, 'om_image_picker');
    assert.equal(router.selectSession({ route: 'select_session', selection_id: picker.selectionId, session_id: 'test_b' }, 'om_image_picker').status, 'switched');
    assert.equal((await router.routeMessage(message(router, 'om_image', '查看本机图片', { targetSessionId: captured }))).status, 'queued');
    assert.deepEqual(calls, [{ id: 'root_chat', body: '查看本机图片' }]);
    assert.equal(router.currentSessionId, 'test_b');
    router.bindCard('om_a_image', 'test_a', { kind: 'report' });
    assert.equal((await router.routeMessage(message(router, 'om_bad_target', '图', { targetSessionId: 'not_registered' }))).status, 'unknown_session');
    assert.equal((await router.routeMessage(message(router, 'om_target_conflict', '图', { targetSessionId: captured, parentId: 'om_a_image' }))).status, 'conflicting_reference');
    assert.equal(calls.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recent pickers show only ten MRU chats in two pages without extending approvals or old selection state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-recent-picker-'));
  try {
    const { router, recentChats, catalogPath } = recentRouter(dir);
    const originalCatalog = readFileSync(catalogPath, 'utf8');
    const legacyPath = join(dir, 'routes', 'selection.json');
    assert.equal(existsSync(legacyPath), false);
    const legacySelection = { version: 1, sessionId: 'test_b', selectionVersion: randomUUID(), selectedAtMs: Date.now() };
    writePrivateJson(legacyPath, legacySelection);
    const before = readFileSync(legacyPath, 'utf8');
    const first = router.createPicker(); router.noteControlSent(first.controlId, 'om_old_root_picker');
    for (let index = 1; index <= 12; index++) delivered(router, { sessionId: `recent_${index}`, title: `最近聊天 ${index}`, cwd: '/workspace' }, index);
    assert.deepEqual(recentChats.list().map((session) => session.sessionId), Array.from({ length: 10 }, (_, index) => `recent_${12 - index}`));
    assert.equal(router.getSession('root_chat').sessionId, 'root_chat');
    assert.equal(router.getRegisteredSession('root_chat').sessionId, 'root_chat');
    assert.equal(router.getRegisteredSession('test_a').testCommandTag, 'allow');
    assert.equal(router.getRegisteredSession('recent_12'), undefined);
    assert.equal(router.getSession('recent_1'), undefined);
    assert.equal(router.selectSession({ route: 'select_session', selection_id: first.controlId, session_id: 'root_chat' }, 'om_old_root_picker').status, 'invalid_selection');
    const picker = router.createPicker(); router.noteControlSent(picker.controlId, 'om_recent_pages');
    assert.equal(picker.totalPages, 2); assert.equal(pickerChoices(picker.card).length, 8);
    assert.equal(pickerChoices(picker.card).some((value) => value.session_id === 'root_chat'), false);
    const second = router.handleControlAction({ route: 'session_page', selection_id: picker.controlId, page: 1 }, 'om_recent_pages');
    assert.equal(pickerChoices(second.card).length, 2);
    assert.equal(router.selectSession({ route: 'select_session', selection_id: second.controlId, session_id: 'recent_3' }, 'om_recent_pages').status, 'switched');
    assert.equal(recentChats.list()[0].sessionId, 'recent_3');
    assert.equal(readFileSync(catalogPath, 'utf8'), originalCatalog);
    assert.equal(readFileSync(legacyPath, 'utf8'), before);
    const now = Date.now(); const runtime = { bridgeRunId: randomUUID(), expiresAtMs: now + 1000000 };
    const request = { version: 1, requestId: randomUUID(), kind: 'codex_permission', harmlessTest: 'allow', sessionId: 'recent_3',
      turnId: 'turn_recent', bridgeRunId: runtime.bridgeRunId, createdAtMs: now, expiresAtMs: now + 600000 };
    assert.throws(() => validateRequest(request, request.requestId, runtime, now, readPrivateJson(catalogPath)), /not_registered/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('confirmed reports select their source, manual picks win late sends and quotes preserve the report source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-recent-select-'));
  try {
    const { router, calls } = recentRouter(dir);
    const a = { sessionId: 'report_a', title: '报告 A', cwd: '/workspace' };
    const b = { sessionId: 'report_b', title: '报告 B', cwd: '/workspace' };
    assert.equal(delivered(router, a, 1).selected, true); router.bindCard('om_report_a', a.sessionId, { kind: 'report' });
    assert.equal(delivered(router, b, 2).selected, true); router.bindCard('om_report_b', b.sessionId, { kind: 'report' });
    await router.routeMessage(message(router, 'om_to_b', '默认回复'));
    const picker = router.createPicker(); router.noteControlSent(picker.controlId, 'om_manual_a');
    const inFlight = router.captureSelection();
    assert.equal(router.selectSession({ route: 'select_session', selection_id: picker.controlId, session_id: a.sessionId }, 'om_manual_a').status, 'switched');
    assert.equal(delivered(router, b, 3, { expectedSelection: inFlight }).selected, false);
    assert.equal(router.currentSessionId, a.sessionId);
    assert.equal(delivered(router, b, 3).reason, 'duplicate_delivery');
    assert.equal(router.currentSessionId, a.sessionId);
    await router.routeMessage(message(router, 'om_to_a', '手选回复'));
    assert.equal(delivered(router, b, 4).selected, true);
    const quoted = router.captureReplyTarget({ parentId: 'om_report_a' });
    assert.equal(quoted.status, 'ready'); assert.equal(quoted.session.sessionId, a.sessionId);
    await router.routeMessage(message(router, 'om_still_a', '引用回复', { parentId: 'om_report_a', targetSnapshot: quoted }));
    assert.equal(router.currentSessionId, b.sessionId);
    assert.equal(router.captureReplyTarget({ parentId: 'unknown_report' }).status, 'unknown_reference');
    assert.equal(router.captureReplyTarget({ parentId: 'om_report_a', rootId: 'om_report_b' }).status, 'conflicting_reference');
    assert.deepEqual(calls.map((call) => call.id), [b.sessionId, a.sessionId, a.sessionId]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('text and image snapshots remain fixed through report changes and eviction; fabricated targets never execute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-target-snapshot-'));
  try {
    const { router, calls } = recentRouter(dir);
    const origin = { sessionId: 'captured_origin', title: '已捕获聊天', cwd: '/workspace' };
    delivered(router, origin, 1); router.bindCard('om_origin_report', origin.sessionId, { kind: 'report' });
    const plain = router.captureReplyTarget();
    const quoted = router.captureReplyTarget({ parentId: 'om_origin_report' });
    assert.equal(Object.isFrozen(plain), true); assert.equal(Object.isFrozen(plain.session), true); assert.equal(Object.isFrozen(plain.selectionSnapshot), true);
    assert.throws(() => { plain.session.sessionId = 'root_chat'; }, TypeError);
    for (let index = 2; index <= 12; index++) delivered(router, { sessionId: `evict_${index}`, title: `新报告 ${index}`, cwd: '/workspace' }, index);
    assert.equal(router.getSession(origin.sessionId), undefined);
    assert.equal(router.captureReplyTarget({ parentId: 'om_origin_report' }).status, 'unknown_reference');
    assert.equal((await router.routeMessage(message(router, 'om_frozen_text', '文本', { targetSnapshot: plain }))).status, 'queued');
    assert.equal((await router.routeMessage(message(router, 'om_frozen_image', '图片下载后的正文', { parentId: 'om_origin_report', targetSnapshot: quoted, targetSessionId: origin.sessionId }))).status, 'queued');
    assert.equal((await router.routeMessage(message(router, 'om_frozen_image', '图片重复', { targetSnapshot: quoted }))).status, 'duplicate');
    assert.equal((await router.routeMessage(message(router, 'om_old_id', '只有旧ID', { targetSessionId: origin.sessionId }))).status, 'unknown_session');
    for (const targetSnapshot of [structuredClone(plain), { ...plain }, null, { status: 'target_unavailable' }]) {
      assert.equal((await router.routeMessage(message(router, 'om_fake', '伪造目标', { targetSnapshot }))).status, 'invalid_target');
    }
    assert.equal((await router.routeMessage(message(router, 'om_snapshot_conflict', '冲突', { targetSnapshot: plain, targetSessionId: 'root_chat' }))).status, 'invalid_target');
    assert.deepEqual(calls.map((call) => call.id), [origin.sessionId, origin.sessionId]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('new delivery failures block only new default replies; older receipts cannot unlock and manual choices can', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-default-gate-'));
  try {
    const { router, calls, recentChats, catalogPath } = recentRouter(dir);
    router.bindCard('om_known_root', 'root_chat', { kind: 'report' });
    const before = router.captureReplyTarget();
    assert.equal(router.blockDefaultReplies({ eventId: 'failed_new', sentAtMs: 200 }), true);
    assert.equal(router.captureReplyTarget().status, 'target_unavailable');
    assert.equal((await router.routeMessage(message(router, 'om_blocked_plain', '新普通消息'))).status, 'target_unavailable');
    assert.equal((await router.routeMessage(message(router, 'om_blocked_id', '仅有旧ID', { targetSessionId: 'root_chat' }))).status, 'target_unavailable');
    assert.equal(router.allowDefaultReplies({ eventId: 'old_success', sentAtMs: 199 }), false);
    assert.equal(router.allowDefaultReplies({ eventId: 'other_same_time', sentAtMs: 200 }), false);
    assert.equal(router.captureReplyTarget().status, 'target_unavailable');
    assert.equal((await router.routeMessage(message(router, 'om_before_failure', '先前已接收', { targetSnapshot: before }))).status, 'queued');
    const quoted = router.captureReplyTarget({ parentId: 'om_known_root' });
    assert.equal(quoted.status, 'ready');
    assert.equal((await router.routeMessage(message(router, 'om_quoted_gate', '明确引用', { parentId: 'om_known_root', targetSnapshot: quoted }))).status, 'queued');
    assert.equal((await router.routeMessage(message(router, 'om_legacy_quoted_gate', '明确引用旧入口', { parentId: 'om_known_root' }))).status, 'queued');
    for (const text of ['菜单', '切换聊天', '当前聊天', '新建', '新建聊天']) {
      const result = await router.routeMessage({ text, targetSnapshot: { status: 'ready' } });
      assert.notEqual(result.status, 'target_unavailable'); assert.notEqual(result.status, 'invalid_target');
    }
    assert.equal(router.allowDefaultReplies({ eventId: 'failed_new', sentAtMs: 200 }), true);
    assert.equal(router.captureReplyTarget().status, 'ready');
    assert.equal(router.blockDefaultReplies({ eventId: 'older_failure', sentAtMs: 199 }), false);
    router.blockDefaultReplies({ eventId: 'failed_next', sentAtMs: 201 });
    const picker = router.createPicker(); router.noteControlSent(picker.controlId, 'om_unblock_manual');
    assert.equal(router.selectSession({ route: 'select_session', selection_id: picker.controlId, session_id: 'root_chat' }, 'om_unblock_manual').status, 'switched');
    assert.equal(router.captureReplyTarget().status, 'ready');
    assert.equal(router.blockDefaultReplies({ eventId: 'failed_next', sentAtMs: 201 }), false);
    assert.equal(router.captureReplyTarget().status, 'ready');
    assert.equal(router.blockDefaultReplies({ eventId: 'failure_after_manual', sentAtMs: Date.now() + 1 }), true);
    assert.equal(router.captureReplyTarget().status, 'target_unavailable');
    const restartedStore = new RecentChats({ directory: join(dir, 'recent'), initialSession: CATALOG.sessions[0] });
    const restarted = new SessionRouter({ catalogPath, recentChats: restartedStore, storageDirectory: join(dir, 'routes'), binary: '/official/codex' });
    assert.equal(restarted.blockDefaultReplies({ eventId: 'old_failed_ack_after_restart', sentAtMs: recentChats.getSelection().selectedAtMs }), false);
    assert.equal(restarted.captureReplyTarget().status, 'ready');
    assert.equal(calls.length, 3);
    assert.throws(() => router.blockDefaultReplies({ eventId: 'invalid', sentAtMs: NaN }), /invalid_delivery_watermark/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('confirmed creation still registers statically while recent selection uses the atomic store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-recent-create-'));
  try {
    const { router, catalogPath } = recentRouter(dir);
    const created = { sessionId: 'created_real_chat', title: '真实创建', cwd: '/workspace' };
    const result = router.registerSession(created, { expectedSelection: router.captureSelection(), select: true });
    assert.equal(result.registered, true); assert.equal(result.selected, true);
    assert.equal(router.getCurrentSession().sessionId, created.sessionId);
    assert.equal(existsSync(join(dir, 'routes', 'selection.json')), false);
    assert.equal(readPrivateJson(catalogPath).sessions.some((session) => session.sessionId === created.sessionId), true);
    assert.equal(router.createPicker().card.body.elements.some((element) => element.text?.content?.includes('真实创建')), true);
    const stale = router.captureSelection();
    router.selectRegisteredSession('test_a');
    const late = router.registerSession({ sessionId: 'created_late_chat', title: '晚创建', cwd: '/workspace' }, { expectedSelection: stale, select: true });
    assert.equal(late.registered, true); assert.equal(late.selected, false);
    assert.equal(router.getCurrentSession().sessionId, 'test_a');
    assert.equal(pickerChoices(router.createPicker().card).some(value => value.session_id === 'created_late_chat'), true);
    const beforeReplay = router.captureSelection();
    router.registerSession({ sessionId: 'created_late_chat', title: '晚创建', cwd: '/workspace' }, { expectedSelection: stale, select: true });
    assert.deepEqual(router.captureSelection(), beforeReplay);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
