/** Registered-chat turn reports and explicit owner follow-ups; independent of approvals. */
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { label, readPrivateJson, writePrivateJson } from './probe-core.mjs';
import { renderReportMarkdown } from './report-renderer.mjs';

const EVENT_ID = /^[a-f0-9]{64}$/i;
const CHAT_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const REPORT_KEYS = ['version', 'kind', 'eventId', 'sessionId', 'turnId', 'createdAtMs', 'lastAssistantMessage', 'truncated'];
const IMAGE_KEY = /^img_[a-zA-Z0-9_-]{1,280}$/;
const RETRY_DELAYS_MS = [2000, 10000];
const DISCONNECTED_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ECONNREFUSED',
  'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_CANCELED', 'ABORT_ERR',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/** A lost transport cannot prove the platform rejected a send, so never replay it automatically. */
function ambiguousDelivery(error) {
  return DISCONNECTED_CODES.has(error?.code) || DISCONNECTED_CODES.has(error?.cause?.code) ||
    ['AbortError', 'TimeoutError'].includes(error?.name);
}

/** Create only private, owned, non-symlink folders. */
function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('turn_relay_requires_owned_mode_700_directories');
  }
}

/** Extract text and link labels only, preserving rich-text paragraph boundaries. */
export function extractMessageText(type, content) {
  if (typeof content !== 'string') return '';
  let value;
  try { value = JSON.parse(content); } catch { return ''; }
  if (type === 'text') return typeof value?.text === 'string' ? value.text : '';
  if (type !== 'post' || !value || typeof value !== 'object') return '';
  const post = Array.isArray(value.content) ? value
    : [value.zh_cn, value.en_us, ...Object.values(value)].find((item) => item && Array.isArray(item.content));
  if (!post) return '';
  return post.content.map((paragraph) => Array.isArray(paragraph)
    ? paragraph.filter((part) => ['text', 'a', 'md'].includes(part?.tag) && typeof part.text === 'string').map((part) => part.text).join('')
    : '').join('\n');
}

/** Accept only an explicit prefix and a bounded nonempty instruction, never an implicit chat reply. */
export function followupBody(text) {
  if (typeof text !== 'string') return { status: 'ignored' };
  const prefix = ['继续 ', 'continue '].find((item) => text.startsWith(item));
  if (!prefix) return { status: 'ignored' };
  const body = text.slice(prefix.length);
  if (!body.trim() || body.includes('\0')) return { status: 'invalid_instruction' };
  if ([...body].length > 4000) return { status: 'instruction_too_long' };
  return { status: 'ready', body };
}

/** Validate the exact Stop contract against an explicitly chosen chat identity. */
export function validateTurnReport(value, fileId, sessionId, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== REPORT_KEYS.length ||
      REPORT_KEYS.some((key) => !Object.hasOwn(value, key))) throw new Error('turn_report_invalid_fields');
  if (value.version !== 1 || value.kind !== 'codex_turn_report' || !EVENT_ID.test(value.eventId) || value.eventId !== fileId ||
      typeof sessionId !== 'string' || !CHAT_ID.test(sessionId) || value.sessionId !== sessionId ||
      typeof value.turnId !== 'string' || !CHAT_ID.test(value.turnId)) {
    throw new Error('turn_report_wrong_identity');
  }
  if (!Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0 || value.createdAtMs > now + 30000 ||
      typeof value.lastAssistantMessage !== 'string' || [...value.lastAssistantMessage].length < 1 ||
      [...value.lastAssistantMessage].length > 4000 || typeof value.truncated !== 'boolean') {
    throw new Error('turn_report_invalid_content');
  }
  return value;
}

