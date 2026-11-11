/** Exercise the real collector, read-only SQLite adapter and relay with isolated files and no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createChatMetadataLookup } from './chat-metadata.mjs';
import { createReportSessionLookup } from './report-scope.mjs';
import { SessionRouter } from './session-router.mjs';
import { TurnRelay } from './turn-relay.mjs';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';

const ROOT = '10000000-0000-4000-8000-000000000001';
const COLLECTOR = fileURLToPath(new URL('./report-hook.py', import.meta.url));
function python(code, args) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', code, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 16000 });
  assert.equal(result.status, 0, 'isolated Python fixture failed');
  return result.stdout.trim();
}

test('future main-chat replies get their UI titles once, while agents and historical reports never send', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-all-chat-e2e-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'state.sqlite'), outbox = join(directory, 'turn-outbox'), policyPath = join(directory, 'report-policy.json');
  const now = Date.now();
  writePrivateJson(join(directory, "session-catalog.json"), { version: 1, sessions: [] });
  writePrivateJson(policyPath, { version: 1, scope: 'all_local_main_chats', enabled: true, activatedAtMs: now - 1000 });
  python(`import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,cwd TEXT,source TEXT,thread_source TEXT,agent_path TEXT,archived INTEGER DEFAULT 0)')
c.executemany('INSERT INTO threads(id,name,cwd,source,thread_source,agent_path) VALUES(?,?,?,?,?,?)', [('main_a','任务 A','/workspace','vscode','user',None),('main_b','任务 B','/workspace','vscode','agent_created_thread',None),('internal','内部代理','/workspace','{}','subagent','/root/worker')]);c.commit();c.close()`, [database]);
  const collect = id => python(`import importlib.util,json,sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
s=importlib.util.spec_from_file_location('collector',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(m.queue_report({'hook_event_name':'Stop','session_id':sys.argv[4],'turn_id':'turn_fixture','last_assistant_message':'隔离测试回复'},Path(sys.argv[2]).parent,int(sys.argv[3])))`, [COLLECTOR,outbox,String(now),id]);
  const a = collect('main_a'), b = collect('main_b'), internal = collect('internal');
  assert.equal(collect('main_a'), a);
  assert.equal(readdirSync(outbox).filter(name => name.endsWith('.json')).length, 3);
  const oldId = 'd'.repeat(64);
  writePrivateJson(join(outbox, oldId + '.json'), { version: 1, kind: 'codex_turn_report', eventId: oldId, sessionId: 'main_a', turnId: 'old', createdAtMs: now - 2000, lastAssistantMessage: '旧报告', truncated: false });
  const catalog = { version: 1, defaultSessionId: ROOT, sessions: [{ sessionId: ROOT, title: '原聊天', cwd: '/workspace' }] };
  const router = new SessionRouter({ catalog, storageDirectory: join(directory, 'routes'), binary: process.execPath });
  const relay = new TurnRelay({ outbox, binary: process.execPath, threadId: ROOT,
    sessionLookup: createReportSessionLookup({ router, lookupMetadata: createChatMetadataLookup({ database }), policyPath }) });
  const cards = [];
  await relay.pollReports(async card => { cards.push(card); return 'om_fixture_' + cards.length; }, now + 100);
  assert.deepEqual(cards.map(card => card.header.title.content).sort(), ['任务 A · 本轮回复','任务 B · 本轮回复']);
  assert.ok(cards.every(card => card.body.elements.at(-1).text.content.includes('其他聊天')));
  for (const id of [a,b]) assert.equal(readPrivateJson(join(outbox,'.relay-state/reports',id+'.json')).status,'sent');
  for (const id of [internal,oldId]) assert.equal(readPrivateJson(join(outbox,'.relay-state/reports',id+'.json')).status,'rejected');
  await relay.pollReports(async () => { throw new Error('must not send twice'); }, now + 200);
  assert.equal(cards.length, 2);
  assert.equal(router.currentSessionId, ROOT);
  assert.equal(router.getSession('main_a'), undefined);
  assert.equal(catalog.sessions.length, 1);
});


test('an unindexed main-chat report stays pending and sends once when metadata becomes available', async t => {
  const root=mkdtempSync(join(tmpdir(),'feishu-unindexed-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const now=Date.now(),policyPath=join(root,'policy.json'),outbox=join(root,'outbox'),event='e'.repeat(64);
  writePrivateJson(policyPath,{version:1,scope:'all_local_main_chats',enabled:true,activatedAtMs:now-1000});
  writePrivateJson(join(outbox,event+'.json'),{version:1,kind:'codex_turn_report',eventId:event,sessionId:'later_main',turnId:'later_turn',createdAtMs:now,lastAssistantMessage:'索引稍后可用',truncated:false});
  const router={refreshCatalog(){},getSession(){return undefined;}};
  let available=false,sends=0;
  const relay=new TurnRelay({outbox,binary:process.execPath,threadId:ROOT,sessionLookup:createReportSessionLookup({router,policyPath,lookupMetadata:id=>available?{sessionId:id,title:'稍后可用的标题',cwd:'/workspace',isMain:true}:undefined})});
  const send=async card=>{sends++;assert.equal(card.header.title.content,'稍后可用的标题 · 本轮回复');return 'om_later';};
  await relay.pollReports(send,now+100);
  assert.equal(sends,0);assert.equal(existsSync(join(outbox,'.relay-state/reports',event+'.json')),false);
  available=true;await relay.pollReports(send,now+200);
  assert.equal(sends,1);assert.equal(readPrivateJson(join(outbox,'.relay-state/reports',event+'.json')).status,'sent');
  await relay.pollReports(send,now+300);assert.equal(sends,1);
});


test('a first Stop waits for its generated UI name and then sends the same report once', async t => {
  const root=mkdtempSync(join(tmpdir(),'feishu-name-ready-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const start=Date.now(),policyPath=join(root,'policy.json'),outbox=join(root,'outbox'),event='f'.repeat(64);
  writePrivateJson(policyPath,{version:1,scope:'all_local_main_chats',enabled:true,activatedAtMs:start-1000});
  writePrivateJson(join(outbox,event+'.json'),{version:1,kind:'codex_turn_report',eventId:event,sessionId:'new_main',turnId:'first_turn',createdAtMs:start,lastAssistantMessage:'完成',truncated:false});
  let time=start,ready=false,sends=0;
  const lookup=createReportSessionLookup({router:{refreshCatalog(){},getSession(){}},policyPath,clock:()=>time,lookupMetadata:id=>({sessionId:id,title:ready?'生成后的标题':'聊天 new_main',titleReady:ready,isMain:true,cwd:'/workspace'})});
  const relay=new TurnRelay({outbox,binary:process.execPath,threadId:ROOT,sessionLookup:lookup});
  const send=async card=>{sends++;assert.equal(card.header.title.content,'生成后的标题 · 本轮回复');return 'om_named';};
  await relay.pollReports(send,time);time=start+14999;await relay.pollReports(send,time);
  assert.equal(sends,0);assert.equal(existsSync(join(outbox,'.relay-state/reports',event+'.json')),false);
  ready=true;await relay.pollReports(send,time);assert.equal(sends,1);
  await relay.pollReports(send,time+1);assert.equal(sends,1);
});
