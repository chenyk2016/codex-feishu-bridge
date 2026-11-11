/** Offline history bootstrap checks: no Feishu calls, metadata database, or private runtime state. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writePrivateJson } from './probe-core.mjs';
import { collectRecentSeeds } from './recent-seed.mjs';

const base = Date.now() - 300000;
const body = 'fixture body must never reach a seed or a log';
const eventId = (key) => createHash('sha256').update(String(key)).digest('hex');
const metadata = (sessionId) => ({ sessionId, title: `标题 ${sessionId}`, cwd: '/private/fixture' });

function sandbox() {
  const outbox = mkdtempSync(join(tmpdir(), 'feishu-recent-seed-'));
  mkdirSync(join(outbox, '.relay-state', 'reports'), { recursive: true, mode: 0o700 });
  return outbox;
}

function delivery(outbox, key, { sessionId = `chat_${key}`, sentAtMs = base, report = {}, ack = {}, fileId = eventId(key) } = {}) {
  const value = { version: 1, kind: 'codex_turn_report', eventId: fileId, sessionId, turnId: `turn_${key}`,
    createdAtMs: base - 1000, lastAssistantMessage: body, truncated: false, ...report };
  const state = { version: 1, eventId: fileId, sessionId, status: 'sent', attempts: 1,
    messageId: `om_${key}`, sentAtMs, ...ack };
  const reportPath = join(outbox, `${fileId}.json`);
  const ackPath = join(outbox, '.relay-state', 'reports', `${fileId}.json`);
  writePrivateJson(reportPath, value); writePrivateJson(ackPath, state);
  return { report: value, ack: state, reportPath, ackPath };
}

/** Include contents, names and modes so an accidental rewrite, chmod or deletion is detectable. */
function snapshot(directory) {
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name); const stat = lstatSync(path);
    return [name, stat.mode & 0o777, stat.isDirectory() ? snapshot(path) : readFileSync(path, 'utf8')];
  });
}

test('latest ten come from more than 1000 receipts by actual sent time, with only ten metadata lookups and no writes', () => {
  const outbox = sandbox();
  try {
    for (let index = 0; index < 1043; index++) delivery(outbox, index, { sentAtMs: base + index });
    // The filesystem's apparent newest record deliberately belongs outside the recent ten.
    const old = join(outbox, '.relay-state', 'reports', `${eventId(0)}.json`);
    utimesSync(old, new Date(), new Date());
    const before = snapshot(outbox); const lookedUp = [];
    const seeds = collectRecentSeeds({ outbox, sessionLookup: (id, report) => {
      lookedUp.push(id); assert.equal(report.sessionId, id); assert.equal(report.lastAssistantMessage, body);
      return { ...metadata(id), reportOnly: true, approvalTag: 'must_not_copy', harmlessTest: 'allow' };
    } });
    assert.deepEqual(seeds.map((seed) => seed.session.sessionId), Array.from({ length: 10 }, (_, index) => `chat_${1042 - index}`));
    assert.equal(lookedUp.length, 10);
    assert.deepEqual(seeds.map((seed) => seed.deliveredAtMs), Array.from({ length: 10 }, (_, index) => base + 1042 - index));
    assert.deepEqual(seeds[0], { session: metadata('chat_1042'), eventId: eventId(1042), messageId: 'om_1042', deliveredAtMs: base + 1042 });
    assert.equal(JSON.stringify(seeds).includes(body), false);
    assert.equal(JSON.stringify(seeds).includes('must_not_copy'), false);
    assert.deepEqual(snapshot(outbox), before);
  } finally { rmSync(outbox, { recursive: true, force: true }); }
});

test('distinct sessions use their newest successful receipt rather than creation time or last directory entry', () => {
  const outbox = sandbox();
  try {
    delivery(outbox, 'first', { sessionId: 'same_chat', sentAtMs: base + 10, report: { createdAtMs: base + 9 } });
    delivery(outbox, 'newest', { sessionId: 'same_chat', sentAtMs: base + 50, report: { createdAtMs: base - 50000 } });
    delivery(outbox, 'other', { sessionId: 'other_chat', sentAtMs: base + 40 });
    delivery(outbox, 'late_failed', { sessionId: 'same_chat', sentAtMs: base + 100, ack: { status: 'unknown' } });
    const seeds = collectRecentSeeds({ outbox, sessionLookup: metadata });
    assert.deepEqual(seeds.map((seed) => seed.session.sessionId), ['same_chat', 'other_chat']);
    assert.equal(seeds[0].eventId, eventId('newest'));
    assert.equal(seeds[0].deliveredAtMs, base + 50);
  } finally { rmSync(outbox, { recursive: true, force: true }); }
});

test('archived sources never become first-start reply targets and active sources fill their places', () => {
  const outbox = sandbox();
  try {
    delivery(outbox, 'archived', { sentAtMs: base + 30 }); delivery(outbox, 'active', { sentAtMs: base + 20 });
    const seeds = collectRecentSeeds({ outbox, sessionLookup: id => ({ ...metadata(id), isArchived: id === 'chat_archived' }) });
    assert.deepEqual(seeds.map(seed => seed.session.sessionId), ['chat_active']);
  } finally { rmSync(outbox, { recursive: true, force: true }); }
});