/** Accept only native image data and literal notices, never arbitrary elements from media preparation. */
function reportMedia(value, report) {
  if (value === undefined) return { elements: [], notices: [], bodyText: report.lastAssistantMessage };
  if (!value || typeof value !== 'object' || !Array.isArray(value.elements) || value.elements.length > 4 ||
      !Array.isArray(value.notices) || value.notices.some((notice) => typeof notice !== 'string') ||
      typeof value.bodyText !== 'string' || [...value.bodyText].length > 4000 ||
      value.elements.some((element) => element?.tag !== 'img' || !IMAGE_KEY.test(element.img_key ?? '') ||
        element.alt?.tag !== 'plain_text' || typeof element.alt.content !== 'string')) {
    return { elements: [], notices: ['图片处理结果无法核实，本轮文字仍保留。'], bodyText: report.lastAssistantMessage };
  }
  return { elements: value.elements.map((element) => ({ tag: 'img', img_key: element.img_key,
    alt: { tag: 'plain_text', content: [...element.alt.content].slice(0, 80).join('') } })),
  notices: value.notices.slice(0, 8), bodyText: value.bodyText.trim() ? value.bodyText : report.lastAssistantMessage };
}

/** Render supported Markdown and validated native images without allowing task text to add card actions. */
export function turnReportCard(report, session = { title: '原聊天' }, preparedMedia) {
  const title = typeof session.title === 'string' && session.title.trim() ? [...session.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim()].slice(0, 160).join('') : 'Codex 聊天';
  const headingTitle = [...title].length > 60 ? [...title].slice(0, 59).join('') + '…' : title;
  const media = reportMedia(preparedMedia, report);
  const notices = media.notices.length ? [{ tag: 'div', text: { tag: 'plain_text', content: [...media.notices.join('\n')].slice(0, 500).join('') } }] : [];
  const card = { schema: '2.0', config: { update_multi: true }, header: {
    title: { tag: 'plain_text', content: `${headingTitle} · 本轮回复` }, template: 'blue',
  }, body: { elements: [
    { tag: 'div', text: { tag: 'plain_text', content: `${title}（${report.sessionId.slice(-8)}）` } },
    { tag: 'markdown', content: renderReportMarkdown(media.bodyText) + (report.truncated ? '\n\n（原回复已截断）' : '') },
    ...media.elements, ...notices,
    { tag: 'div', text: { tag: 'plain_text', content: session.isArchived
      ? '此聊天已归档，本卡仅汇报，未切换回复目标。请在 Codex 恢复后继续，或发送“切换聊天”选择其他目标。'
      : session.recentRepliesEnabled
      ? '普通消息默认继续最新汇报的聊天；发送“切换聊天”选择最近10个聊天，发送“当前聊天”核对目标。'
      : session.reportOnly
      ? '此卡来自其他聊天。在 Codex 中打开同名聊天继续；飞书普通消息仍进入当前选中聊天。'
      : '发送“菜单”管理聊天；普通消息进入当前选中聊天。' } },
  ] } };
  // Images and failure notices consume the same platform budget as Markdown, so bound the whole card.
  let text = [...media.bodyText];
  while (Buffer.byteLength(JSON.stringify(card)) > 29000 && text.length) {
    text = text.slice(0, Math.max(0, text.length - 250));
    card.body.elements[1].content = renderReportMarkdown(text.join('')) + '\n\n（媒体报告较长，完整内容请在桌面聊天查看）';
  }
  return card;
}

/** Execute the official queue command without a shell, resume flag, or output/body logging. */
export function runCodexQueue(binary, threadId, body, { spawnImpl = spawn, timeoutMs = 30000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    let settled = false;
    let timedOut = false;
    let timer;
    let forceTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer); resolvePromise(result);
    };
    try {
      child = spawnImpl(binary, ['queue', '--thread', threadId, '--message', body], { shell: false, stdio: 'ignore' });
    } catch { finish({ status: 'failed' }); return; }
    child.once('error', () => finish({ status: 'failed' }));
    child.once('close', (code) => finish({ status: code === 0 && !timedOut ? 'queued' : (timedOut ? 'unknown' : 'failed') }));
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { finish({ status: 'unknown' }); }
      if (!settled) forceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } finally { finish({ status: 'unknown' }); } }, 1000);
    }, timeoutMs);
  });
}

