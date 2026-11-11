/** Temporary SQLite fixtures only; no real Codex database or conversation is accessed. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createChatMetadataLookup } from './chat-metadata.mjs';

const PYTHON = '/usr/bin/python3';
const HELPER = fileURLToPath(new URL('./chat-metadata.py', import.meta.url));
const SECRET = 'private initial prompt that must never become a chat label';

function python(code, args = [], input = '') {
  const result = spawnSync(PYTHON, ['-I', '-c', code, ...args], { input, encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 0, 'temporary SQLite fixture must be available');
  return result.stdout;
}

function fixture(t, rows = [], { omitTitle = false, broken = false, archiveType = 'INTEGER' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-chat-metadata-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'index ?#.sqlite');
  python(`import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
data=json.load(sys.stdin)
c.execute('CREATE TABLE threads (id TEXT PRIMARY KEY${broken ? '' : ', name TEXT, cwd TEXT, source TEXT, thread_source TEXT, agent_path TEXT, archived ' + archiveType + ' DEFAULT 0'}${!broken && !omitTitle ? ', title TEXT' : ''})')
for row in data:
 keys=list(row)
 c.execute('INSERT INTO threads ('+','.join(keys)+') VALUES ('+','.join('?' for _ in keys)+')',tuple(row[key] for key in keys))
c.commit()
c.close()`, [database], JSON.stringify(rows));
  chmodSync(database, 0o644);
  return database;
}

function row(overrides = {}) {
  return { id: 'chat_12345678', name: '用户改过的名称', cwd: '/workspace/project', source: 'vscode',
    thread_source: 'user', agent_path: null, archived: 0, title: SECRET, ...overrides };
}

function fixedError(action) {
  assert.throws(action, (error) => error instanceof Error && error.message === 'chat_metadata_unavailable' && !error.cause);
}

test('uses only the display name, accepts owned 0644 SQLite and URI-escaped database paths', (t) => {
  const database = fixture(t, [row()]);
  const value = createChatMetadataLookup({ database })('chat_12345678');
  assert.deepEqual(value, { sessionId: 'chat_12345678', title: '用户改过的名称', cwd: '/workspace/project', isMain: true, titleReady: true, isArchived: false });
  assert.equal(JSON.stringify(value).includes(SECRET), false);
});

test('does not require or select the prompt-bearing title column', (t) => {
  const { title, ...record } = row();
  const database = fixture(t, [record], { omitTitle: true });
  assert.equal(createChatMetadataLookup({ database })(record.id).title, record.name);
});

test('blank or missing names use only the explicit ID suffix, and Unicode names are bounded', (t) => {
  const database = fixture(t, [row({ name: ' \n ' }), row({ id: 'missing_name', name: null }),
    row({ id: 'long_name', name: '😀'.repeat(170) })]);
  const lookup = createChatMetadataLookup({ database });
  assert.equal(lookup('chat_12345678').title, '聊天 12345678');
  assert.equal(lookup('missing_name').title, '聊天 ing_name');
  assert.equal(lookup('missing_name').titleReady, false);
  assert.equal(lookup('long_name').titleReady, true);
  assert.equal(lookup('long_name').title, '😀'.repeat(160));
});

test('only known user chat sources without an agent path count as main chats', (t) => {
  const cases = [
    ['desktop', { source: 'vscode' }, true], ['cli', { source: 'cli' }, true], ['exec', { source: 'exec' }, true],
    ['subthread', { thread_source: 'subagent' }, false], ['agent_path', { agent_path: 'worker' }, false],
    ['json_agent', { source: '{"subagent":{"parent_thread_id":"root"}}' }, false],
    ['json_nested', { source: '{"other":{"subagent":"root"}}' }, false],
    ['json_unknown', { source: '{}' }, false], ['malformed', { source: '{broken' }, false],
    ['unknown_source', { source: 'future-source' }, false], ['unknown_thread', { thread_source: 'future-kind' }, false],
    ['handoff', { thread_source: 'chatgpt_handoff' }, true], ['codex', { thread_source: 'codex' }, true],
    ['agent_created', { thread_source: 'agent_created_thread' }, true],
    ['null_source', { source: null }, false], ['null_thread', { thread_source: null }, false],
  ];
  const database = fixture(t, cases.map(([id, fields]) => row({ id, ...fields })));
  const lookup = createChatMetadataLookup({ database });
  for (const [id, , expected] of cases) assert.equal(lookup(id).isMain, expected, id);
});

test('archive state is independent of main identity and the database default is active', (t) => {
  const { archived, ...defaultActive } = row({ id: 'default_active' });
  const database = fixture(t, [defaultActive, row({ id: 'archived_main', archived: 1 }),
    row({ id: 'archived_agent', archived: 1, agent_path: 'worker' })]);
  const lookup = createChatMetadataLookup({ database });
  assert.equal(lookup('default_active').isArchived, false);
  assert.equal(lookup('archived_main').isArchived, true);
  assert.equal(lookup('archived_main').isMain, true);
  assert.equal(lookup('archived_agent').isArchived, true);
  assert.equal(lookup('archived_agent').isMain, false);
});

test('archive and restore changes are reflected by fresh reads of the same lookup', (t) => {
  const database = fixture(t, [row()]);
  const lookup = createChatMetadataLookup({ database });
  assert.equal(lookup('chat_12345678').isArchived, false);
  for (const archived of [1, 0]) {
    python("import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE threads SET archived=? WHERE id=?',(int(sys.argv[2]),'chat_12345678'));c.commit();c.close()", [database, String(archived)]);
    const metadata = lookup('chat_12345678');
    assert.equal(metadata.isArchived, archived === 1);
    assert.equal(metadata.isMain, true);
    assert.equal(metadata.title, '用户改过的名称');
  }
});

test('archive flag accepts only stored INTEGER zero or one and never coerces missing or invalid values', (t) => {
  // A typeless fixture preserves REAL and TEXT storage instead of SQLite's INTEGER affinity coercion.
  const invalid = [null, -1, 2, 0.5, '0', '1', 'true'];
  const database = fixture(t, invalid.map((archived, index) => row({ id: `invalid_${index}`, archived })), { archiveType: '' });
  const lookup = createChatMetadataLookup({ database });
  for (let index = 0; index < invalid.length; index++) fixedError(() => lookup(`invalid_${index}`));
  python("import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE threads SET archived=? WHERE id=?',(0.0,'invalid_0'));c.commit();c.close()", [database]);
  fixedError(() => lookup('invalid_0'));
  const result = spawnSync(PYTHON, ['-I', HELPER, database, 'invalid_0'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'chat_metadata_unavailable\n');
});

test('missing and invalid IDs return undefined without broadening the lookup', (t) => {
  const database = fixture(t, [row()]);
  assert.equal(createChatMetadataLookup({ database })('missing_chat'), undefined);
  let calls = 0;
  const lookup = createChatMetadataLookup({ database, spawnImpl: () => { calls++; throw new Error(SECRET); } });
  for (const id of ['', 'x'.repeat(129), 'name/other', "' OR 1=1 --", '空白', 'x\n', null, 42]) assert.equal(lookup(id), undefined);
  assert.equal(calls, 0);
});

test('renaming is reflected by the next read instead of a cached name', (t) => {
  const database = fixture(t, [row()]);
  const lookup = createChatMetadataLookup({ database });
  assert.equal(lookup('chat_12345678').title, '用户改过的名称');
  python("import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE threads SET name=? WHERE id=?',('新名称','chat_12345678'));c.commit();c.close()", [database]);
  assert.equal(lookup('chat_12345678').title, '新名称');
});

test('bad schema and missing files fail with only the fixed error and never create a database', (t) => {
  const database = fixture(t, [], { broken: true });
  fixedError(() => createChatMetadataLookup({ database })('chat_12345678'));
  fixedError(() => createChatMetadataLookup({ database: database + '.missing' })('chat_12345678'));
  const result = spawnSync(PYTHON, ['-I', HELPER, database, 'chat_12345678'], { encoding: 'utf8' });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'chat_metadata_unavailable\n');
  assert.equal(result.status, 1);
});

test('rejects writable or symlinked database files and non-absolute paths', (t) => {
  const database = fixture(t, [row()]);
  const link = database + '.link';
  symlinkSync(database, link);
  fixedError(() => createChatMetadataLookup({ database: link })('chat_12345678'));
  chmodSync(database, 0o666);
  fixedError(() => createChatMetadataLookup({ database })('chat_12345678'));
  fixedError(() => createChatMetadataLookup({ database: 'relative.sqlite' }));
});

test('rejects invalid cwd, types and oversized rows without passing diagnostics through', (t) => {
  const database = fixture(t, [row({ id: 'relative', cwd: 'relative/path' }), row({ id: 'long_cwd', cwd: '/' + 'x'.repeat(1024) }),
    row({ id: 'huge_row', name: SECRET.repeat(500) }), row({ id: 'nul_name', name: 'name\0private' })]);
  const lookup = createChatMetadataLookup({ database });
  for (const id of ['relative', 'long_cwd', 'huge_row', 'nul_name']) fixedError(() => lookup(id));
});

test('spawns an absolute isolated Python helper with bounded pipes, timeout and no shell', () => {
  const database = '/does/not/need/to/exist.sqlite';
  let calls = 0;
  const lookup = createChatMetadataLookup({ database, timeoutMs: 1200, spawnImpl(binary, args, options) {
    calls++;
    assert.equal(binary, PYTHON);
    assert.deepEqual(args, ['-I', HELPER, database, 'safe_chat']);
    assert.ok(isAbsolute(args[1]));
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 1200);
    assert.equal(options.maxBuffer, 16384);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    return { status: 0, stdout: JSON.stringify({ sessionId: 'safe_chat', title: '名称', cwd: '/project', isMain: true, titleReady: true, isArchived: false }), stderr: '' };
  } });
  assert.equal(lookup('safe_chat').title, '名称');
  assert.equal(calls, 1);
});

test('timeouts, process errors, unexpected data and oversize output share a fixed safe error', () => {
  const valid = { sessionId: 'chat', title: '名称', cwd: '/project', isMain: true, titleReady: true, isArchived: false };
  const failedResults = [
    { error: Object.assign(new Error(SECRET + '/private/path'), { code: 'ETIMEDOUT' }), status: null },
    { status: 1, stdout: SECRET, stderr: '/private/path: sqlite failure' },
    { status: 0, stdout: SECRET }, { status: 0, stdout: 'x'.repeat(16385) },
    { status: 0, stdout: JSON.stringify({ ...valid, prompt: SECRET }) },
    { status: 0, stdout: JSON.stringify({ ...valid, title: '😀'.repeat(161) }) },
    { status: 0, stdout: JSON.stringify({ ...valid, sessionId: 'other' }) },
    { status: 0, stdout: JSON.stringify({ ...valid, isMain: 'true' }) },
    { status: 0, stdout: JSON.stringify({ ...valid, isArchived: 1 }) },
    { status: 0, stdout: JSON.stringify({ ...valid, isArchived: 'false' }) },
    { status: 0, stdout: JSON.stringify({ ...valid, isArchived: null }) },
    { status: 0, stdout: JSON.stringify(Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'isArchived'))) },
  ];
  for (const result of failedResults) fixedError(() => createChatMetadataLookup({ database: '/db', spawnImpl: () => result })('chat'));
  fixedError(() => createChatMetadataLookup({ database: '/db', spawnImpl: () => { throw new Error(SECRET); } })('chat'));
});
