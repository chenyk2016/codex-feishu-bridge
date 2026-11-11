/** Durable owner-requested desktop-chat creation, coordinated through the existing root chat. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { label, readPrivateJson, writePrivateJson } from './probe-core.mjs';
import { runCodexQueue } from './turn-relay.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const CHAT_READY_WAIT_MS = 30000;
export const INITIAL_CHAT_PROMPT = '这是本人通过飞书明确请求创建的聊天。请仅回复“聊天已准备好”，不要调用工具、写文件或执行任务。入口会在登记聊天后另行发送第一条任务。';

/** Reject shared or redirected state folders before accessing private request bodies. */
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('chat_management_requires_private_directory');
}

/** Claim an immutable local record before an irreversible external operation. */
function createExclusive(path, value) {
  try { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); return true; }
  catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
}

/** Require an explicit title and task, avoiding accidental creation from unrelated messages. */
export function parseCreationDetails(text) {
  if (typeof text !== 'string') return null;
  const match = /^标题[：:][ \t]*([^\r\n]+)\r?\n任务[：:][ \t]*([\s\S]+)$/u.exec(text.trim());
  if (!match) return null;
  const title = match[1].trim(), firstTask = match[2].trim();
  if (!title || [...title].length > 80 || !firstTask || [...firstTask].length > 4000 || /[\x00-\x1f\x7f]/u.test(title) || firstTask.includes('\0')) return null;
  return { title, firstTask };
}

/** Validate the immutable request shared by the bridge and its root-chat helper. */
export function readCreationRequest(directory, requestId, now = Date.now()) {
  if (!UUID.test(requestId)) throw new Error('chat_creation_invalid_request_id');
  const request = readPrivateJson(join(directory, 'requests', `${requestId}.json`));
  if (request.version !== 1 || request.kind !== 'owner_create_chat' || request.requestId !== requestId ||
      !ID.test(request.controlThreadId ?? '') || !isAbsolute(request.cwd ?? '') ||
      typeof request.title !== 'string' || !request.title || [...request.title].length > 80 ||
      typeof request.firstTask !== 'string' || !request.firstTask || [...request.firstTask].length > 4000 ||
      !Number.isSafeInteger(request.createdAtMs) || !Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs <= request.createdAtMs ||
      request.createdAtMs > now + 30000 || request.expiresAtMs - request.createdAtMs > 3600000 ||
      typeof request.selectionSnapshot?.sessionId !== 'string' || typeof request.selectionSnapshot?.selectionVersion !== 'string' ||
      !request.selectionSnapshot.selectionVersion || request.selectionSnapshot.selectionVersion.length > 128) {
    throw new Error('chat_creation_invalid_request');
  }
  return request;
}

/** Grant creation once, only to the original desktop control chat; ambiguous claims never reopen. */
export function claimCreation(directory, requestId, controlThreadId, now = Date.now()) {
  const request = readCreationRequest(directory, requestId, now);
  if (request.controlThreadId !== controlThreadId) throw new Error('chat_creation_wrong_control_chat');
  if (request.expiresAtMs <= now) return { status: 'expired', requestId };
  const resultPath = join(directory, 'results', `${requestId}.json`);
  if (existsSync(resultPath)) return { status: 'already_completed', requestId };
  const claimed = createExclusive(join(directory, 'claims', `${requestId}.json`), { version: 1, requestId, controlThreadId, claimedAtMs: now });
  if (!claimed) return { status: 'already_claimed_do_not_create_again', requestId };
  return { status: 'ready_to_create_once', requestId, title: request.title, cwd: request.cwd, initialPrompt: INITIAL_CHAT_PROMPT };
}