/** Persist report delivery for the root and optional registry; follow-ups remain root-scoped. */
export class TurnRelay {
  /** Validate trusted local configuration and create private ack/attempt storage. */
  constructor({ outbox, binary, threadId, log = () => {}, queueRunner = runCodexQueue, sessionLookup, prepareReportMedia,
    recentRepliesEnabled = false, onReportSent, onDeliveryPending }) {
    if (typeof binary !== 'string' || !isAbsolute(binary) || typeof threadId !== 'string' || !CHAT_ID.test(threadId)) {
      throw new Error('turn_relay_requires_absolute_cli_and_fixed_chat');
    }
    if (sessionLookup !== undefined && typeof sessionLookup !== 'function') throw new Error('turn_relay_invalid_session_lookup');
    if (prepareReportMedia !== undefined && typeof prepareReportMedia !== 'function') throw new Error('turn_relay_invalid_media_preparer');
    if ([onReportSent, onDeliveryPending].some(fn => fn !== undefined && typeof fn !== 'function')) throw new Error('turn_relay_invalid_delivery_callback');
    const realBinary = realpathSync(binary);
    if (!lstatSync(realBinary).isFile()) throw new Error('turn_relay_cli_not_regular_file');
    accessSync(realBinary, constants.X_OK);
    this.outbox = outbox; this.binary = realBinary; this.threadId = threadId; this.log = log; this.queueRunner = queueRunner;
    this.sessionLookup = sessionLookup;
    this.prepareReportMedia = prepareReportMedia;
    this.recentRepliesEnabled = recentRepliesEnabled;
    this.onReportSent = onReportSent; this.onDeliveryPending = onDeliveryPending;
    this.reportStates = join(outbox, '.relay-state', 'reports');
    this.messageStates = join(outbox, '.relay-state', 'queued-messages');
    [outbox, join(outbox, '.relay-state'), this.reportStates, this.messageStates].forEach(ensurePrivateDirectory);
    const identityPath = join(outbox, '.relay-state', 'identity.json');
    if (existsSync(identityPath)) {
      const identity = readPrivateJson(identityPath);
      if (identity.version !== 1 || identity.sessionId !== threadId || identity.binary !== realBinary) throw new Error('turn_relay_identity_mismatch');
    } else writePrivateJson(identityPath, { version: 1, sessionId: threadId, binary: realBinary });
    this.polling = false;
    this.finishedReports = new Set();
  }

  /** Resolve only an explicitly registered chat, while preserving the original root-only default. */
  reportSession(sessionId, report) {
    const session = this.sessionLookup?.(sessionId, report);
    if (session && typeof session === 'object' && session.sessionId === sessionId) return session;
    return sessionId === this.threadId ? { sessionId, title: '原聊天' } : undefined;
  }

  /** Retry only local route bookkeeping after a confirmed send, never the external message. */
  async applySentDelivery(report, ack, statePath, recovered = true) {
    if (!this.onReportSent || ack.replyDeliveryApplied === true) return true;
    try {
      const session = ack.deliverySession ?? this.reportSession(report.sessionId, report);
      await this.onReportSent({ report, session, messageId: ack.messageId, sentAtMs: ack.sentAtMs,
        deliveryContext: ack.deliveryContext, recovered });
      writePrivateJson(statePath, { ...ack, replyDeliveryApplied: true, replyDeliveryAppliedAtMs: Date.now() });
      return true;
    } catch {
      this.onDeliveryPending?.({ eventId: report.eventId, sentAtMs: ack.sentAtMs });
      this.log('report_delivery_route_pending', { eventId: report.eventId });
      return false;
    }
  }

