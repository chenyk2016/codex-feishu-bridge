/** Offline reply-target checks; no real chats, reports, credentials, or network calls. */
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RecentChats } from './recent-chats.mjs';

const ROOT = { sessionId: 'root', title: '原聊天', cwd: '/workspace' };
const session = (id) => ({ sessionId: `chat_${id}`, title: `聊天 ${id}`, cwd: '/workspace' });
const receipt = (id, at, extra = {}) => ({ eventId: `event_${id}`, messageId: `om_${id}`, deliveredAtMs: at, ...extra });

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-recent-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 100000;
  const clock = () => now;
  const store = new RecentChats({ directory, initialSession: ROOT, clock, ...options });
  return { directory, path: join(directory, 'recent-chats.json'), store, clock, advance: (delta = 1) => { now += delta; return now; } };
}

function persisted(path) { return JSON.parse(readFileSync(path, 'utf8')); }

test('bootstrap stores one private atomic state and exposes detached metadata and selection', (t) => {
  const { directory, path, store } = fixture(t);
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory), ['recent-chats.json']);
  assert.deepEqual(store.list(), [ROOT]);
  assert.equal(store.getSelection().sessionId, ROOT.sessionId);
  assert.equal(store.getSelection().reason, 'initial');
  assert.equal(store.getSelection().selectedAtMs, store.activatedAtMs);
  assert.equal(store.latestDeliveryAtMs, 0);
  assert.deepEqual(Object.keys(store.captureSelection()).sort(), ['selectionVersion', 'sessionId']);
  const list = store.list(); list[0].title = 'changed'; list.push(session('foreign'));
  const selected = store.getSelection(); selected.sessionId = 'changed';
  const state = store.getState(); state.entries.length = 0;
  const root = store.getSession(ROOT.sessionId); root.cwd = '/changed';
  assert.deepEqual(store.list(), [ROOT]);
  assert.equal(store.getSelection().sessionId, ROOT.sessionId);
  assert.equal(store.getSession('missing'), undefined);
});

test('a successful new report selects its source, refreshes metadata, and deduplicates sources', (t) => {
  const { store, advance } = fixture(t);
  const a = session('a');
  const first = store.recordDelivery(a, receipt('a1', advance()));
  assert.equal(first.updated, true); assert.equal(first.selected, true);
  assert.equal(first.reason, 'delivery');
  assert.deepEqual(first.session, a);
  assert.deepEqual(first.selectionSnapshot, store.captureSelection());
  assert.equal(store.getSelection().reason, 'delivery');
  store.recordDelivery(session('b'), receipt('b1', advance()));
  store.recordDelivery({ ...a, title: '新标题' }, receipt('a2', advance()));
  assert.deepEqual(store.list().map((item) => item.sessionId), ['chat_a', 'chat_b', 'root']);
  assert.equal(store.getSession(a.sessionId).title, '新标题');
  assert.equal(store.latestDeliveryAtMs, 100003);
});

test('manual selection remains stable until an actual later new report and promotes the target', (t) => {
  const { store, advance } = fixture(t);
  store.recordDelivery(session('a'), receipt('a', advance()));
  store.recordDelivery(session('b'), receipt('b', advance()));
  const before = store.captureSelection();
  const manual = store.selectSession('chat_a');
  assert.equal(manual.selected, true);
  assert.deepEqual(manual.session, session('a'));
  assert.notEqual(manual.selectionSnapshot.selectionVersion, before.selectionVersion);
  assert.equal(store.getSelection().reason, 'manual');
  assert.equal(store.list()[0].sessionId, 'chat_a');
  assert.equal(store.getSelection().sessionId, 'chat_a');
  store.recordDelivery(session('c'), receipt('c', advance()));
  assert.equal(store.getSelection().sessionId, 'chat_c');
});

