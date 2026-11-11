import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRouter } from './session-router.mjs';
import { createNavigationDelivery } from './navigation-delivery.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'navigation-delivery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const router = new SessionRouter({ storageDirectory: directory, binary: '/unused',
    catalog: { version: 1, defaultSessionId: 'a', sessions: ['a', 'b'].map(sessionId => ({ sessionId, title: sessionId, cwd: '/workspace' })) },
    queueRunner: () => { throw new Error('navigation_must_not_execute_tasks'); } });
  const menu = router.createMenu(Date.now() - 700000);
  router.noteControlSent(menu.controlId, 'om_menu');
  const value = menu.card.body.elements[1].columns[1].elements[0].behaviors[0].value;
  const sent = [], texts = [];
  const sendControl = async result => {
    const messageId = `om_new_${sent.length}`;
    router.noteControlSent(result.controlId, messageId);
    sent.push({ result, messageId });
  };
  return { router, value, sent, texts, sendControl, sendText: async text => texts.push(text) };
}

test('old menu opens a fresh message repeatedly; callback acknowledges before routing; duplicate event is ignored', async t => {
  const f = fixture(t); const delivery = createNavigationDelivery(f);
  const request = { value: f.value, messageId: 'om_menu', eventId: 'event_1' };
  const response = delivery.receive(request);
  assert.equal(response.card, undefined); assert.equal(f.sent.length, 0);
  delivery.receive(request); await delivery.idle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].result.status, 'choose_session');
  delivery.receive({ ...request, eventId: 'event_2' }); await delivery.idle();
  assert.equal(f.sent.length, 2);
  const picker = f.sent[0];
  const choice = picker.result.card.body.elements.flatMap(e => e.columns ?? []).flatMap(c => c.elements)
    .flatMap(e => e.behaviors ?? []).map(b => b.value).find(v => v.session_id === 'b');
  delivery.receive({ value: choice, messageId: picker.messageId, eventId: 'choose_1' }); await delivery.idle();
  assert.equal(f.sent.at(-1).result.status, 'switched');
  assert.equal(f.router.currentSessionId, 'b');
  delivery.receive({ value: choice, messageId: picker.messageId, eventId: 'choose_2' }); await delivery.idle();
  assert.match(f.texts.at(-1), /已使用或过期/);
});

test('send failure leaves menu retryable and reports failure without claiming success', async t => {
  const f = fixture(t); let fail = true;
  const delivery = createNavigationDelivery({ ...f, sendControl: async result => {
    if (fail) throw new Error('simulated_send_failure'); await f.sendControl(result);
  } });
  delivery.receive({ value: f.value, messageId: 'om_menu', eventId: 'fail' }); await delivery.idle();
  assert.match(f.texts[0], /未能发送/); fail = false;
  delivery.receive({ value: f.value, messageId: 'om_menu', eventId: 'retry' }); await delivery.idle();
  assert.equal(f.sent.length, 1);
});

test('navigation cannot borrow a token from another message or extend expired selection controls', async t => {
  const f = fixture(t); const delivery = createNavigationDelivery(f);
  delivery.receive({ value: f.value, messageId: 'om_wrong', eventId: 'wrong' }); await delivery.idle();
  assert.equal(f.sent.length, 0); assert.equal(f.texts.length, 1);
  const picker = f.router.createPicker(Date.now() - 700000); f.router.noteControlSent(picker.controlId, 'old_picker');
  assert.equal(f.router.handleControlAction({ route: 'select_session', selection_id: picker.controlId, session_id: 'b' }, 'old_picker', Date.now(), { newMessage: true }).status, 'invalid_selection');
  assert.equal(f.router.handleControlAction({ route: 'session_menu', action: 'new_chat', control_id: f.value.control_id }, 'om_menu', Date.now(), { newMessage: true }).status, 'invalid_selection');
  assert.equal(f.router.currentSessionId, 'a');
});

test('paused connection before deferred processing does not select or send', async t => {
  const f = fixture(t); let allowed = true;
  const delivery = createNavigationDelivery({ ...f, isAllowed: () => allowed });
  delivery.receive({ value: f.value, messageId: 'om_menu', eventId: 'pause' }); allowed = false;
  await delivery.idle(); assert.equal(f.sent.length, 0); assert.equal(f.texts.length, 0);
});

test('failed confirmation reports that selection already changed and does not roll it back', async t => {
  const f = fixture(t);
  const picker = f.router.createPicker(); f.router.noteControlSent(picker.controlId, 'picker');
  const delivery = createNavigationDelivery({ ...f, sendControl: async () => { throw new Error('offline'); } });
  delivery.receive({ value: { route: 'select_session', selection_id: picker.controlId, session_id: 'b' }, messageId: 'picker', eventId: 'select' });
  await delivery.idle();
  assert.equal(f.router.currentSessionId, 'b');
  assert.match(f.texts.at(-1), /聊天已切换，但确认卡发送失败/);
});

test('page navigation binds the next page only to its newly delivered message', async t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) f.router.catalog.sessions.push({ sessionId: `extra_${i}`, title: `Extra ${i}`, cwd: '/workspace' });
  const picker = f.router.createPicker(); f.router.noteControlSent(picker.controlId, 'page_one');
  const delivery = createNavigationDelivery(f);
  delivery.receive({ value: { route: 'session_page', selection_id: picker.controlId, page: 1 }, messageId: 'page_one', eventId: 'page' });
  await delivery.idle();
  assert.equal(f.sent[0].result.page, 1);
  assert.equal(f.router.readControl(f.sent[0].result.controlId, 'page_one'), null);
  assert.ok(f.router.readControl(f.sent[0].result.controlId, f.sent[0].messageId));
});