/** Persist the actual desktop result idempotently; a conflicting result is never substituted. */
export function completeCreation(directory, requestId, controlThreadId, outcome, now = Date.now()) {
  const request = readCreationRequest(directory, requestId, now);
  if (request.controlThreadId !== controlThreadId) throw new Error('chat_creation_wrong_control_chat');
  const claim = readPrivateJson(join(directory, 'claims', `${requestId}.json`));
  if (claim.requestId !== requestId || claim.controlThreadId !== controlThreadId) throw new Error('chat_creation_missing_claim');
  if (!['created', 'failed_before_create', 'create_unknown'].includes(outcome.status) ||
      (outcome.status === 'created' && (!UUID.test(outcome.sessionId ?? '') || outcome.sessionId === controlThreadId))) throw new Error('chat_creation_invalid_result');
  const result = { version: 1, requestId, status: outcome.status, ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}), completedAtMs: now };
  const path = join(directory, 'results', `${requestId}.json`);
  if (!createExclusive(path, result)) {
    const previous = readPrivateJson(path);
    if (previous.requestId !== requestId || previous.status !== result.status || previous.sessionId !== result.sessionId) throw new Error('chat_creation_conflicting_result');
  }
  return { status: 'result_saved', requestId, outcome: result.status, ...(result.sessionId ? { sessionId: result.sessionId } : {}) };
}

/** Keep title/task input and control/first-task dispatches separate, durable and once-only. */
export class ChatManagement {
  /** Bind one fixed control chat and private state; external work is injected for offline checks. */
  constructor({ directory, binary, controlThreadId, cwd, router, log = () => {}, queueRunner = runCodexQueue, clock = Date.now }) {
    if (!isAbsolute(directory) || !ID.test(controlThreadId) || !isAbsolute(cwd)) throw new Error('chat_management_invalid_configuration');
    this.directory = directory; this.binary = binary; this.controlThreadId = controlThreadId; this.cwd = cwd;
    this.router = router; this.log = log; this.queueRunner = queueRunner; this.polling = false; this.finishedResults = new Set();
    if (typeof clock !== 'function') throw new Error('chat_management_invalid_clock');
    this.clock = clock;
    [directory, ...['requests', 'claims', 'results', 'progress', 'submitted', 'first-tasks', 'notices'].map((part) => join(directory, part))].forEach(privateDirectory);
    this.draftPath = join(directory, 'draft.json');
  }

  /** Open a ten-minute explicit input step; clicking twice preserves the same draft request. */
  begin(selectionSnapshot, now = Date.now()) {
    const previous = existsSync(this.draftPath) ? readPrivateJson(this.draftPath) : null;
    const draft = previous?.status === 'draft' && previous.expiresAtMs > now ? previous
      : { version: 1, requestId: randomUUID(), status: 'draft', selectionSnapshot, createdAtMs: now, expiresAtMs: now + 600000 };
    writePrivateJson(this.draftPath, draft);
    return { status: 'creation_details_required', text: '请在一条消息中填写：\n标题：新聊天的名称\n任务：要做的第一件事\n\n默认使用当前项目。发送“取消新建”可退出；提交后会创建桌面聊天。' };
  }

  /** An explicit chat switch exits only an unsubmitted input step, never a queued creation. */
  cancelDraft() {
    if (!existsSync(this.draftPath)) return false;
    const draft = readPrivateJson(this.draftPath);
    if (draft.status !== 'draft') return false;
    writePrivateJson(this.draftPath, { ...draft, status: 'cancelled' });
    return true;
  }

