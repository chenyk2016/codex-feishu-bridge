import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuestionRelay } from './question-relay.mjs';
import { writePrivateJson, readPrivateJson } from './probe-core.mjs';
const ID = createHash('sha256').update('original_chat\0turn_one\0call_one').digest('hex');
function fixture(t, overrides = {}, questions = [{ title: '选择颜色', options: ['红色', '蓝色'] }]) {
  const directory = mkdtempSync(join(tmpdir(), 'question-relay-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sent = [], notices = [], queued = [];
  const request = { version: 1, kind: 'codex_async_question', eventId: ID, sessionId: 'original_chat', turnId: 'turn_one', callId: 'call_one', createdAtMs: Date.now(), questions };
  const args = { directory, binary: '/codex', lookupMetadata: id => ({ sessionId: id, title: '原聊天', isMain: true, isArchived: false }),
    sendCard: async (c, uuid) => { sent.push({ c, uuid }); return `om_${sent.length}`; }, sendText: async text => notices.push(text),
    queueRunner: async (binary, id, text) => { queued.push({ binary, id, text }); return { status: 'queued' }; }, ...overrides };
  const relay = new QuestionRelay(args); relay.setSinceMs(0);
  writePrivateJson(join(directory, 'requests', `${ID}.json`), request);
  const answer = (index = 0, option = 0) => ({ route: 'question_answer', event_id: ID, question_index: index, option_index: option });
  return { directory, relay, args, request, sent, notices, queued, answer, state: () => readPrivateJson(join(directory, 'states', `${ID}.json`)) };
}
test('explicit option routes once to original question chat, not a default destination', async t => {
  const f = fixture(t); await f.relay.poll(0); assert.equal(f.sent.length, 1); assert.ok(f.sent[0].uuid.length <= 50);
  await f.relay.onAnswer(f.answer(), 'om_1');
  assert.equal(f.queued.length, 1); assert.equal(f.queued[0].id, 'original_chat');
  assert.match(f.queued[0].text, /turn_one/); assert.match(f.queued[0].text, /红色/);
  await f.relay.onAnswer(f.answer(), 'om_1'); await new QuestionRelay(f.args).poll(0);
  assert.equal(f.queued.length, 1); assert.equal(f.sent.length, 1);
  assert.match(f.notices[0], /答案已加入原聊天/);
});
test('multiple questions collect options and free text before a single delivery', async t => {
  const f = fixture(t, {}, [{ title: '颜色', options: ['红'] }, { title: '补充说明', options: [] }]);
  await f.relay.poll(0); await f.relay.onAnswer(f.answer(), 'om_1'); assert.equal(f.queued.length, 0);
  assert.equal(await f.relay.handleText('text_1', `回答 ${ID.slice(0,12)} 2 保留空格 与\n换行`), true);
  assert.equal(f.queued.length, 1); assert.match(f.queued[0].text, /保留空格 与/);
  assert.equal(await f.relay.handleText('ordinary', '2'), false);
  assert.equal(await f.relay.handleText('ordinary', '正常任务'), false);
});
test('wrong card, missing message, forged option and undelivered text cannot answer', async t => {
  const f = fixture(t);
  await f.relay.handleText('text_1', `回答 ${ID.slice(0,12)} 1 fake`); assert.equal(f.queued.length, 0);
  await f.relay.poll(0);
  await f.relay.onAnswer(f.answer(), 'om_wrong'); await f.relay.onAnswer(f.answer(), undefined);
  await f.relay.onAnswer(f.answer(0, 9), 'om_1'); assert.equal(f.queued.length, 0);
  assert.equal(f.state().answers[0], null);
});
test('expiry, archived origin and resume cutoff prevent old answers and old sends', async t => {
  const f = fixture(t); await f.relay.poll(0); f.relay.setSinceMs(Date.now()+1);
  await f.relay.onAnswer(f.answer(), 'om_1'); assert.equal(f.queued.length, 0);
  f.request.createdAtMs = Date.now() - 31*60*1000;
  writePrivateJson(join(f.directory,'requests',`${ID}.json`), f.request);
  const restarted = new QuestionRelay(f.args); await restarted.poll(0); await restarted.onAnswer(f.answer(), 'om_1');
  assert.equal(f.queued.length, 0);
  const g = fixture(t, { lookupMetadata: id => ({ sessionId:id,isMain:true,isArchived:true }) });
  await g.relay.poll(0); assert.equal(g.sent.length, 0);
});
test('unknown queue outcome persists across restart without requeue', async t => {
  let calls = 0; const f = fixture(t, { queueRunner: async () => { calls++; throw Error('lost_ack'); } });
  await f.relay.poll(0); await f.relay.onAnswer(f.answer(), 'om_1'); assert.equal(f.state().status, 'unknown');
  const restarted = new QuestionRelay(f.args); restarted.setSinceMs(0); await restarted.onAnswer(f.answer(), 'om_1');
  assert.equal(calls, 1); assert.match(f.notices.at(-1), /不会自动重投/);
});
test('interrupted sending and queueing are never replayed; failed queue is explicit', async t => {
  const f = fixture(t); await f.relay.poll(0);
  let state=f.state(); state.status='queueing'; writePrivateJson(join(f.directory,'states',`${ID}.json`),state);
  const restarted=new QuestionRelay(f.args); restarted.setSinceMs(0); await restarted.onAnswer(f.answer(),'om_1');
  assert.equal(f.queued.length,0); assert.equal(f.state().status,'unknown');
  const g=fixture(t,{sendCard:async()=>{throw Error('network');}}); await g.relay.poll(0); await g.relay.poll(0);
  assert.equal(g.state().cards[0].status,'unknown');
  const h=fixture(t,{queueRunner:async()=>({status:'failed'})}); await h.relay.poll(0); await h.relay.onAnswer(h.answer(),'om_1');
  assert.equal(h.state().status,'failed'); assert.match(h.notices.at(-1),/未能加入/);
});
test('private request symlinks and wrong permissions fail closed', async t => {
  const f=fixture(t); chmodSync(join(f.directory,'requests',`${ID}.json`),0o644);
  await f.relay.poll(0); assert.equal(f.sent.length,0);
  const another='b'.repeat(64); symlinkSync(join(f.directory,'requests',`${ID}.json`),join(f.directory,'requests',`${another}.json`));
  await f.relay.poll(0); assert.equal(f.sent.length,0);
});
test('concurrent duplicate replies cannot cause parallel queue calls', async t => {
  let resolveQueue, calls=0;
  const f=fixture(t,{queueRunner:()=>{calls++;return new Promise(resolve=>{resolveQueue=resolve;});}});
  await f.relay.poll(0); const pending=f.relay.onAnswer(f.answer(),'om_1');
  await new Promise(resolve=>setImmediate(resolve)); await f.relay.onAnswer(f.answer(),'om_1');
  assert.equal(calls,1);resolveQueue({status:'queued'});await pending;
});

test('sent requests skip repeat metadata work and reject modified question snapshots', async t => {
  let lookups=0;
  const f=fixture(t,{lookupMetadata:id=>{lookups++;return {sessionId:id,title:'Origin',isMain:true,isArchived:false};}});
  await f.relay.poll(0); await f.relay.poll(0); assert.equal(lookups,1);
  f.request.questions[0].options[0]='mutated';
  writePrivateJson(join(f.directory,'requests',`${ID}.json`),f.request);
  await f.relay.onAnswer(f.answer(),'om_1'); assert.equal(f.queued.length,0);
});

test('metadata failure after final answer permits explicit retry without duplicate queue', async t => {
  let lookups=0;
  const f=fixture(t,{lookupMetadata:id=>{lookups++;if(lookups===3)throw Error('transient');return {sessionId:id,title:'Origin',isMain:true,isArchived:false};}});
  await f.relay.poll(0);
  const text=`回答 ${ID.slice(0,12)} 1 first`;
  await f.relay.handleText('retryable_text',text);
  assert.equal(f.queued.length,0);assert.equal(f.state().answers[0],null);
  assert.deepEqual(f.state().messages,[]);
  await f.relay.handleText('retryable_text',text);assert.equal(f.queued.length,1);
});
test('pause before final queue releases the unsubmitted answer for later retry', async t => {
  let allowed=true, calls=0;
  const f=fixture(t,{isAllowed:()=>allowed,lookupMetadata:id=>{calls++;if(calls===2)allowed=false;return {sessionId:id,title:'Origin',isMain:true,isArchived:false};}});
  await f.relay.poll(0);await f.relay.onAnswer(f.answer(),'om_1');
  assert.equal(f.queued.length,0);assert.equal(f.state().answers[0],null);
  allowed=true;await f.relay.onAnswer(f.answer(),'om_1');assert.equal(f.queued.length,1);
});

test('native resolution suppresses new cards and rejects already sent question answers', async t => {
  const f=fixture(t);await f.relay.poll(0);
  writePrivateJson(join(f.directory,'resolved',`${ID}.json`),{version:1,eventId:ID,resolvedBy:'codex'});
  await f.relay.onAnswer(f.answer(),'om_1');assert.equal(f.queued.length,0);
  assert.match(f.notices.at(-1),/已在 Codex 作答/);
  const g=fixture(t);
  writePrivateJson(join(g.directory,'resolved',`${ID}.json`),{version:1,eventId:ID,resolvedBy:'codex'});
  await g.relay.poll(0);assert.equal(g.sent.length,0);
});
test('native resolution immediately before queue prevents a duplicate answer', async t => {
  let calls=0,f;
  f=fixture(t,{lookupMetadata:id=>{calls++;if(calls===3)writePrivateJson(join(f.directory,'resolved',`${ID}.json`),{version:1,eventId:ID,resolvedBy:'codex'});return {sessionId:id,title:'Origin',isMain:true,isArchived:false};}});
  await f.relay.poll(0);await f.relay.onAnswer(f.answer(),'om_1');
  assert.equal(f.queued.length,0);assert.equal(f.state().answers[0],null);assert.match(f.notices.at(-1),/已在 Codex 作答/);
});
test('invalid or symlinked native resolution markers fail closed', async t => {
  const f=fixture(t);await f.relay.poll(0);
  writePrivateJson(join(f.directory,'resolved',`${ID}.json`),{version:1,eventId:'b'.repeat(64),resolvedBy:'codex'});
  await f.relay.onAnswer(f.answer(),'om_1');assert.equal(f.queued.length,0);
  const g=fixture(t);symlinkSync(join(g.directory,'absent'),join(g.directory,'resolved',`${ID}.json`));
  await g.relay.poll(0);assert.equal(g.sent.length,0);
});
