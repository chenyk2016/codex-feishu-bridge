/** Offline queue tests; fixtures never touch the actual live bridge directory. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BridgeQueue, validateRequest } from './bridge-queue.mjs';
import { readPrivateJson, writePrivateJson, consumeDecision, testCard } from './probe-core.mjs';

/** Make a fixed harmless request bound to the supplied synthetic runtime. */
function requestFor(runtime, now) {
  return { version: 1, requestId: randomUUID(), kind: 'codex_permission', harmlessTest: 'allow', sessionId: 'session_fixture',
    turnId: 'turn_fixture', bridgeRunId: runtime.bridgeRunId, createdAtMs: now, expiresAtMs: now + 600000 };
}

test('queue accepts a controlled request once and writes an immutable matching mode-600 decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-bridge-queue-'));
  try {
    const now = Date.now(); const queue = new BridgeQueue(dir, randomUUID(), now + 1000000);
    const request = requestFor(queue.runtime, now);
    writePrivateJson(join(dir, 'requests', `${request.requestId}.json`), request);
    assert.deepEqual(queue.scan(now).requests, [request]);
    assert.equal(queue.scan(now).requests.length, 0);
    const decision = queue.decide(request.requestId, 'approve', now + 1);
    const path = join(dir, 'decisions', `${request.requestId}.json`);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readPrivateJson(path), { version: 1, requestId: request.requestId, kind: 'codex_permission', harmlessTest: 'allow',
      sessionId: 'session_fixture', turnId: 'turn_fixture', bridgeRunId: queue.runtime.bridgeRunId, decision: 'approve', decidedAtMs: now + 1 });
    assert.throws(() => queue.decide(request.requestId, 'deny', now + 2), { code: 'EEXIST' });
    assert.equal(readPrivateJson(path).decision, decision.decision);
    queue.close();
    assert.ok(readPrivateJson(join(dir, 'runtime.json')).expiresAtMs <= Date.now());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('contract rejects arbitrary text/commands, unknown tags, stale runs and expired or excessive TTL', () => {
  const now = Date.now(); const runtime = { bridgeRunId: randomUUID(), expiresAtMs: now + 1000000 };
  const request = requestFor(runtime, now);
  assert.throws(() => validateRequest({ ...request, command: 'anything' }, request.requestId, runtime, now), /invalid_request_fields/);
  assert.throws(() => validateRequest({ ...request, harmlessTest: 'shell' }, request.requestId, runtime, now), /test_not_allowed/);
  assert.throws(() => validateRequest({ ...request, kind: 'codex_stop' }, request.requestId, runtime, now), /invalid_request_identity/);
  assert.throws(() => validateRequest({ ...request, sessionId: undefined }, request.requestId, runtime, now), /invalid_session/);
  assert.throws(() => validateRequest({ ...request, bridgeRunId: randomUUID() }, request.requestId, runtime, now), /previous_run/);
  assert.throws(() => validateRequest(request, request.requestId, runtime, now + 600001), /expired/);
  assert.throws(() => validateRequest({ ...request, expiresAtMs: now + 600001 }, request.requestId, runtime, now), /invalid_ttl/);
});

test('a changed request or replacement runtime cannot receive a decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-bridge-stale-'));
  try {
    const now = Date.now(); const queue = new BridgeQueue(dir, randomUUID(), now + 1000000);
    const request = requestFor(queue.runtime, now);
    const path = join(dir, 'requests', `${request.requestId}.json`);
    writePrivateJson(path, request); queue.scan(now);
    writePrivateJson(path, { ...request, sessionId: 'changed_session' });
    assert.throws(() => queue.decide(request.requestId, 'approve', now + 1), /request_changed/);
    assert.equal(existsSync(join(dir, 'decisions', `${request.requestId}.json`)), false);
    new BridgeQueue(dir, randomUUID(), now + 1000000);
    assert.throws(() => queue.decide(request.requestId, 'approve', now + 1), /previous_run/);
    assert.throws(() => queue.scan(now), /previous_run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bridge cards use a distinct callback namespace and keep the normal Feishu probe isolated', () => {
  const now = Date.now(); const id = randomUUID();
  const state = { runId: 'run1', owner: { openId: 'ou_owner', chatId: 'oc_private' }, requests: {
    [id]: { runId: 'run1', kind: 'codex_permission', harmlessTest: 'deny', status: 'pending', expiresAt: now + 1000 },
  } };
  const card = testCard(id, undefined, 'deny');
  const value = card.body.elements[1].columns[1].elements[0].behaviors[0].value;
  assert.equal(value.probe, 'codex-harmless-bridge');
  const raw = { operator: { open_id: 'ou_owner' }, context: { open_chat_id: 'oc_private' }, action: { value: { ...value, probe: 'feishu-only' } } };
  assert.equal(consumeDecision(state, raw, now).reason, 'invalid_action');
  raw.action.value = value;
  assert.equal(consumeDecision(state, raw, now).decision, 'deny');
  assert.equal(consumeDecision(state, raw, now).reason, 'already_processed');
});