  /** Consume only a live explicit draft; ordinary chat messages outside that step are untouched. */
  async consumeDetails(messageId, text, createTime, now = Date.now()) {
    if (typeof text !== 'string') return null;
    const submittedPath = typeof messageId === 'string' && messageId ? join(this.directory, 'submitted', `${createHash('sha256').update(messageId).digest('hex')}.json`) : null;
    if (submittedPath && existsSync(submittedPath)) return { status: 'creation_duplicate', text: '这次新建请求已经提交，没有重复创建或执行。' };
    if (text.trim() === '取消新建') {
      const currentDraft = existsSync(this.draftPath) ? readPrivateJson(this.draftPath) : null;
      if (typeof createTime !== 'string' || !/^\d{10,16}$/.test(createTime) || !Number.isSafeInteger(Number(createTime)) || Number(createTime) < Math.max(this.router.activatedAtMs, currentDraft?.createdAtMs ?? 0) || Number(createTime) > now + 30000) {
        return { status: 'creation_invalid_message', text: '消息时间无法核实，没有更改新建请求。' };
      }
      if (currentDraft) writePrivateJson(this.draftPath, { ...currentDraft, status: 'cancelled' });
      return { status: 'creation_cancelled', text: '已取消新建，没有创建聊天。' };
    }
    if (!existsSync(this.draftPath)) return null;
    const draft = readPrivateJson(this.draftPath);
    if (draft.status !== 'draft') return null;
    if (draft.expiresAtMs <= now) {
      writePrivateJson(this.draftPath, { ...draft, status: 'expired' });
      return { status: 'creation_draft_expired', text: '新建输入已过期，这条消息没有执行。请重新点“新建聊天”。' };
    }
    if (typeof createTime !== 'string' || !/^\d{10,16}$/.test(createTime) || !Number.isSafeInteger(Number(createTime)) || Number(createTime) < Math.max(this.router.activatedAtMs, draft.createdAtMs ?? 0) || Number(createTime) > now + 30000 ||
        typeof messageId !== 'string' || !messageId || messageId.length > 256) return { status: 'creation_invalid_message', text: '消息时间或身份无法核实，本次没有创建聊天。' };
    const details = parseCreationDetails(text);
    if (!details) return { status: 'creation_invalid_details', text: '请按“标题：…\n任务：…”填写。标题最多80字，任务最多4000字；也可以发送“取消新建”。这条消息没有作为任务执行。' };
    const request = { version: 1, kind: 'owner_create_chat', requestId: draft.requestId, controlThreadId: this.controlThreadId,
      cwd: this.cwd, ...details, selectionSnapshot: draft.selectionSnapshot, sourceMessageId: messageId, createdAtMs: now, expiresAtMs: now + 3600000 };
    const requestPath = join(this.directory, 'requests', `${request.requestId}.json`);
    if (!createExclusive(requestPath, request)) return { status: 'creation_duplicate', text: '这次新建请求已经提交，没有重复创建。' };
    writePrivateJson(submittedPath, { version: 1, requestId: request.requestId, messageId });
    writePrivateJson(this.draftPath, { ...draft, status: 'submitted' });
    const path = join(this.directory, 'progress', `${request.requestId}.json`);
    const progress = { version: 1, requestId: request.requestId, status: 'control_dispatching', createdAtMs: now };
    writePrivateJson(path, progress);
    let result;
    try { result = await this.queueRunner(this.binary, this.controlThreadId, this.controlPrompt(request)); }
    catch { result = { status: 'unknown' }; }
    // A fast control turn may already have completed while the queue acknowledgement was pending.
    const latest = readPrivateJson(path);
    if (latest.requestId !== request.requestId) throw new Error('chat_creation_progress_identity_changed');
    if (latest.status === 'control_dispatching') {
      writePrivateJson(path, { ...latest, status: result.status === 'queued' ? 'waiting_for_creation' : 'control_dispatch_unknown', dispatchStatus: result.status });
    }
    this.log('chat_creation_requested', { requestId: request.requestId, status: result.status });
    if (latest.status !== 'control_dispatching') return { status: 'creation_already_progressing', text: `新建「${request.title}」的请求已在处理中，请查看创建结果消息。` };
    return { status: result.status === 'queued' ? 'creation_queued' : 'creation_dispatch_unconfirmed',
      text: result.status === 'queued' ? `已收到新建「${request.title}」的请求，等待控制聊天处理。创建后会另行通知，不会重复创建。`
        : '新建请求已保存，但尚未确认是否送达控制聊天。为避免重复，不会自动重试；请先核对。' };
  }