test('choosing the already selected chat still invalidates an in-flight selection snapshot', (t) => {
  const { store, advance } = fixture(t);
  const expectedSelection = store.captureSelection();
  store.selectSession(ROOT.sessionId);
  const selected = store.captureSelection();
  const result = store.recordDelivery(session('a'), receipt('a', advance(), { expectedSelection }));
  assert.equal(result.updated, true); assert.equal(result.selected, false);
  assert.equal(result.reason, 'selection_changed');
  assert.deepEqual(store.captureSelection(), selected);
  assert.equal(store.list()[0].sessionId, 'chat_a');
});

test('late delivery keeps a newer manual selection while making its source available', (t) => {
  const { store, advance } = fixture(t);
  store.recordDelivery(session('a'), receipt('a', advance()));
  const expectedSelection = store.captureSelection();
  store.selectSession(ROOT.sessionId);
  const manual = store.getSelection();
  const result = store.recordDelivery(session('b'), receipt('b', advance(), { expectedSelection }));
  assert.equal(result.selected, false); assert.equal(result.updated, true);
  assert.deepEqual(store.getSelection(), manual);
  assert.deepEqual(store.getSession('chat_b'), session('b'));
});

test('matching expected selection selects the delivered source', (t) => {
  const { store, advance } = fixture(t);
  const expectedSelection = store.captureSelection();
  const result = store.recordDelivery(session('a'), receipt('a', advance(), { expectedSelection }));
  assert.equal(result.selected, true);
  assert.equal(store.captureSelection().sessionId, 'chat_a');
});

test('2000 different sources retain only ten entries and bounded state with a valid target at every commit', (t) => {
  const { store, path, directory, advance } = fixture(t);
  for (let i = 0; i < 2000; i++) {
    store.recordDelivery(session(i), receipt(i, advance()));
    const state = persisted(path);
    assert.ok(state.entries.length <= 10);
    assert.ok(state.entries.some((entry) => entry.sessionId === state.selection.sessionId));
    assert.ok(lstatSync(path).size < 65536);
  }
  assert.deepEqual(store.list().map((item) => item.sessionId), Array.from({ length: 10 }, (_, i) => `chat_${1999 - i}`));
  assert.equal(store.getSelection().sessionId, 'chat_1999');
  assert.deepEqual(readdirSync(directory), ['recent-chats.json']);
  assert.equal(store.getSession(ROOT.sessionId), undefined);
});

test('repeated late callbacks cannot evict a manually chosen target when the list fills', (t) => {
  const { store, advance } = fixture(t);
  const expectedSelection = store.captureSelection();
  store.selectKnownSession(session('manual'));
  const manual = store.getSelection();
  for (let i = 0; i < 30; i++) store.recordDelivery(session(i), receipt(i, advance(), { expectedSelection }));
  assert.equal(store.list().length, 10);
  assert.deepEqual(store.getSelection(), manual);
  assert.deepEqual(store.getSession('chat_manual'), session('manual'));
  assert.equal(store.list()[0].sessionId, 'chat_29');
});