  /** Restore confirmed local effects before accepting new owner messages, without sending anything. */
  async reconcileSentReports() {
    if (!this.onReportSent) return;
    for (const name of readdirSync(this.reportStates).filter(name => EVENT_ID.test(name.slice(0, -5)) && name.endsWith('.json'))) {
      try {
        const ack = readPrivateJson(join(this.reportStates, name));
        const report = validateTurnReport(readPrivateJson(join(this.outbox, name)), name.slice(0, -5), ack.sessionId);
        if (ack.version !== 1 || ack.eventId !== report.eventId) continue;
        if (ack.status === 'sent') await this.applySentDelivery(report, ack, join(this.reportStates, name));
        else if (['sending', 'unknown'].includes(ack.status)) this.onDeliveryPending?.({ eventId: report.eventId, sentAtMs: ack.attemptedAtMs });
      } catch { this.log('report_delivery_reconcile_failed', { eventId: name.slice(0, -5) }); }
    }
  }

  /** Send validated reports with at most three attempts; acknowledge only confirmed API success. */
  async pollReports(sendCard, now = Date.now(), resumeAtMs = 0) {
    if (this.polling) return;
    this.polling = true;
    try {
      const names = readdirSync(this.outbox).filter((name) => name.endsWith('.json') && EVENT_ID.test(name.slice(0, -5)) && !this.finishedReports.has(name)).slice(0, 1000);
      for (const name of names) {
        const eventId = name.slice(0, -5);
        const statePath = join(this.reportStates, name);
        let report;
        try {
          const value = readPrivateJson(join(this.outbox, name));
          report = validateTurnReport(value, eventId, value.sessionId, now);
        } catch { this.log('turn_report_rejected', { eventId }); continue; }
        let ack;
        try {
          ack = existsSync(statePath) ? readPrivateJson(statePath) : { version: 1, eventId, sessionId: report.sessionId, attempts: 0, status: 'pending' };
        } catch { this.log('turn_report_invalid_ack_state', { eventId }); continue; }
        if (ack.version !== 1 || ack.eventId !== eventId || ack.sessionId !== report.sessionId ||
            !Number.isInteger(ack.attempts) || ack.attempts < 0 || ack.attempts > 3 ||
            !['pending', 'sending', 'retry_wait', 'sent', 'failed', 'rejected', 'unknown'].includes(ack.status)) {
          this.log('turn_report_invalid_ack_state', { eventId }); continue;
        }
        if (ack.status === 'sent') {
          if (await this.applySentDelivery(report, ack, statePath)) this.finishedReports.add(name);
          continue;
        }
        if (report.createdAtMs < resumeAtMs && ['pending', 'retry_wait'].includes(ack.status)) {
          writePrivateJson(statePath, { ...ack, status: 'rejected', reason: 'before_connection_resumed' });
          this.finishedReports.add(name);
          continue;
        }
        if (['failed', 'rejected', 'unknown'].includes(ack.status)) {
          if (ack.status === 'unknown') this.onDeliveryPending?.({ eventId, sentAtMs: ack.attemptedAtMs });
          this.finishedReports.add(name); continue;
        }
        if (ack.status === 'sending') {
          writePrivateJson(statePath, { ...ack, status: 'unknown' });
          this.onDeliveryPending?.({ eventId, sentAtMs: ack.attemptedAtMs });
          this.log('turn_report_delivery_unknown', { eventId }); continue;
        }
        if (ack.nextAttemptAtMs > now) continue;
        let session;
        try { session = this.reportSession(report.sessionId, report); }
        catch { this.log('turn_report_registry_unavailable', { eventId }); continue; }
        if (!session) {
          writePrivateJson(statePath, { ...ack, status: 'rejected' }); this.log('turn_report_rejected', { eventId }); continue;
        }
        let media;
        if (this.prepareReportMedia) {
          try { media = await this.prepareReportMedia(report); }
          catch {
            media = { elements: [], notices: ['图片准备失败，本轮文字仍保留。'], bodyText: report.lastAssistantMessage };
            this.log('turn_report_media_failed', { eventId });
          }
        }
        // Media work can span a later manual choice; the intent time must describe the actual send.
        ack = { ...ack, status: 'sending', attempts: ack.attempts + 1, attemptedAtMs: Date.now() };
        writePrivateJson(statePath, ack);
        let messageId;
        try {
          // Stable UUID also helps the platform deduplicate bounded transport retries.
          const stableUuid = `${eventId.slice(0, 8)}-${eventId.slice(8, 12)}-${eventId.slice(12, 16)}-${eventId.slice(16, 20)}-${eventId.slice(20, 32)}`;
          messageId = await sendCard(turnReportCard(report, { ...session, recentRepliesEnabled: this.recentRepliesEnabled }, media), stableUuid, report);
        } catch (error) {
          if (ambiguousDelivery(error)) {
            writePrivateJson(statePath, { ...ack, status: 'unknown' });
            this.onDeliveryPending?.({ eventId, sentAtMs: ack.attemptedAtMs });
            this.log('turn_report_delivery_unknown', { eventId }); continue;
          }
          const delay = RETRY_DELAYS_MS[ack.attempts - 1];
          writePrivateJson(statePath, { ...ack, status: delay === undefined ? 'failed' : 'retry_wait', nextAttemptAtMs: delay === undefined ? null : now + delay });
          this.log(delay === undefined ? 'turn_report_delivery_failed' : 'turn_report_retry_scheduled', { eventId, attempts: ack.attempts }); continue;
        }
        const deliveryContext = messageId && typeof messageId === 'object' ? messageId.deliveryContext : undefined;
        if (messageId && typeof messageId === 'object') messageId = messageId.messageId;
        if (typeof messageId !== 'string' || !messageId) {
          this.onDeliveryPending?.({ eventId, sentAtMs: ack.attemptedAtMs });
          writePrivateJson(statePath, { ...ack, status: 'unknown' }); this.log('turn_report_delivery_unknown', { eventId }); continue;
        }
        try {
          const sent = { ...ack, status: 'sent', messageId, sentAtMs: Date.now(),
            ...(this.onReportSent ? { deliverySession: { sessionId: session.sessionId, title: session.title, cwd: session.cwd }, deliveryContext } : {}) };
          writePrivateJson(statePath, sent);
          if (await this.applySentDelivery(report, sent, statePath, false)) this.finishedReports.add(name);
          this.log('turn_report_sent', { eventId, message: label(messageId), attempts: ack.attempts });
        } catch {
          this.onDeliveryPending?.({ eventId, sentAtMs: Date.now() });
          this.log('turn_report_ack_write_failed', { eventId });
        }
      }
    } finally { this.polling = false; }
  }