  /** Tell the existing root chat exactly how to use the supported desktop creation tool. */
  controlPrompt(request) {
    const helper = fileURLToPath(new URL('./chat-control.mjs', import.meta.url));
    return `这是已配对本人通过飞书明确提交的新建桌面聊天请求，编号 ${request.requestId}。请处理这项创建请求。\n` +
      `1. 用 exec_command 运行 node 的参数数组等价命令：node ${JSON.stringify(helper)} claim --directory ${JSON.stringify(this.directory)} --request ${request.requestId}。不要打印请求文件正文或首条任务。\n` +
      '2. 只有返回 status=ready_to_create_once 时，调用官方 list_projects，按返回 cwd 找到本地项目；再调用官方 create_thread，title和prompt严格用claim返回的title和initialPrompt，target使用该本地项目，不建worktree，不改模型。只初始化，不执行首条任务。若项目不存在，报告 failed_before_create，不自行替换目录。\n' +
      '3. 必须取得官方返回的真实 threadId 后，运行同一helper的 complete --directory 同一路径 --request 同一编号 --thread 真实threadId。若只有clientThreadId或创建结果不确定，使用 fail --outcome create_unknown，不得重复创建。若确定创建前失败，使用 fail --outcome failed_before_create。\n' +
      '4. 若claim返回already_claimed/已完成/过期，停止创建。complete同一真实ID可幂等重试，不能改成别的ID。入口会自动登记并仅投递一次首任务，再向本人飞书回报。不要在本聊天执行首任务，不要自行重试新建。\n' +
      '创建后简短回报结果，并按应用要求给出created-thread指令；不扩展审批权限或自启动设置。';
  }