test('a corrupt newest report does not hide a valid older receipt from the same session', () => {
  const outbox = sandbox();
  try {
    delivery(outbox, 'older', { sessionId: 'same_chat', sentAtMs: base + 10 });
    delivery(outbox, 'corrupt', { sessionId: 'same_chat', sentAtMs: base + 20, report: { unexpected: true } });
    const seeds = collectRecentSeeds({ outbox, sessionLookup: metadata });
    assert.equal(seeds.length, 1); assert.equal(seeds[0].eventId, eventId('older'));
  } finally { rmSync(outbox, { recursive: true, force: true }); }
});

test('non-sent, malformed, mismatched and future receipts never reach metadata lookup', () => {
  const outbox = sandbox();
  try {
    const invalid = [
      { ack: { status: 'pending' } }, { ack: { status: 'sending' } }, { ack: { status: 'failed' } },
      { ack: { status: 'rejected' } }, { ack: { status: 'unknown' } }, { ack: { status: 'retry_wait' } },
      { ack: { status: 'sent ' } }, { ack: { status: true } }, { ack: { version: 2 } },
      { ack: { eventId: 'f'.repeat(64) } }, { ack: { sessionId: 'different_chat' } },
      { ack: { sessionId: '../bad' } }, { ack: { sessionId: 42 } },
      { ack: { messageId: '' } }, { ack: { messageId: 7 } }, { ack: { messageId: 'om_a\nsecret' } },
      { ack: { messageId: 'om_' + 'a'.repeat(254) } }, { ack: { messageId: 'not_a_message_id' } },
      { ack: { sentAtMs: 0 } }, { ack: { sentAtMs: -1 } }, { ack: { sentAtMs: String(base) } },
      { ack: { sentAtMs: base + 0.5 } }, { ack: { sentAtMs: Number.MAX_SAFE_INTEGER + 1 } },
      { ack: { sentAtMs: Date.now() + 40000 } }, { report: { createdAtMs: base + 1 } },
      { report: { eventId: 'e'.repeat(64) } }, { report: { sessionId: 'another_chat' } },
      { report: { turnId: '../invalid' } }, { report: { createdAtMs: Date.now() + 40000 } },
      { report: { lastAssistantMessage: '' } }, { report: { lastAssistantMessage: '字'.repeat(4001) } },
      { report: { truncated: 'false' } }, { report: { unrelated: true } },
    ];
    invalid.forEach((changes, index) => delivery(outbox, `invalid_${index}`, changes));
    // Non-event names are ignored without opening their contents.
    writePrivateJson(join(outbox, '.relay-state', 'reports', 'not_an_event.json'), { status: 'sent' });
    const malformed = delivery(outbox, 'malformed_json');
    writeFileSync(malformed.ackPath, '{"status":', { mode: 0o600 });
    let lookups = 0; const logs = [];
    assert.deepEqual(collectRecentSeeds({ outbox, sessionLookup: () => { lookups++; return metadata('ignored'); }, log: (...args) => logs.push(args) }), []);
    assert.equal(lookups, 0); assert.ok(logs.length > 0);
    assert.equal(logs.flat().every((value) => value === 'recent_seed_record_rejected'), true);
    assert.equal(JSON.stringify(logs).includes(body), false);
  } finally { rmSync(outbox, { recursive: true, force: true }); }
});

test('explicitly unknown metadata skips candidates and fills the requested limit without copying approval fields', () => {
  const outbox = sandbox();
  try {
    for (let index = 0; index < 9; index++) delivery(outbox, index, { sentAtMs: base + index });
    const lookedUp = []; const logs = [];
    const seeds = collectRecentSeeds({ outbox, limit: 2, sessionLookup: (id) => {
      lookedUp.push(id);
      if (Number(id.slice(5)) >= 4) return undefined;
      return { ...metadata(id), approvalTags: ['allow'], arbitraryBody: body };
    }, log: (...args) => logs.push(args) });
    assert.deepEqual(seeds.map((seed) => seed.session.sessionId), ['chat_3', 'chat_2']);
    assert.deepEqual(lookedUp, ['chat_8', 'chat_7', 'chat_6', 'chat_5', 'chat_4', 'chat_3', 'chat_2']);
    assert.deepEqual(seeds[0].session, metadata('chat_3'));
    assert.equal(logs.length, 5);
    assert.equal(logs.flat().every((value) => value === 'recent_seed_session_unavailable'), true);
    assert.equal(JSON.stringify(logs).includes(body), false);
    assert.equal(JSON.stringify(seeds).includes('approval'), false);
  } finally { rmSync(outbox, { recursive: true, force: true }); }
});