test('duplicate event receipts are no-ops after manual selection, including a per-source older event', (t) => {
  const { store, path, advance } = fixture(t);
  store.recordDelivery(session('a'), receipt('a', advance()));
  store.recordDelivery(session('b'), receipt('b', advance()));
  store.selectSession(ROOT.sessionId);
  const before = readFileSync(path, 'utf8');
  for (const id of ['a', 'b']) {
    const duplicate = store.recordDelivery(session(id), receipt(id, advance()));
    assert.equal(duplicate.updated, false); assert.equal(duplicate.selected, false);
    assert.equal(duplicate.reason, 'duplicate_delivery');
  }
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('historical and non-newer recovered receipts do not override manual selection or write state', (t) => {
  const { store, path, advance } = fixture(t);
  const at = advance(10);
  store.recordDelivery(session('a'), receipt('a', at));
  store.selectSession(ROOT.sessionId);
  const before = readFileSync(path, 'utf8');
  assert.equal(store.recordDelivery(session('old'), receipt('old', store.activatedAtMs - 1, { newlySent: false })).reason, 'historical_delivery');
  assert.equal(store.recordDelivery(session('equal'), receipt('equal', at, { newlySent: false })).reason, 'stale_delivery');
  assert.equal(store.recordDelivery(session('older'), receipt('older', at - 1, { newlySent: false })).reason, 'stale_delivery');
  assert.equal(store.recordDelivery(session('old_new_flag'), receipt('old_new_flag', at - 1, { newlySent: true })).reason, 'stale_delivery');
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a later recovered receipt is applied once and high-water time survives restart', (t) => {
  const { store, directory, clock, advance } = fixture(t);
  store.recordDelivery(session('a'), receipt('a', advance()));
  const at = advance();
  assert.equal(store.recordDelivery(session('b'), receipt('b', at, { newlySent: false })).selected, true);
  store.selectSession(ROOT.sessionId);
  const selection = store.captureSelection();
  const restarted = new RecentChats({ directory, clock, initialSession: session('unused') });
  assert.equal(restarted.latestDeliveryAtMs, at);
  assert.equal(restarted.recordDelivery(session('b'), receipt('b', at, { newlySent: false })).updated, false);
  assert.deepEqual(restarted.captureSelection(), selection);
  assert.equal(restarted.recordDelivery(session('a'), receipt('earlier', at - 1, { newlySent: false })).updated, false);
});

test('recovered events evicted from bounded per-source deduplication still fail the delivery high-water check', (t) => {
  const { store, advance } = fixture(t);
  const old = receipt('old', advance());
  store.recordDelivery(session('old'), old);
  for (let i = 0; i < 15; i++) store.recordDelivery(session(i), receipt(i, advance()));
  store.selectSession('chat_10');
  const selection = store.captureSelection();
  assert.equal(store.recordDelivery(session('old'), { ...old, newlySent: false }).updated, false);
  assert.equal(store.getSession('chat_old'), undefined);
  assert.deepEqual(store.captureSelection(), selection);
});

test('a recovered ack newer than high-water but older than a persisted owner choice only adds its source', (t) => {
  for (const choice of ['manual', 'created']) {
    const { store, directory, clock, advance } = fixture(t);
    store.recordDelivery(session('a'), receipt('a', advance()));
    const deliveredAtMs = advance();
    advance();
    if (choice === 'manual') store.selectSession(ROOT.sessionId);
    else store.selectKnownSession(session('created'));
    const ownerSelection = store.getSelection();
    const restarted = new RecentChats({ directory, initialSession: ROOT, clock });
    const result = restarted.recordDelivery(session('late'), receipt('late', deliveredAtMs, { newlySent: false }));
    assert.equal(result.updated, true); assert.equal(result.selected, false);
    assert.equal(result.reason, 'selection_changed');
    assert.equal(restarted.list()[0].sessionId, 'chat_late');
    assert.equal(restarted.latestDeliveryAtMs, deliveredAtMs);
    assert.deepEqual(restarted.getSelection(), ownerSelection);
    assert.equal(restarted.recordDelivery(session('later'), receipt('later', advance(), { newlySent: false })).selected, true);
  }
});

test('a truly new send may have equal receipt milliseconds while a replay cannot', (t) => {
  const { store, advance } = fixture(t);
  const at = advance();
  store.recordDelivery(session('a'), receipt('a', at));
  store.selectSession(ROOT.sessionId);
  assert.equal(store.recordDelivery(session('b'), receipt('b', at)).selected, true);
  assert.equal(store.latestDeliveryAtMs, at);
});

test('restarts recover the exact bounded list, selected target, selection version and activation', (t) => {
  const { store, directory, clock, advance } = fixture(t);
  for (let i = 0; i < 12; i++) store.recordDelivery(session(i), receipt(i, advance()));
  store.selectSession('chat_7');
  const before = store.getState();
  advance(100);
  const restarted = new RecentChats({ directory, initialSession: ROOT, clock });
  assert.deepEqual(restarted.getState(), before);
});

test('first activation seeds the latest ten distinct successful sources and ignores hints on restart', (t) => {
  const seeds = Array.from({ length: 25 }, (_, i) => ({ session: session(i), ...receipt(i, 90000 + i) }));
  seeds.push({ session: { ...session(2), title: '最新同源标题' }, ...receipt('2latest', 95000) });
  const { store, directory, clock, path } = fixture(t, { seedDeliveries: seeds.reverse() });
  assert.equal(store.activatedAtMs, 100000);
  assert.equal(store.latestDeliveryAtMs, 95000);
  assert.equal(store.list().length, 10);
  assert.equal(store.getSelection().sessionId, 'chat_2');
  assert.equal(store.getSelection().reason, 'seed');
  assert.equal(store.getSession('chat_2').title, '最新同源标题');
  assert.deepEqual(Object.keys(store.list()[0]).sort(), ['cwd', 'sessionId', 'title']);
  assert.equal(readFileSync(path, 'utf8').includes('testCommandTag'), false);
  assert.equal(readFileSync(path, 'utf8').includes('body'), false);
  store.selectSession('chat_20');
  const before = store.getState();
  const restarted = new RecentChats({ directory, initialSession: session('newroot'), seedDeliveries: [{ invalid: 'ignored after first activation' }], clock });
  assert.deepEqual(restarted.getState(), before);
});

test('a pre-activation receipt absent from the ten seeds cannot re-enter after restart', (t) => {
  const { store, directory, clock } = fixture(t, { seedDeliveries: [{ session: session('seed'), ...receipt('seed', 99900) }] });
  const selection = store.captureSelection();
  const restarted = new RecentChats({ directory, initialSession: ROOT, clock });
  assert.equal(restarted.recordDelivery(session('old'), receipt('old', 99999, { newlySent: false })).updated, false);
  assert.deepEqual(restarted.captureSelection(), selection);
});

test('manual and verified-creation choices with stale snapshots do not add targets or write state', (t) => {
  const { store, path } = fixture(t);
  const stale = store.captureSelection();
  store.selectKnownSession(session('manual'));
  const before = readFileSync(path, 'utf8');
  assert.equal(store.selectSession(ROOT.sessionId, { expectedSelection: stale }).selected, false);
  assert.equal(store.selectKnownSession(session('new'), { expectedSelection: stale }).selected, false);
  assert.equal(store.getSession('chat_new'), undefined);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.throws(() => store.selectSession('missing'), /session_not_recent/);
  const created = store.selectKnownSession(session('new'), { expectedSelection: store.captureSelection() });
  assert.equal(created.selected, true);
  assert.equal(store.list()[0].sessionId, 'chat_new');
  assert.equal(store.getSelection().reason, 'created');
});

test('a late verified creation stays discoverable after the owner changes selection without changing the selection or receipts', (t) => {
  const { store, directory, clock, advance } = fixture(t);
  store.recordDelivery(session('report'), receipt('report', advance()));
  const creationSnapshot = store.captureSelection();
  advance(); store.selectSession(ROOT.sessionId);
  const before = store.getState();
  const created = session('created');
  const result = store.rememberKnownSession(created);
  assert.equal(result.updated, true);
  assert.deepEqual(result.session, created);
  assert.deepEqual(result.selectionSnapshot, store.captureSelection());
  assert.deepEqual(store.getSelection(), before.selection);
  assert.deepEqual(store.getState().latestDelivery, before.latestDelivery);
  assert.equal(store.latestDeliveryAtMs, before.deliveryHighWaterAtMs);
  assert.deepEqual(store.getState().entries.find((entry) => entry.sessionId === 'chat_report'), before.entries[1]);
  assert.deepEqual(store.list()[0], created);
  assert.equal(store.getState().entries[0].latestDelivery, null);
  assert.equal(store.selectKnownSession(created, { expectedSelection: creationSnapshot }).selected, false);
  assert.deepEqual(store.getSession(created.sessionId), created);
  const restarted = new RecentChats({ directory, initialSession: ROOT, clock });
  assert.deepEqual(restarted.getState(), store.getState());
  assert.deepEqual(restarted.getSelection(), before.selection);
});

test('replayed creation results neither replace fresh UI metadata nor promote an existing target or write state', (t) => {
  const { store, directory, clock, path, advance } = fixture(t);
  const fresh = { ...session('a'), title: '实际 UI 新标题' };
  store.recordDelivery(fresh, receipt('a', advance()));
  store.recordDelivery(session('b'), receipt('b', advance()));
  const before = readFileSync(path, 'utf8');
  const state = store.getState();
  const replay = store.rememberKnownSession({ ...session('a'), cwd: '/old/catalog' });
  assert.equal(replay.updated, false);
  assert.deepEqual(replay.session, fresh);
  assert.deepEqual(replay.selectionSnapshot, store.captureSelection());
  assert.deepEqual(store.getState(), state);
  assert.equal(readFileSync(path, 'utf8'), before);
  const restarted = new RecentChats({ directory, initialSession: ROOT, clock });
  assert.equal(restarted.rememberKnownSession(session('a')).updated, false);
  assert.deepEqual(restarted.getState(), state);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('twenty late verified creations retain only ten targets and cannot evict a manual choice or alter delivery state', (t) => {
  const { store, path, advance } = fixture(t);
  store.recordDelivery(session('report'), receipt('report', advance()));
  store.selectKnownSession(session('manual'));
  advance(); store.selectSession('chat_manual');
  const before = store.getState();
  for (let i = 0; i < 20; i++) {
    const result = store.rememberKnownSession(session(`created_${i}`));
    assert.equal(result.updated, true);
    const state = persisted(path);
    assert.ok(state.entries.length <= 10);
    assert.deepEqual(state.selection, before.selection);
    assert.deepEqual(state.latestDelivery, before.latestDelivery);
    assert.equal(state.deliveryHighWaterAtMs, before.deliveryHighWaterAtMs);
    assert.ok(state.entries.some((entry) => entry.sessionId === 'chat_manual'));
  }
  assert.equal(store.list().length, 10);
  assert.deepEqual(store.list()[0], session('created_19'));
  assert.deepEqual(store.getSession('chat_manual'), session('manual'));
  assert.equal(store.getSession('chat_created_0'), undefined);
  assert.ok(lstatSync(path).size < 65536);
});

test('remembering a verified creation enforces the same three-field routing contract without writing invalid data', (t) => {
  const { store, path } = fixture(t);
  const before = readFileSync(path, 'utf8');
  for (const invalid of [{ ...session('a'), testCommandTag: 'allow' }, { ...ROOT, title: '' }, { ...session('a'), cwd: 'relative' }]) {
    assert.throws(() => store.rememberKnownSession(invalid), /invalid_session/);
  }
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a smaller configured cap also keeps selection and entries in the same state', (t) => {
  const { store } = fixture(t, { limit: 2 });
  store.selectKnownSession(session('a'));
  store.selectKnownSession(session('b'));
  assert.deepEqual(store.list(), [session('b'), session('a')]);
  assert.equal(store.getSelection().sessionId, 'chat_b');
});

test('directory and file permissions and symlinks fail closed without repairing or replacing them', (t) => {
  const { directory, path, store, clock } = fixture(t);
  chmodSync(directory, 0o750);
  assert.throws(() => new RecentChats({ directory, initialSession: ROOT, clock }), /mode_700/);
  assert.throws(() => store.selectSession(ROOT.sessionId), /mode_700/);
  chmodSync(directory, 0o700);
  chmodSync(path, 0o640);
  assert.throws(() => new RecentChats({ directory, initialSession: ROOT, clock }), /mode_600/);
  assert.throws(() => store.selectSession(ROOT.sessionId), /mode_600/);
  chmodSync(path, 0o600);
  const original = readFileSync(path, 'utf8');
  unlinkSync(path); symlinkSync(join(directory, 'missing.json'), path);
  assert.throws(() => new RecentChats({ directory, initialSession: ROOT, clock }), /mode_600/);
  assert.throws(() => store.selectSession(ROOT.sessionId), /mode_600/);
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  unlinkSync(path); writeFileSync(path, original, { mode: 0o600 });
  const alias = join(directory, 'alias'); symlinkSync(directory, alias);
  assert.throws(() => new RecentChats({ directory: alias, initialSession: ROOT, clock }), /mode_700/);
});

test('an oversized or malformed state fails closed, preserving the unusable file for diagnosis', (t) => {
  const { directory, path, clock } = fixture(t);
  for (const bad of ['{', 'null', '[]', `${' '.repeat(65536)}{}`]) {
    writeFileSync(path, bad);
    assert.throws(() => new RecentChats({ directory, initialSession: ROOT, clock }));
    assert.equal(readFileSync(path, 'utf8'), bad);
  }
});

test('unknown fields, missing selections, oversized entries and inconsistent receipts are rejected on restart', (t) => {
  const { directory, path, store, clock, advance } = fixture(t);
  store.recordDelivery(session('a'), receipt('a', advance()));
  const valid = store.getState();
  const mutations = [
    (state) => { state.unexpected = true; },
    (state) => { state.version = 2; },
    (state) => { state.selection.sessionId = 'missing'; },
    (state) => { state.selection.selectionVersion = 'invalid'; },
    (state) => { state.selection.reason = 'approval'; },
    (state) => { state.entries[0].testCommandTag = 'allow'; },
    (state) => { state.entries[0].title = 'x'.repeat(161); },
    (state) => { state.entries[0].cwd = 'relative'; },
    (state) => { state.entries[0].latestDelivery.body = 'private message'; },
    (state) => { state.latestDelivery.messageId = 'different'; },
    (state) => { state.entries = Array.from({ length: 11 }, (_, i) => ({ ...session(i), latestDelivery: null })); state.selection.sessionId = 'chat_0'; },
    (state) => { state.entries.push(structuredClone(state.entries[0])); },
    (state) => { state.deliveryHighWaterAtMs = 0; },
    (state) => { state.activatedAtMs = 200000; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(valid); mutate(invalid);
    writeFileSync(path, JSON.stringify(invalid));
    assert.throws(() => new RecentChats({ directory, initialSession: ROOT, clock }));
    assert.deepEqual(persisted(path), invalid);
  }
});

test('unexpected state changes fail closed during a write and never mutate the in-memory choice', (t) => {
  const { store, path } = fixture(t);
  const before = store.getState();
  const invalid = { ...before, foreign: true };
  writeFileSync(path, JSON.stringify(invalid));
  assert.throws(() => store.selectKnownSession(session('a')), /invalid_state/);
  assert.deepEqual(store.getState(), before);
  assert.deepEqual(persisted(path), invalid);
});

test('invalid input cannot persist approval tags, arbitrary content, bad timestamps or malformed snapshots', (t) => {
  const { store, path, advance } = fixture(t);
  const before = readFileSync(path, 'utf8');
  assert.throws(() => store.selectKnownSession({ ...session('a'), testCommandTag: 'allow' }), /invalid_session/);
  assert.throws(() => store.selectKnownSession({ ...session('a'), body: 'private message' }), /invalid_session/);
  assert.throws(() => store.recordDelivery(session('a'), receipt('a', 0)), /invalid_receipt/);
  assert.throws(() => store.recordDelivery(session('a'), receipt('a', advance(), { newlySent: 'yes' })), /invalid_receipt/);
  assert.throws(() => store.selectSession(ROOT.sessionId, { expectedSelection: {} }), /invalid_selection_snapshot/);
  assert.throws(() => store.recordDelivery(session('a'), receipt('a', advance(), { expectedSelection: null })), /invalid_selection_snapshot/);
  assert.equal(readFileSync(path, 'utf8'), before);
});
