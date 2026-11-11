/** Offline tests for identity, one-shot decisions, and secret-file boundaries. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as lark from '@larksuiteoapi/node-sdk';
import { consumeDecision, loadConfig, readPrivateJson, testCard, writePrivateJson } from './probe-core.mjs';

/** Make an independently readable synthetic request fixture. */
function fixture() {
  return { runId: 'test-run', owner: { openId: 'ou_owner', chatId: 'oc_private' }, requests: {
    request1: { runId: 'test-run', status: 'pending', expiresAt: 2000 },
  } };
}

/** Make a synthetic platform callback; it never reaches a Feishu network. */
function click(actor = 'ou_owner', decision = 'approve') {
  return { operator: { open_id: actor }, context: { open_chat_id: 'oc_private' }, action: {
    value: { probe: 'feishu-only', request_id: 'request1', decision },
  } };
}

test('reject unauthorized clicks without consuming an owner request', () => {
  const state = fixture();
  assert.deepEqual(consumeDecision(state, click('ou_other'), 1000), { ok: false, reason: 'unauthorized' });
  assert.equal(state.requests.request1.status, 'pending');
  const wrongChat = click(); wrongChat.context.open_chat_id = 'oc_elsewhere';
  assert.equal(consumeDecision(state, wrongChat, 1000).reason, 'unauthorized');
});

test('accept once, then reject duplicate, expired, invalid and previous-run decisions', () => {
  const state = fixture();
  assert.equal(consumeDecision(state, click(), 1000).decision, 'approve');
  assert.equal(consumeDecision(state, click('ou_owner', 'deny'), 1001).reason, 'already_processed');
  assert.equal(consumeDecision(fixture(), click(), 2000).reason, 'expired');
  const old = fixture(); old.requests.request1.runId = 'old-run';
  assert.equal(consumeDecision(old, click(), 1000).reason, 'expired');
  assert.equal(consumeDecision(fixture(), click('ou_owner', 'execute'), 1000).reason, 'invalid_action');
});

test('private JSON requires mode 600 and rejects symlinks and partial environment credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-probe-test-'));
  try {
    const path = join(dir, 'test.credentials.json');
    const value = { app_id: 'cli_0000000000000000', app_secret: 'synthetic-fixture-only' };
    writePrivateJson(path, value);
    assert.deepEqual(readPrivateJson(path), value);
    assert.equal(loadConfig({}, path).appId, value.app_id);
    assert.throws(() => loadConfig({ FEISHU_APP_ID: value.app_id }, path), /app_secret_required/);
    chmodSync(path, 0o644);
    assert.throws(() => readPrivateJson(path), /mode_600/);
    chmodSync(path, 0o600);
    const link = join(dir, 'link.json'); symlinkSync(path, link);
    assert.throws(() => readPrivateJson(link));
    assert.throws(() => writePrivateJson(link, {}), /state_symlink_rejected/);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), value);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real SDK dispatcher routes a synthetic V2 card callback and preserves a raw-card response', async () => {
  const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const state = fixture();
  const dispatcher = new lark.EventDispatcher({ logger: quiet }).register({ 'card.action.trigger': (event) => {
    const result = consumeDecision(state, event, 1000);
    assert.equal(result.ok, true);
    return { toast: { type: 'success', content: 'offline fixture' }, card: { type: 'raw', data: testCard(result.requestId, result.decision) } };
  } });
  const response = await dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger', event_id: 'synthetic-event' }, event: click() }, { needCheck: false });
  assert.equal(response.card.type, 'raw');
  assert.equal(response.card.data.schema, '2.0');
  assert.equal(response.card.data.body.elements.length, 1);
  assert.equal(state.requests.request1.status, 'approve');
});