  /** Persist intent before queueing once; ambiguous/crashed attempts are never automatically replayed. */
  async queueFollowup(messageId, text) {
    const instruction = followupBody(text);
    if (instruction.status !== 'ready') return instruction;
    if (typeof messageId !== 'string' || !messageId || messageId.length > 256) return { status: 'invalid_message_id' };
    const hash = createHash('sha256').update(messageId).digest('hex');
    const path = join(this.messageStates, `${hash}.json`);
    if (existsSync(path)) {
      const previous = readPrivateJson(path);
      if (previous.messageId !== messageId || previous.sessionId !== this.threadId) throw new Error('turn_relay_message_identity_mismatch');
      this.log('followup_duplicate_ignored', { message: label(messageId), previousStatus: previous.status });
      return { status: 'duplicate' };
    }
    const attempt = { version: 1, messageId, sessionId: this.threadId, status: 'attempting', createdAtMs: Date.now() };
    // Exclusive creation claims the message before any CLI side effect, even if two listeners race.
    try { writeFileSync(path, `${JSON.stringify(attempt, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error?.code === 'EEXIST') return { status: 'duplicate' }; throw error; }
    let result;
    try { result = await this.queueRunner(this.binary, this.threadId, instruction.body); }
    catch { result = { status: 'unknown' }; }
    if (!['queued', 'failed', 'unknown'].includes(result?.status)) result = { status: 'unknown' };
    writePrivateJson(path, { ...attempt, status: result.status, finishedAtMs: Date.now() });
    this.log(result.status === 'queued' ? 'followup_queued' : 'followup_queue_unconfirmed', { message: label(messageId), status: result.status });
    return result;
  }
}
