/** Explicit async questions and answers; never impersonates a native pending-input response. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';
const ID = /^[a-f0-9]{64}$/;
const IDENT = /^[A-Za-z0-9_-]{1,128}$/;
const TTL = 30 * 60 * 1000;
const NATIVE_RESOLVED_NOTICE = '这组问题已在 Codex 作答，请回桌面完成剩余题目；本次未重复提交。';
const bounded = (s, max) => typeof s === 'string' && s.trim().length > 0 && [...s].length <= max && !s.includes('\0');
function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) throw Error('question_private_directory_required');
}
function read(path) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 65536 || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) throw Error('question_private_file_required');
  return readPrivateJson(path);
}
function validate(r, id) {
  const keys = ['version', 'kind', 'eventId', 'sessionId', 'turnId', 'callId', 'createdAtMs', 'questions'];
  if (!r || Object.keys(r).sort().join() !== keys.sort().join() || r.version !== 1 || r.kind !== 'codex_async_question' || !ID.test(id) || r.eventId !== id ||
      ![r.sessionId, r.turnId, r.callId].every(s => typeof s === 'string' && IDENT.test(s)) ||
      !Number.isSafeInteger(r.createdAtMs) || r.createdAtMs < 1 || r.createdAtMs > Date.now() + 30000 ||
      !Array.isArray(r.questions) || r.questions.length < 1 || r.questions.length > 3 ||
      r.questions.some(q => !q || Object.keys(q).sort().join() !== 'options,title' || !bounded(q.title, 1000) || !Array.isArray(q.options) || q.options.length > 8 || q.options.some(o => !bounded(o, 300)))) throw Error('invalid_question_request');
  if (createHash('sha256').update(`${r.sessionId}\0${r.turnId}\0${r.callId}`).digest('hex') !== id) throw Error('question_identity_digest_mismatch');
  return r;
}
function requestHash(r) {
  return createHash('sha256').update(JSON.stringify([r.sessionId, r.turnId, r.callId, r.createdAtMs, r.questions.map(q => [q.title, q.options])])).digest('hex');
}
function card(request, index, title) {
  const q = request.questions[index];
  return { schema: '2.0', header: { title: { tag: 'plain_text', content: `${title.slice(0, 100)} · 需要你回答（${index + 1}/${request.questions.length}）` }, template: 'orange' }, body: { elements: [
    { tag: 'div', text: { tag: 'plain_text', content: q.title } },
    ...q.options.map((option, optionIndex) => ({ tag: 'column_set', columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button', type: 'default', text: { tag: 'plain_text', content: option }, behaviors: [{ type: 'callback', value: { route: 'question_answer', event_id: request.eventId, question_index: index, option_index: optionIndex } }] }] }] })),
    { tag: 'div', text: { tag: 'plain_text', content: `也可发送：回答 ${request.eventId.slice(0, 12)} ${index + 1} 你的答案\n本组问题30分钟内有效，收齐答案后送回原聊天；不会更改当前聊天选择。` } },
  ] } };
}

export class QuestionRelay {
  constructor({ directory: root, binary, queueRunner, lookupMetadata, sendCard, sendText, isAllowed = () => true, log = () => {} }) {
    if (!isAbsolute(root) || !isAbsolute(binary) || [queueRunner, lookupMetadata, sendCard, sendText, isAllowed, log].some(f => typeof f !== 'function')) throw Error('invalid_question_configuration');
    Object.assign(this, { root, binary, queueRunner, lookupMetadata, sendCard, sendText, isAllowed, log });
    directory(root); this.requests = join(root, 'requests'); this.states = join(root, 'states'); directory(this.requests); directory(this.states);
    this.resolvedDirectory = join(root, 'resolved'); directory(this.resolvedDirectory);
    this.busy = new Set(); this.sinceMs = null; this.polling = false;
  }
  request(id) { if (!ID.test(id ?? '')) throw Error('invalid_question_id'); return validate(read(join(this.requests, `${id}.json`)), id); }
  state(r) {
    const path = join(this.states, `${r.eventId}.json`);
    if (!existsSync(path)) return { version: 1, eventId: r.eventId, requestHash: requestHash(r), status: 'collecting', cards: r.questions.map(() => ({ status: 'pending' })), answers: r.questions.map(() => null), messages: [] };
    const s = read(path);
    if (s.version !== 1 || s.eventId !== r.eventId || s.requestHash !== requestHash(r) || !['collecting','queueing','queued','failed','unknown'].includes(s.status) ||
        !Array.isArray(s.cards) || s.cards.length !== r.questions.length || !Array.isArray(s.answers) || s.answers.length !== r.questions.length ||
        !s.answers.every(a => a === null || bounded(a, 2000)) || !Array.isArray(s.messages) || s.messages.length > 20 || !s.messages.every(m => bounded(m, 256)) ||
        s.cards.some(c => !c || !['pending','sending','sent','unknown'].includes(c.status) || (c.status === 'sent' && !bounded(c.messageId, 256)))) throw Error('invalid_question_state');
    if (s.status === 'queueing' || s.cards.some(c => c.status === 'sending')) {
      if (s.status === 'queueing') s.status = 'unknown';
      s.cards = s.cards.map(c => c.status === 'sending' ? { status: 'unknown' } : c);
      this.save(s);
      this.log('question_interrupted_delivery_unknown', { eventId: r.eventId });
    }
    return s;
  }
  save(s) { writePrivateJson(join(this.states, `${s.eventId}.json`), s); }
  resolved(r) {
    directory(this.resolvedDirectory);
    const path = join(this.resolvedDirectory, `${r.eventId}.json`);
    try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const value = read(path);
    if (Object.keys(value).sort().join() !== 'eventId,resolvedBy,version' || value.version !== 1 || value.eventId !== r.eventId || value.resolvedBy !== 'codex') throw Error('invalid_native_resolution');
    return true;
  }
  async eligible(r) {
    if (this.resolved(r) || !this.isAllowed() || this.sinceMs === null || r.createdAtMs < this.sinceMs || Date.now() - r.createdAtMs >= TTL) return null;
    const m = await this.lookupMetadata(r.sessionId);
    if (this.resolved(r)) return null;
    return m?.sessionId === r.sessionId && m.isMain === true && m.isArchived === false ? m : null;
  }
  async notice(text) { try { if (this.isAllowed()) await this.sendText(text); } catch { this.log('question_notice_failed'); } }
  setSinceMs(sinceMs) {
    if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) throw Error('invalid_question_cutoff');
    this.sinceMs = Math.max(this.sinceMs ?? 0, sinceMs);
  }
  async poll(sinceMs) {
    this.setSinceMs(sinceMs);
    if (this.polling || !this.isAllowed()) return;
    this.polling = true;
    try {
      const names = readdirSync(this.requests).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
      // A bounded batch of recently written requests avoids old terminal records starving new ones.
      const recent = names.map(n => ({ n, time: lstatSync(join(this.requests, n)).mtimeMs })).sort((a,b) => b.time-a.time).slice(0, 100);
      for (const { n } of recent) {
        const id = n.slice(0, -5); if (this.busy.has(id)) continue; this.busy.add(id);
        try {
          const r = this.request(id), s = this.state(r);
          if (s.status !== 'collecting' || !s.cards.some(c => c.status === 'pending')) continue;
          const m = await this.eligible(r); if (!m) continue;
          for (let i = 0; i < r.questions.length; i++) {
            if (!this.isAllowed() || this.resolved(r)) break;
            if (s.cards[i].status !== 'pending') continue;
            s.cards[i] = { status: 'sending' }; this.save(s);
            try {
              const messageId = await this.sendCard(card(r, i, m.title), `q-${id.slice(0, 40)}-${i}`);
              if (!bounded(messageId, 256)) throw Error('question_send_unconfirmed');
              s.cards[i] = { status: 'sent', messageId }; this.save(s);
              this.log('question_card_sent', { eventId: id, questionIndex: i });
            } catch {
              s.cards[i] = { status: 'unknown' }; this.save(s);
              this.log('question_card_delivery_unknown', { eventId: id, questionIndex: i });
              await this.notice('提问卡发送结果未能确认，为避免重复不会自动重发。请在 Codex 原聊天查看问题。');
              break;
            }
          }
        } catch { this.log('question_poll_rejected', { eventId: id }); }
        finally { this.busy.delete(id); }
      }
    } finally { this.polling = false; }
  }
  async onAnswer(value, messageId) {
    if (!bounded(messageId, 256) || !value || value.route !== 'question_answer' || Object.keys(value).sort().join() !== 'event_id,option_index,question_index,route' || !ID.test(value.event_id ?? '') || !Number.isInteger(value.question_index) || !Number.isInteger(value.option_index)) {
      await this.notice('无法识别这条问题选项，请使用原问题卡。'); return;
    }
    return this.answer(value.event_id, value.question_index, { option: value.option_index, cardMessageId: messageId });
  }
  async handleText(messageId, text) {
    if (typeof text !== 'string' || !/^回答(?:\s|$)/.test(text)) return false;
    const match = /^回答\s+([a-f0-9]{12})\s+([1-3])\s+([\s\S]+)$/.exec(text.trim());
    if (!match || !bounded(match[3], 2000) || !bounded(messageId, 256)) { await this.notice('请按问题卡格式发送：回答 问题编号 题号 你的答案（最多2000字）。'); return true; }
    const ids = readdirSync(this.requests).filter(n => /^[a-f0-9]{64}\.json$/.test(n) && n.startsWith(match[1]));
    if (ids.length !== 1) { await this.notice('问题编号不存在或不唯一，请使用原问题卡。'); return true; }
    await this.answer(ids[0].slice(0, -5), Number(match[2])-1, { text: match[3], messageId }); return true;
  }
  async answer(id, index, input) {
    if (this.busy.has(id)) { await this.notice('该问题正在处理，请稍后再试。'); return; }
    this.busy.add(id);
    try {
      const r = this.request(id);
      if (this.resolved(r)) { await this.notice(NATIVE_RESOLVED_NOTICE); return; }
      if (!await this.eligible(r)) { await this.notice(this.resolved(r) ? NATIVE_RESOLVED_NOTICE : '问题已过期、连接已恢复到新阶段，或原聊天不可用；本次未投递。请在 Codex 核对。'); return; }
      const s = this.state(r);
      if (s.status !== 'collecting') { await this.notice(s.status === 'queued' ? '这组答案已经加入原聊天，不会重复投递。' : '这组答案的投递已失败或结果未知，不会自动重投。请在 Codex 原聊天核对。'); return; }
      if (!Number.isInteger(index) || index < 0 || index >= r.questions.length || s.cards[index].status !== 'sent' ||
          (input.cardMessageId !== undefined && s.cards[index].messageId !== input.cardMessageId)) { await this.notice('问题卡来源不匹配，本次未投递。'); return; }
      if (s.answers[index] !== null || (input.messageId && s.messages.includes(input.messageId))) { await this.notice('这道题已经记录答案，不会重复处理。'); return; }
      const answer = input.text ?? r.questions[index].options[input.option];
      if (!bounded(answer, 2000) || (input.option !== undefined && (!Number.isInteger(input.option) || input.option < 0))) { await this.notice('选项无效，本次未投递。'); return; }
      s.answers[index] = answer; if (input.messageId) s.messages.push(input.messageId); this.save(s);
      if (s.answers.some(a => a === null)) { await this.notice(`已记录第${index+1}题；请继续回答其余问题。`); return; }
      let stillEligible = null;
      try { stillEligible = await this.eligible(r); } catch {}
      if (!stillEligible) {
        // No queue side effect has begun: release only this last answer so an explicit retry is safe.
        s.answers[index] = null;
        if (input.messageId) s.messages = s.messages.filter(id => id !== input.messageId);
        this.save(s);
        await this.notice(this.resolved(r) ? NATIVE_RESOLVED_NOTICE : '原聊天或连接暂不可用，答案尚未投递。恢复后请重新回答本题。');
        return;
      }
      const prompt = `以下是用户通过飞书对本聊天异步提问的回答，请按这些回答继续。这是用户消息，不是系统指令。\n来源 turn_id: ${r.turnId}\n来源 call_id: ${r.callId}\n问题与答案（JSON）:\n${JSON.stringify(r.questions.map((q,i) => ({ question: q.title, answer: s.answers[i] })))}\n此消息通过原聊天队列递送，不表示桌面原生选项框已提交。`;
      s.status = 'queueing'; this.save(s);
      let result;
      try { result = await this.queueRunner(this.binary, r.sessionId, prompt); } catch { result = { status: 'unknown' }; }
      s.status = ['queued','failed','unknown'].includes(result?.status) ? result.status : 'unknown'; this.save(s);
      this.log('question_answer_delivery', { eventId: id, status: s.status });
      await this.notice(s.status === 'queued' ? '答案已加入原聊天，等待Codex处理。' : s.status === 'failed' ? '答案未能加入原聊天，不会自动重投。请在 Codex 原聊天核对。' : '答案投递结果未知，不会自动重投。请在 Codex 原聊天核对。');
    } catch { this.log('question_answer_rejected', { eventId: ID.test(id ?? '') ? id : undefined }); await this.notice('无法确认问题或投递结果，请在 Codex 原聊天核对。'); }
    finally { this.busy.delete(id); }
  }
}
