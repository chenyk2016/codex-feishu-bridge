/** Scope checks never touch live policies, chats, hooks, or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createReportSessionLookup, readReportingPolicy } from './report-scope.mjs';
import { writePrivateJson } from './probe-core.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'feishu-global-scope-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const policyPath = join(root, 'report-policy.json'), now = Date.now();
  writePrivateJson(policyPath, { version: 1, scope: 'all_local_main_chats', enabled: true, activatedAtMs: now - 1000 });
  const registered = { sessionId: 'root', title: '旧别名', cwd: '/work' };
  const router = { refreshCatalog() {}, getSession: id => id === 'root' ? registered : undefined };
  const lookupMetadata = id => ({ sessionId: id, title: `${id}当前名称`, cwd: '/work', isMain: id !== 'agent' });
  return { root, policyPath, now, registered, router, lookupMetadata };
}

test('current UI names replace aliases without changing the registration or selected chat', t => {
  const f = fixture(t), lookup = createReportSessionLookup(f);
  assert.equal(lookup('root', { createdAtMs: f.now }).title, 'root当前名称');
  assert.equal(f.registered.title, '旧别名');
  assert.equal(lookup('new_main', { createdAtMs: f.now }).reportOnly, true);
  assert.equal(f.router.getSession('new_main'), undefined);
});

test('global reports reject agents, old events, missing metadata and disabled or missing policies', t => {
  const f = fixture(t), lookup = createReportSessionLookup(f);
  assert.equal(lookup('agent', { createdAtMs: f.now }), undefined);
  assert.equal(lookup('old', { createdAtMs: f.now - 2000 }), undefined);
  assert.throws(() => createReportSessionLookup({ ...f, lookupMetadata: () => undefined })('new_main', { createdAtMs: f.now }), /metadata_unavailable/);
  writePrivateJson(f.policyPath, { version: 1, scope: 'all_local_main_chats', enabled: false, activatedAtMs: f.now - 1000 });
  assert.equal(lookup('new_main', { createdAtMs: f.now }), undefined);
  assert.equal(createReportSessionLookup({ ...f, policyPath: join(f.root, 'missing') })('new_main', { createdAtMs: f.now }), undefined);
  assert.equal(lookup('root', { createdAtMs: f.now }).title, 'root当前名称');
});

test('temporary metadata outages retain global reports for later processing while known-chat titles safely fall back', t => {
  const f = fixture(t), lookup = createReportSessionLookup({ ...f, lookupMetadata() { throw new Error('chat_metadata_unavailable'); } });
  assert.throws(() => lookup('new_main', { createdAtMs: f.now }), /metadata_unavailable/);
  assert.equal(lookup('root', { createdAtMs: f.now }).title, '旧别名');
});

test('a recent reply target is not a static registration and cannot bypass disabled reporting policy', t => {
  const f = fixture(t);
  const recent = { sessionId: 'new_main', title: '最近任务', cwd: '/work' };
  const router = { refreshCatalog() {}, getSession: () => recent, getRegisteredSession: () => undefined };
  writePrivateJson(f.policyPath, { version: 1, scope: 'all_local_main_chats', enabled: false, activatedAtMs: f.now - 1000 });
  assert.equal(createReportSessionLookup({ ...f, router })('new_main', { createdAtMs: f.now }), undefined);
});

test('private policy validation rejects future times, unsupported scopes and shared files', t => {
  const f = fixture(t);
  for (const change of [{ activatedAtMs: f.now + 50000 }, { scope: 'every_user' }, { enabled: 'true' }, { extra: true }]) {
    writePrivateJson(f.policyPath, { version: 1, scope: 'all_local_main_chats', enabled: true, activatedAtMs: f.now - 1, ...change });
    assert.throws(() => readReportingPolicy(f.policyPath, f.now));
  }
  writePrivateJson(f.policyPath, { version: 1, scope: 'all_local_main_chats', enabled: true, activatedAtMs: f.now - 1 });
  chmodSync(f.policyPath, 0o644); assert.throws(() => readReportingPolicy(f.policyPath, f.now));
});


test('duplicate policies, symlinks and special files cannot enable global reporting', t => {
  const f=fixture(t);
  writeFileSync(f.policyPath,'{"version":1,"scope":"all_local_main_chats","enabled":false,"enabled":true,"activatedAtMs":1}',{mode:0o600});
  assert.throws(()=>readReportingPolicy(f.policyPath));
  const alias=join(f.root,'alias');symlinkSync(f.policyPath,alias);assert.throws(()=>readReportingPolicy(alias));
  const fifo=join(f.root,'fifo');assert.equal(spawnSync('mkfifo',[fifo]).status,0);assert.throws(()=>readReportingPolicy(fifo));
});


test('new display names wait briefly from Stop time, for both registered and global main chats', t => {
  const f=fixture(t); let time=f.now, ready=false;
  const lookup=createReportSessionLookup({...f,clock:()=>time,lookupMetadata:id=>({sessionId:id,title:ready?'界面名称':'聊天 '+id,cwd:'/work',isMain:id!=='agent',titleReady:ready})});
  for(const id of ['root','new_main'])assert.throws(()=>lookup(id,{createdAtMs:f.now}),/chat_title_pending/);
  assert.equal(lookup('agent',{createdAtMs:f.now}),undefined);
  assert.equal(lookup('old',{createdAtMs:f.now-2000}),undefined);
  time=f.now+14999;assert.throws(()=>lookup('new_main',{createdAtMs:f.now}),/chat_title_pending/);
  ready=true;assert.equal(lookup('new_main',{createdAtMs:f.now}).title,'界面名称');
  ready=false;time=f.now+15000;assert.equal(lookup('new_main',{createdAtMs:f.now}).title,'聊天 new_main');
  time+=1000;assert.equal(lookup('new_main',{createdAtMs:f.now}).title,'聊天 new_main');
});