test('unavailable or corrupt metadata aborts bootstrap instead of choosing an older chat', () => {
  const outbox = sandbox();
  try {
    delivery(outbox, 'older', { sentAtMs: base + 10 });
    delivery(outbox, 'latest', { sentAtMs: base + 20 });
    const before = snapshot(outbox);
    const invalidMetadata = [
      () => { throw new Error(body); },
      (id) => ({ ...metadata(id), sessionId: 'wrong' }),
      (id) => ({ ...metadata(id), cwd: 'relative/path' }),
      (id) => ({ ...metadata(id), title: '' }),
      () => null,
      () => Promise.resolve(metadata('unawaited')),
    ];
    for (const result of invalidMetadata) {
      const lookedUp = []; const logs = [];
      assert.throws(() => collectRecentSeeds({ outbox, sessionLookup: (id) => {
        lookedUp.push(id); return result(id);
      }, log: (...args) => logs.push(args) }), { message: 'recent_seed_metadata_unavailable' });
      assert.deepEqual(lookedUp, ['chat_latest']);
      assert.deepEqual(logs, [['recent_seed_metadata_unavailable']]);
      assert.equal(JSON.stringify(logs).includes(body), false);
    }
    assert.deepEqual(snapshot(outbox), before);
  } finally { rmSync(outbox, { recursive: true, force: true }); }
});

test('main-chat filtering remains the supplied lookup responsibility', () => {
  const outbox = sandbox();
  try {
    delivery(outbox, 'main', { sessionId: 'main_chat', sentAtMs: base + 10 });
    delivery(outbox, 'agent', { sessionId: 'internal_agent', sentAtMs: base + 20 });
    const seeds = collectRecentSeeds({ outbox, sessionLookup: (id) => id === 'main_chat' ? metadata(id) : undefined });
    assert.deepEqual(seeds.map((seed) => seed.session.sessionId), ['main_chat']);
  } finally { rmSync(outbox, { recursive: true, force: true }); }
});

test('private-file checks reject public, symlinked, oversized and nonregular report or receipt files', () => {
  for (const target of ['reportPath', 'ackPath']) {
    for (const corruption of ['public', 'symlink', 'oversized', 'directory']) {
      const outbox = sandbox();
      try {
        const fixture = delivery(outbox, `${target}_${corruption}`); const path = fixture[target];
        if (corruption === 'public') chmodSync(path, 0o644);
        if (corruption === 'symlink') {
          const other = join(outbox, `private-${target}.json`);
          writeFileSync(other, readFileSync(path), { mode: 0o600 }); rmSync(path); symlinkSync(other, path);
        }
        if (corruption === 'oversized') writeFileSync(path, ' '.repeat(65537), { mode: 0o600 });
        if (corruption === 'directory') { rmSync(path); mkdirSync(path, { mode: 0o700 }); }
        let lookedUp = false;
        assert.deepEqual(collectRecentSeeds({ outbox, sessionLookup: () => { lookedUp = true; return metadata('ignored'); } }), [], `${target} ${corruption}`);
        assert.equal(lookedUp, false);
      } finally { rmSync(outbox, { recursive: true, force: true }); }
    }
  }
});

test('unsafe private directories stop bootstrap without repairing permissions or following symlinks', () => {
  for (const suffix of ['', '.relay-state', '.relay-state/reports']) {
    for (const corruption of ['public', 'symlink']) {
      const outbox = sandbox();
      try {
        delivery(outbox, 'private'); const path = suffix ? join(outbox, suffix) : outbox;
        let other;
        if (corruption === 'public') chmodSync(path, 0o755);
        else {
          other = mkdtempSync(join(tmpdir(), 'feishu-recent-seed-target-'));
          rmSync(path, { recursive: true }); symlinkSync(other, path);
        }
        assert.throws(() => collectRecentSeeds({ outbox, sessionLookup: metadata }), /recent_seed_requires_owned_mode_700_directories/);
        if (corruption === 'public') assert.equal(lstatSync(path).mode & 0o777, 0o755);
        else { assert.equal(lstatSync(path).isSymbolicLink(), true); rmSync(other, { recursive: true, force: true }); }
      } finally { rmSync(outbox, { recursive: true, force: true }); }
    }
  }
});

test('missing history is empty and option errors never create directories', () => {
  const outbox = sandbox();
  try {
    rmSync(join(outbox, '.relay-state'), { recursive: true });
    assert.deepEqual(collectRecentSeeds({ outbox, sessionLookup: metadata }), []);
    assert.deepEqual(readdirSync(outbox), []);
    assert.deepEqual(collectRecentSeeds({ outbox: join(outbox, 'missing'), sessionLookup: metadata }), []);
    for (const options of [{ outbox: 'relative' }, { sessionLookup: undefined }, { limit: 0 }, { limit: 11 }, { limit: 1.5 }, { log: null }]) {
      assert.throws(() => collectRecentSeeds({ outbox, sessionLookup: metadata, ...options }), /recent_seed_invalid_options/);
    }
    assert.deepEqual(readdirSync(outbox), []);
  } finally { rmSync(outbox, { recursive: true, force: true }); }
});