  /** Register confirmed new chats before their first task; crashes and unknown dispatches never replay. */
  async pollResults(sendText, resumeAtMs = 0) {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const name of readdirSync(join(this.directory, 'results')).filter((name) => UUID.test(name.slice(0, -5)) && name.endsWith('.json') && !this.finishedResults.has(name)).slice(0, 1000)) {
        const requestId = name.slice(0, -5), request = readCreationRequest(this.directory, requestId);
        const result = readPrivateJson(join(this.directory, 'results', name));
        if (result.version !== 1 || result.requestId !== requestId || !['created', 'failed_before_create', 'create_unknown'].includes(result.status)) throw new Error('chat_creation_invalid_result');
        const path = join(this.directory, 'progress', name);
        let progress = existsSync(path) ? readPrivateJson(path) : { version: 1, requestId };
        if (progress.notificationStatus) { this.finishedResults.add(name); continue; }
        if (request.createdAtMs < resumeAtMs) {
          if (result.status === 'created') {
            if (!UUID.test(result.sessionId ?? '') || result.sessionId === this.controlThreadId) throw new Error('chat_creation_invalid_result');
            this.router.registerSession({ sessionId: result.sessionId, title: request.title, cwd: request.cwd }, { select: false });
          }
          writePrivateJson(path, { ...progress, notificationStatus: 'skipped_after_pause' });
          this.finishedResults.add(name);
          continue;
        }
        if (result.status !== 'created') {
          if (!createExclusive(join(this.directory, 'notices', name), { version: 1, requestId, attemptedAtMs: Date.now() })) continue;
          progress = { ...progress, status: result.status, notificationStatus: 'sending' }; writePrivateJson(path, progress);
          await this.notifyOnce(sendText, request, progress, path, result.status === 'create_unknown' ? '创建结果暂不确定，需要先核对桌面聊天；本次不会再次创建。' : '创建未能开始，没有执行第一条任务。');
          continue;
        }
        if (!UUID.test(result.sessionId ?? '') || result.sessionId === this.controlThreadId) throw new Error('chat_creation_invalid_result');
        const registration = this.router.registerSession({ sessionId: result.sessionId, title: request.title, cwd: request.cwd }, { expectedSelection: request.selectionSnapshot, select: true });
        if (progress.autoSelected === undefined) {
          progress = { ...progress, sessionId: result.sessionId, autoSelected: registration.selected };
          writePrivateJson(path, progress);
        }
        if (!['first_task_queued', 'first_task_unknown', 'first_task_failed', 'first_task_dispatching'].includes(progress.status)) {
          const availability = this.router.replyStatus?.(result.sessionId) ?? 'ready';
          if (availability !== 'ready') {
            const startedAtMs = progress.waitForChatReadyAtMs ?? this.clock();
            if (availability !== 'session_archived' && this.clock() - startedAtMs < CHAT_READY_WAIT_MS) {
              writePrivateJson(path, { ...progress, status: 'waiting_for_chat_ready', waitForChatReadyAtMs: startedAtMs });
              continue;
            }
            progress = { ...progress, status: 'first_task_failed', failureReason: availability === 'session_archived' ? 'chat_archived' : 'chat_not_ready', waitForChatReadyAtMs: startedAtMs };
            writePrivateJson(path, progress);
          } else {
            // An immutable cross-process claim also covers accidentally overlapping listeners.
            if (!createExclusive(join(this.directory, 'first-tasks', name), { version: 1, requestId, sessionId: result.sessionId, attemptedAtMs: Date.now() })) continue;
            progress = { ...progress, status: 'first_task_dispatching', sessionId: result.sessionId };
            writePrivateJson(path, progress);
            let queued;
            try { queued = await this.queueRunner(this.binary, result.sessionId, request.firstTask); } catch { queued = { status: 'unknown' }; }
            progress = { ...progress, status: queued.status === 'queued' ? 'first_task_queued' : queued.status === 'failed' ? 'first_task_failed' : 'first_task_unknown' };
            writePrivateJson(path, progress);
            this.log('chat_created_first_task_dispatch', { requestId, session: label(result.sessionId), status: progress.status });
          }
        } else if (progress.status === 'first_task_dispatching') {
          progress = { ...progress, status: 'first_task_unknown' }; writePrivateJson(path, progress);
        }
        if (!createExclusive(join(this.directory, 'notices', name), { version: 1, requestId, attemptedAtMs: Date.now() })) continue;
        progress = { ...progress, notificationStatus: 'sending' }; writePrivateJson(path, progress);
        const taskStatus = progress.status === 'first_task_queued' ? '第一条任务已加入新聊天，执行结果会另行汇报。'
          : progress.failureReason === 'chat_archived' ? '新聊天已归档，第一条任务未投递。请先恢复该聊天再继续。'
          : progress.failureReason === 'chat_not_ready' ? '新聊天尚未准备好，第一条任务未投递。请在桌面打开该聊天后再发送。'
          : progress.status === 'first_task_failed' ? '第一条任务未能加入，请先核对后再发送；没有重新创建聊天。' : '第一条任务是否送达暂不确定，请先核对，避免重复执行。';
        const selectedNow = this.router.getCurrentSession().sessionId === result.sessionId;
        await this.notifyOnce(sendText, request, progress, path, `已创建「${request.title}」${selectedNow ? '，当前回复目标为该聊天' : '；保留当前回复目标，可从“切换聊天”进入新聊天'}。\n${taskStatus}`);
      }
    } finally { this.polling = false; }
  }

  /** Never resend an uncertain creation notification; task dispatch has its own independent state. */
  async notifyOnce(sendText, request, progress, path, text) {
    try {
      const messageId = await sendText(text);
      writePrivateJson(path, { ...progress, notificationStatus: messageId ? 'sent' : 'unknown' });
    } catch { writePrivateJson(path, { ...progress, notificationStatus: 'unknown' }); }
    this.log('chat_creation_result_notified', { requestId: request.requestId, status: progress.status });
  }
}
