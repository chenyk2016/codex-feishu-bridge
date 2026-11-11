/** Independent long-run report regression: old terminal deliveries must not starve new replies. */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';
import { TurnRelay } from './turn-relay.mjs';

/** Build a private synthetic reply without any live account, command or network operation. */
function report(eventId, now) {
  return { version: 1, kind: 'codex_turn_report', eventId, sessionId: 'service_root', turnId: `turn_${eventId.slice(-12)}`,
    createdAtMs: now, lastAssistantMessage: '长期运行回归的合成回复。', truncated: false };
}

test('more than one thousand sent report bodies cannot hide a new reply before or after restart', { timeout: 10000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-service-longrun-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const now = Date.now(), ackDirectory = join(directory, '.relay-state', 'reports');
  for (let i = 0; i < 1001; i++) {
    const eventId = i.toString(16).padStart(64, '0');
    writePrivateJson(join(directory, `${eventId}.json`), report(eventId, now - 1000));
    writePrivateJson(join(ackDirectory, `${eventId}.json`), { version: 1, eventId, sessionId: 'service_root', attempts: 1,
      status: 'sent', messageId: `om_old_${i}`, sentAtMs: now - 500 });
  }
  const freshId = 'f'.repeat(64);
  writePrivateJson(join(directory, `${freshId}.json`), report(freshId, now));
  // This platform's directory order makes the former first-1000 cap observably exclude the fresh file.
  const files = readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(files.length, 1002);
  assert.ok(files.indexOf(`${freshId}.json`) >= 1000);

  const observed = [], options = { outbox: directory, binary: process.execPath, threadId: 'service_root' };
  const send = async (_card, _uuid, value) => { observed.push(value.eventId); return 'om_fresh_once'; };
  const first = new TurnRelay(options);
  for (let tick = 0; tick < 3; tick++) await first.pollReports(send, now + tick);
  assert.deepEqual(observed, [freshId], 'a fresh reply must be delivered without resending historical replies');
  assert.equal(readPrivateJson(join(ackDirectory, `${freshId}.json`)).status, 'sent');
  const restarted = new TurnRelay(options);
  for (let tick = 0; tick < 3; tick++) await restarted.pollReports(send, now + 10 + tick);
  assert.deepEqual(observed, [freshId], 'restarting must retain all old and new success acknowledgements');
});
