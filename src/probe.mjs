#!/usr/bin/env node
import { createNavigationDelivery } from './navigation-delivery.mjs';
/** Feishu probe with an optional file queue limited to two fixed harmless Codex approvals. */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, resolve, join } from 'node:path';
import { consumeDecision, label, loadConfig, readPrivateJson, testCard, writePrivateJson } from './probe-core.mjs';
import { BridgeQueue } from './bridge-queue.mjs';
import { TurnRelay, extractMessageText, runCodexQueue } from './turn-relay.mjs';
import { SessionRouter, loadSessionCatalog } from './session-router.mjs';
import { ChatManagement } from './chat-management.mjs';
import { uploadImage, downloadMessageImage } from './media-transport.mjs';
import { createIncomingImageHandler, extractIncomingImageKeys } from './incoming-images.mjs';
import { createMermaidRenderer } from './mermaid-renderer.mjs';
import { createReportMediaPreparer } from './report-media.mjs';
import { createChatMetadataLookup } from './chat-metadata.mjs';
import { createReportSessionLookup } from './report-scope.mjs';
import { reportMediaRoots } from './report-media-roots.mjs';
import { RecentChats } from './recent-chats.mjs';
import { collectRecentSeeds } from './recent-seed.mjs';
import { HEALTH_INTERVAL_MS, ServiceRuntime, bridgeExpiresAtMs, validateLifecycleOptions } from './service-runtime.mjs';

/** Emit only bounded metadata; SDK errors and raw event payloads are never printed. */
function log(event, details = {}) { process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`); }

/** Reduce a network/API error to non-sensitive diagnostic codes. */
function errorCode(error) {
  const code = error?.response?.data?.code ?? error?.code;
  return { code: typeof code === 'number' || (typeof code === 'string' && /^[A-Z0-9_:-]{1,50}$/.test(code)) ? code : 'unclassified',
    httpStatus: typeof error?.response?.status === 'number' ? error.response.status : undefined };
}

/** Parse a narrow CLI; reject unknown flags before reading any credentials. */
function parseArgs(args) {
  const out = { command: 'listen', duration: 900, sendCardOnPair: false, serviceMode: false, durationExplicit: false };
  if (args[0] && !args[0].startsWith('--')) out.command = args.shift();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') out.command = 'help';
    else if (flag === '--send-card-on-pair') out.sendCardOnPair = true;
    else if (flag === '--service') out.serviceMode = true;
    else if (['--credentials', '--state', '--duration', '--bridge-dir', '--turn-outbox', '--codex-bin', '--codex-thread', '--session-catalog', '--chat-management-dir', '--health-file', '--media-dir', '--media-allowed-root', '--report-policy', '--chat-metadata-db', '--recent-replies-dir'].includes(flag) && args[i + 1]) {
      const value = args[++i];
      if (flag === '--credentials') out.credentials = resolve(value);
      if (flag === '--state') out.state = resolve(value);
      if (flag === '--duration') { out.duration = Number(value); out.durationExplicit = true; }
      if (flag === '--bridge-dir') out.bridgeDir = resolve(value);
      if (flag === '--turn-outbox') out.turnOutbox = resolve(value);
      if (flag === '--codex-bin') { if (!isAbsolute(value)) throw new Error('codex_bin_requires_absolute_path'); out.codexBin = value; }
      if (flag === '--codex-thread') out.codexThread = value;
      if (flag === '--session-catalog') out.sessionCatalog = resolve(value);
      if (flag === '--chat-management-dir') out.chatManagementDir = resolve(value);
      if (flag === '--report-policy') out.reportPolicy = resolve(value);
      if (flag === '--chat-metadata-db') out.chatMetadataDb = resolve(value);
      if (flag === '--recent-replies-dir') out.recentRepliesDir = resolve(value);
      if (flag === '--media-dir') out.mediaDir = resolve(value);
      if (flag === '--media-allowed-root') { if (!isAbsolute(value)) throw new Error('media_root_requires_absolute_path'); (out.mediaAllowedRoots ??= []).push(resolve(value)); }
      if (flag === '--health-file') { if (!isAbsolute(value)) throw new Error('health_file_requires_absolute_path'); out.healthFile = resolve(value); }
    } else throw new Error('unknown_or_incomplete_argument');
  }
  if (!['listen', 'check', 'help'].includes(out.command)) throw new Error('unknown_command');
  validateLifecycleOptions(out);
  if (out.command === 'listen' && !out.state) throw new Error('explicit_state_path_required');
  if ([out.turnOutbox, out.codexBin, out.codexThread].some(Boolean) && ![out.turnOutbox, out.codexBin, out.codexThread].every(Boolean)) {
    throw new Error('turn_relay_requires_all_three_flags');
  }
  if (out.sessionCatalog && !out.turnOutbox) throw new Error('session_catalog_requires_turn_relay_flags');
  if (out.chatManagementDir && !out.sessionCatalog) throw new Error('chat_management_requires_session_catalog');
  if (out.chatMetadataDb && !out.sessionCatalog) throw new Error('metadata_requires_session_catalog');
  if (out.reportPolicy && !out.chatMetadataDb) throw new Error('report_policy_requires_metadata_database');
  if (out.mediaDir && !out.sessionCatalog) throw new Error('media_requires_session_catalog');
  if (out.mediaAllowedRoots && !out.mediaDir) throw new Error('media_roots_require_media_directory');
  if (out.recentRepliesDir && (!out.sessionCatalog || !out.chatMetadataDb)) throw new Error('recent_replies_require_catalog_and_metadata');
  return out;
}

/** Connect, pair exactly one private-chat owner, and handle only explicit test cards. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write('Usage: node probe.mjs check|listen --credentials /private/path/app.json --state /private/path/probe.state.json [--send-card-on-pair] [--duration 900 | --service --health-file /private/path/health.json] [--bridge-dir /private/path/bridge] [--turn-outbox /private/path/outbox --codex-bin /absolute/official/codex --codex-thread fixed-chat-id] [--session-catalog /private/path/catalog.json] [--chat-management-dir /private/path/creation] [--media-dir /private/path/media --media-allowed-root /absolute/image/output] [--chat-metadata-db /absolute/codex-state.sqlite --report-policy /private/path/policy.json] [--recent-replies-dir /private/path/recent-replies]\nCredentials may instead use FEISHU_APP_ID / FEISHU_APP_SECRET. Local stdin commands outside service mode: status, card, menu, quit.\n');
    return;
  }
  const settingsPath = options.serviceMode ? process.env.CODEX_FEISHU_CONNECTION_SETTINGS : undefined;
  const readSettings = () => {
    if (!settingsPath) return { enabled: true, resumeAtMs: 0 };
    try { return readPrivateJson(settingsPath); }
    catch (error) {
      if (error.code === 'ENOENT') return { enabled: true, resumeAtMs: 0 };
      throw error;
    }
  };
  const startupSettings = readSettings();
  if (startupSettings.enabled !== true || !Number.isSafeInteger(startupSettings.resumeAtMs) || startupSettings.resumeAtMs < 0) return;
  const { resumeAtMs } = startupSettings;
  function connectionAllowed() {
    try {
      const settings = readSettings();
      return !closing && settings.enabled === true && settings.resumeAtMs === resumeAtMs;
    } catch { return false; }
  }
  function requireConnection() {
    if (!connectionAllowed()) throw new Error('connection_paused');
  }
  const queueRunner = (...args) => {
    requireConnection();
    return runCodexQueue(...args);
  };
  const config = loadConfig(process.env, options.credentials);
  const lark = await import('@larksuiteoapi/node-sdk');
  if (options.command === 'check') { log('configuration_valid', { sdkVersion: '1.76.0', networkUsed: false, messagesSent: 0 }); return; }

  const previous = existsSync(options.state) ? readPrivateJson(options.state) : {};
  if (previous.version !== undefined && previous.version !== 1) throw new Error('unsupported_state_version');
  if (previous.appLabel && previous.appLabel !== label(config.appId)) throw new Error('state_belongs_to_another_app');
  if (previous.owner && (typeof previous.owner.openId !== 'string' || typeof previous.owner.chatId !== 'string')) throw new Error('invalid_owner_state');
  if (config.ownerOpenId && previous.owner && config.ownerOpenId !== previous.owner.openId) throw new Error('owner_configuration_mismatch');
  const state = { version: 1, appLabel: label(config.appId), runId: randomUUID(), owner: previous.owner ?? null, requests: {} };
  const pairCode = `probe-${randomBytes(5).toString('hex')}`;
  const seenMessages = new Set();
  let sending = false;
  let closing = false;
  let connected = false;
  let inboundMessages = 0;
  let acceptedDecisions = 0;
  let sentMessages = 0;
  let ws;
  let input;
  let timeout;
  let connectTimeout;
  let bridgeTimer;
  let turnTimer;
  let managementTimer;
  let healthTimer;
  let pollingBridge = false;
  const catalog = options.sessionCatalog ? loadSessionCatalog(options.sessionCatalog) : null;
  if (catalog && catalog.defaultSessionId !== options.codexThread) throw new Error('catalog_default_must_match_root_chat');
  const bridge = options.bridgeDir ? new BridgeQueue(options.bridgeDir, state.runId, bridgeExpiresAtMs(options), catalog) : null;
  // SDK client is initialized before these deferred upload callbacks can run.
  const lookupMetadata = options.chatMetadataDb ? createChatMetadataLookup({ database: options.chatMetadataDb }) : null;
  const staticLookup = lookupMetadata && catalog ? createReportSessionLookup({ router: {
    refreshCatalog() {}, getSession: id => catalog.sessions.find(session => session.sessionId === id),
  }, lookupMetadata, policyPath: options.reportPolicy, log }) : undefined;
  const recentChats = options.recentRepliesDir ? new RecentChats({ directory: options.recentRepliesDir,
    initialSession: (({ sessionId, title, cwd }) => ({ sessionId, title, cwd }))(catalog.sessions.find(session => session.sessionId === options.codexThread)),
    seedDeliveries: existsSync(join(options.recentRepliesDir, 'recent-chats.json')) ? [] : collectRecentSeeds({ outbox: options.turnOutbox, sessionLookup: staticLookup, log }), limit: 10 }) : null;
  const sessionRouter = catalog ? new SessionRouter({ catalog, catalogPath: options.sessionCatalog, storageDirectory: `${options.state}.routes`, binary: options.codexBin, queueRunner, log,
    ...(lookupMetadata ? { replyStatusLookup: id => {
      const metadata = lookupMetadata(id);
      return metadata?.isMain ? metadata.isArchived ? 'session_archived' : 'ready' : 'target_unavailable';
    } } : {}),
    ...(recentChats ? { recentChats } : {}) }) : null;
  if (recentChats) for (const entry of recentChats.getState().entries) {
    if (entry.latestDelivery) sessionRouter.bindCard(entry.latestDelivery.messageId, entry.sessionId, { kind: 'report' });
  }
  const reportLookup = lookupMetadata ? createReportSessionLookup({ router: sessionRouter, lookupMetadata, policyPath: options.reportPolicy, log }) : undefined;
  const allowedMediaRoots = (sessionId) => {
    sessionRouter.refreshCatalog();
    const registered = sessionRouter.getSession(sessionId);
    const metadata = lookupMetadata ? lookupMetadata(sessionId) : undefined;
    return reportMediaRoots({ mediaDirectory: options.mediaDir,
      sourceCwd: metadata?.isMain ? metadata.cwd : registered?.cwd,
      approvedWorkspaceRoots: sessionRouter.catalog.sessions.map(session => session.cwd),
      explicitMediaRoots: options.mediaAllowedRoots ?? [] });
  };
  const mermaidRenderer = options.mediaDir ? createMermaidRenderer({ directory: join(options.mediaDir, 'mermaid'), log }) : null;
  const prepareReportMedia = options.mediaDir ? createReportMediaPreparer({ directory: join(options.mediaDir, 'reports'),
    uploadImage: (path, context) => {
      requireConnection();
      return uploadImage(client, path, { allowedRoots: allowedMediaRoots(context?.sessionId) });
    }, renderMermaid: source => mermaidRenderer.render(source), log }) : undefined;
  const incomingImages = options.mediaDir ? createIncomingImageHandler({ directory: join(options.mediaDir, 'incoming'), router: sessionRouter,
    downloadImage: args => {
      requireConnection();
      return downloadMessageImage(client, { ...args, directory: join(options.mediaDir, 'incoming-cache') });
    }, log }) : null;
  const turnRelay = options.turnOutbox ? new TurnRelay({ outbox: options.turnOutbox, binary: options.codexBin, threadId: options.codexThread, queueRunner, log,
    recentRepliesEnabled: Boolean(recentChats),
    ...(recentChats ? {
      onDeliveryPending: receipt => {
        if (receipt.sentAtMs >= recentChats.activatedAtMs && receipt.sentAtMs >= recentChats.latestDeliveryAtMs) sessionRouter.blockDefaultReplies(receipt);
      },
      onReportSent: ({ report, session, messageId, sentAtMs, deliveryContext, recovered }) => {
        if (recovered && sentAtMs < recentChats.activatedAtMs) return;
        if (!session || session.sessionId !== report.sessionId || !Number.isSafeInteger(sentAtMs) || typeof messageId !== 'string') throw new Error('report_delivery_identity_invalid');
        const availability = sessionRouter.replyStatus(report.sessionId);
        if (availability === 'session_archived') { log('archived_report_kept_notification_only', { eventId: report.eventId }); return; }
        if (availability !== 'ready') throw new Error('report_reply_target_unavailable');
        const source = { sessionId: session.sessionId, title: session.title, cwd: session.cwd };
        const result = sessionRouter.recordReportDelivery(source, { eventId: report.eventId, messageId, deliveredAtMs: sentAtMs,
          expectedSelection: deliveryContext?.selectionSnapshot, newlySent: !recovered });
        if (sessionRouter.getSession(report.sessionId)) sessionRouter.bindCard(messageId, report.sessionId, { kind: 'report', turnId: report.turnId });
        sessionRouter.allowDefaultReplies({ eventId: report.eventId, sentAtMs });
        log('report_reply_target_updated', { eventId: report.eventId, session: label(report.sessionId), selected: result.selected, reason: result.reason });
      },
    } : {}),
    ...(prepareReportMedia ? { prepareReportMedia } : {}),
    ...(reportLookup ? { sessionLookup: reportLookup } : sessionRouter ? { sessionLookup: (id) => { sessionRouter.refreshCatalog(); return sessionRouter.getSession(id); } } : {}),
  }) : null;
  const management = options.chatManagementDir ? new ChatManagement({ directory: options.chatManagementDir, binary: options.codexBin,
    controlThreadId: options.codexThread, cwd: sessionRouter.getSession(options.codexThread).cwd, router: sessionRouter, queueRunner, log }) : null;
  const persist = () => writePrivateJson(options.state, state);
  persist();
  const runtime = new ServiceRuntime({ healthFile: options.healthFile, serviceMode: options.serviceMode, ownerPaired: Boolean(state.owner) });

  // SDK log arguments may carry credentials or WebSocket URLs. Keep only severity counts.
  const safeLogger = { trace() {}, debug() {}, info() {}, warn() { log('sdk_warning'); }, error() { log('sdk_error'); } };
  const baseConfig = { appId: config.appId, appSecret: config.appSecret, domain: lark.Domain.Feishu, logger: safeLogger, loggerLevel: lark.LoggerLevel.warn };
  const client = new lark.Client(baseConfig);

  /** Send one explicit message to the paired owner; never accept arbitrary recipients. */
  async function sendOwnerMessage(msgType, content, uuid) {
    requireConnection();
    if (!state.owner) throw new Error('owner_not_paired');
    const response = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: {
      receive_id: state.owner.chatId, msg_type: msgType, content: JSON.stringify(content), ...(uuid ? { uuid } : {}),
    } });
    if (response.code !== 0) { const error = new Error('feishu_send_failed'); error.code = response.code; throw error; }
    sentMessages++;
    return response.data?.message_id;
  }

  /** Prepare a ten-minute local request before sending a test-only approval card. */
  async function sendCard() {
    if (sending) { log('send_skipped', { reason: 'already_sending' }); return; }
    if (!state.owner) { log('send_skipped', { reason: 'owner_not_paired' }); return; }
    sending = true;
    const requestId = randomUUID();
    state.requests[requestId] = { runId: state.runId, status: 'pending', createdAt: new Date().toISOString(), expiresAt: Date.now() + 600000 };
    persist();
    try {
      const messageId = await sendOwnerMessage('interactive', testCard(requestId));
      state.requests[requestId].messageLabel = label(messageId);
      persist();
      log('test_card_sent', { requestId, message: label(messageId), recipient: label(state.owner.openId) });
    } catch (error) {
      state.requests[requestId].status = 'send_failed'; persist(); log('test_card_send_failed', { requestId, ...errorCode(error) });
    } finally { sending = false; }
  }

  /** Deliver only prevalidated fixed-label requests from the optional private queue. */
  async function pollBridge() {
    if (!bridge || !connected || !state.owner || pollingBridge || closing) return;
    pollingBridge = true;
    try {
      const batch = bridge.scan();
      for (const item of batch.rejected) log('bridge_request_rejected', item);
      for (const request of batch.requests) {
        if (!connectionAllowed()) break;
        if (request.createdAtMs < resumeAtMs) continue;
        const chatLabel = sessionRouter ? sessionRouter.chatLabel(request.sessionId) : undefined;
        state.requests[request.requestId] = { runId: state.runId, kind: 'codex_permission', harmlessTest: request.harmlessTest,
          sessionId: request.sessionId, turnId: request.turnId, ...(chatLabel ? { chatLabel } : {}),
          status: 'pending', createdAt: new Date(request.createdAtMs).toISOString(), expiresAt: request.expiresAtMs };
        persist();
        log('bridge_request_accepted', { requestId: request.requestId, harmlessTest: request.harmlessTest,
          session: label(request.sessionId), turn: label(request.turnId) });
        try {
          const messageId = await sendOwnerMessage('interactive', testCard(request.requestId, undefined, request.harmlessTest, chatLabel));
          state.requests[request.requestId].messageId = messageId;
          state.requests[request.requestId].messageLabel = label(messageId); persist();
          if (sessionRouter) sessionRouter.bindCard(messageId, request.sessionId, { kind: 'approval', requestId: request.requestId, turnId: request.turnId });
          log('codex_test_approval_card_sent', { requestId: request.requestId, harmlessTest: request.harmlessTest, message: label(messageId) });
        } catch (error) {
          state.requests[request.requestId].status = 'send_failed'; persist();
          log('codex_test_approval_card_send_failed', { requestId: request.requestId, ...errorCode(error) });
        }
      }
    } catch (error) { log('bridge_poll_failed', errorCode(error)); }
    finally { pollingBridge = false; }
  }

  /** Forward Stop reports only while connected to the already paired owner's private chat. */
  async function pollTurnReports() {
    if (!turnRelay || !connected || !state.owner || closing) return;
    try { await turnRelay.pollReports(async (card, uuid, report) => {
      const selectionSnapshot = recentChats ? sessionRouter.captureSelection() : undefined;
      const messageId = await sendOwnerMessage('interactive', card, uuid);
      if (!recentChats && sessionRouter && sessionRouter.getSession(report.sessionId)) {
        try { sessionRouter.bindCard(messageId, report.sessionId, { kind: 'report', turnId: report.turnId }); }
        catch (error) { log('report_route_binding_failed', errorCode(error)); }
      }
      return recentChats ? { messageId, deliveryContext: { selectionSnapshot } } : messageId;
    }, Date.now(), resumeAtMs); }
    catch (error) { log('turn_report_poll_failed', errorCode(error)); }
  }

  /** Deliver a fresh, bound menu or picker generated by the router. */
  async function sendSessionControl(result) {
    const messageId = await sendOwnerMessage('interactive', result.card);
    sessionRouter.noteControlSent(result.controlId ?? result.selectionId, messageId);
    if (result.status === 'switched') sessionRouter.bindCard(messageId, result.session.sessionId, { kind: 'selection' });
    log('session_control_sent', { status: result.status, message: label(messageId) });
  }

  /** Run only the explicit new-chat input step; ordinary task text stays with the selected chat. */
  async function beginChatCreation(result) {
    const response = management ? management.begin(result.selectionSnapshot) : { text: '新建聊天入口尚未启用。' };
    await sendOwnerMessage('text', { text: response.text });
  }

  /** Register confirmed desktop creations and dispatch each first task at most once. */
  async function pollChatManagement() {
    if (!management || !connected || !state.owner || closing) return;
    try { await management.pollResults((text) => sendOwnerMessage('text', { text }), resumeAtMs); }
    catch (error) { log('chat_management_poll_failed', errorCode(error)); }
  }

  /** Acknowledge the official queue result, without claiming the task has run or completed. */
  async function queueOwnerFollowup(messageId, text) {
    try {
      const result = await turnRelay.queueFollowup(messageId, text);
      const responses = {
        queued: '已加入原聊天。',
        failed: '加入原聊天失败；本次不会自动重试。',
        unknown: '未确认是否已加入原聊天；为避免重复，本次不会自动重试。',
        duplicate: '这条指导已处理或正在确认，未重复加入。',
        invalid_instruction: '请在“继续 ”或“continue ”后填写指导内容。',
        instruction_too_long: '指导内容超过4000字，请缩短后重新发送。',
      };
      if (responses[result.status]) await sendOwnerMessage('text', { text: responses[result.status] });
    } catch (error) { log('followup_processing_failed', errorCode(error)); }
  }

  /** Catalog mode owns routing exclusively: selection is explicit and card replies keep their origin. */
  async function routeOwnerMessage(message, text, targetSnapshot) {
    try {
      const isControl = ['菜单', '新建', '新建聊天', '切换聊天', '当前聊天'].includes(text.trim());
      if (management && !isControl) {
        const creation = await management.consumeDetails(message.message_id, text, message.create_time);
        if (creation) { await sendOwnerMessage('text', { text: creation.text }); return; }
      }
      const result = await sessionRouter.routeMessage({ messageId: message.message_id, text, parentId: message.parent_id, rootId: message.root_id, createTime: message.create_time,
        ...(targetSnapshot ? { targetSnapshot } : {}) });
      if (['choose_session', 'session_menu', 'current_session'].includes(result.status)) { await sendSessionControl(result); return; }
      if (result.status === 'switched') management?.cancelDraft();
      if (result.status === 'new_chat_requested') { await beginChatCreation(result); return; }
      const responses = {
        queued: `已加入「${result.session?.title ?? ''}」原聊天。`,
        failed: '加入原聊天失败；本次不会自动重试。',
        unknown: '未确认是否已加入原聊天；为避免重复，本次不会自动重试。',
        duplicate: '这条指导已处理或正在确认，未重复加入。',
        invalid_instruction: '请填写要交给 Codex 的指导内容。',
        instruction_too_long: '指导内容超过4000字，请缩短后重新发送。',
        unknown_reference: '这条引用没有可用的聊天绑定。请发送“切换聊天”选定目标，再重新发送内容。',
        conflicting_reference: '引用指向不同聊天，本次未执行。请发送“切换聊天”明确目标。',
        unknown_session: '目标聊天未登记，本次未执行。请发送“切换聊天”。',
        switched: `已切换到「${result.session?.title ?? ''}」；没有执行任务。`,
        ambiguous_session: '有多个聊天使用这个标题，请发送“切换聊天”并点选目标。',
        invalid_target: targetSnapshot?.status === 'session_archived'
          ? '目标聊天已归档，本次未投递。请在 Codex 恢复该聊天，或发送“切换聊天”选其他目标。'
          : targetSnapshot?.status === 'target_unavailable'
          ? '最新汇报的回复目标正在恢复。请先发送“切换聊天”明确目标，再发送任务。'
          : '未能确认消息的目标聊天，本次未执行。请发送“切换聊天”选定后重发。',
        target_unavailable: '最新汇报的回复目标正在恢复。请先发送“切换聊天”明确目标，再发送任务。',
        session_archived: '目标聊天已归档，本次未投递。请在 Codex 恢复该聊天，或发送“切换聊天”选其他目标。',
        unverified_message_time: '消息时间无法核实，本次未执行，请重新发送。',
      };
      if (responses[result.status]) await sendOwnerMessage('text', { text: responses[result.status] });
    } catch (error) {
      log('routed_followup_processing_failed', errorCode(error));
      try { await sendOwnerMessage('text', { text: '未能确认本次处理结果，请先核对当前聊天，避免重复发送任务。' }); }
      catch { log('routed_followup_error_notice_failed'); }
    }
  }

  /** Receive attachments only after the normal owner and private-chat checks. */
  async function routeOwnerImages(message, text, targetSnapshot) {
    try {
      const result = await incomingImages({ message, text, targetSnapshot });
      if (!result) return;
      const notices = { queued: `已收到${result.count}张图片，已加入「${result.session?.title ?? ''}」原聊天。`,
        duplicate: '这条图片消息已处理，未重复加入。',
        unknown: '未确认图片是否已加入原聊天；为避免重复，本次不会自动重试。',
        failed: result.reason === 'incoming_images_session_archived'
          ? '图片的目标聊天已归档，本次未投递。请恢复该聊天，或发送“切换聊天”后重新发送图片。'
          : '图片未能加入原聊天，请重发不超过4张、每张不超过10MB的图片；引用不明确时请先切换聊天。' };
      await sendOwnerMessage('text', { text: notices[result.status] ?? '图片未处理，请先选择目标聊天后重发。' });
    } catch (error) { log('incoming_images_processing_failed', errorCode(error));
      try { await sendOwnerMessage('text', { text: '图片处理结果未确认，请核对目标聊天后再决定是否重发。' }); } catch { log('incoming_images_error_notice_failed'); }
    }
  }

  /** Acknowledge transport immediately; optional outbound actions are scheduled afterwards. */
  function onMessage(raw) {
    if (!connectionAllowed()) return;
    const event = raw?.event ?? raw;
    const message = event?.message;
    const actor = event?.sender?.sender_id?.open_id;
    if (resumeAtMs && (!/^\d{10,16}$/.test(message?.create_time ?? '') || Number(message.create_time) < resumeAtMs)) return;
    if (event?.sender?.sender_type !== 'user' || message?.chat_type !== 'p2p' || typeof actor !== 'string' || typeof message?.chat_id !== 'string') {
      log('message_ignored', { reason: 'not_user_private_chat' }); return;
    }
    if (typeof message.message_id !== 'string' || seenMessages.has(message.message_id)) return;
    seenMessages.add(message.message_id);
    if (seenMessages.size > 200) seenMessages.delete(seenMessages.values().next().value);
    const text = extractMessageText(message.message_type, message.content);
    if (!state.owner) {
      if ((config.ownerOpenId && actor !== config.ownerOpenId) || message.message_type !== 'text' || text.trim() !== pairCode) {
        log('unpaired_message_ignored', { actor: label(actor), type: message.message_type }); return;
      }
      state.owner = { openId: actor, chatId: message.chat_id }; persist();
      runtime.setOwnerPaired(true);
      log('owner_paired', { actor: label(actor), chat: label(message.chat_id) });
      if (options.sendCardOnPair) setImmediate(() => { void sendCard(); });
      if (sessionRouter) return;
    }
    if (state.owner.openId !== actor || state.owner.chatId !== message.chat_id) { log('message_ignored', { reason: 'not_owner' }); return; }
    inboundMessages++;
    log('owner_message_received', { actor: label(actor), message: label(message.message_id), type: message.message_type, textLength: text.length });
    // Freeze the owner's target synchronously, before any scheduling or attachment download.
    let targetSnapshot;
    try { targetSnapshot = sessionRouter?.captureReplyTarget({ parentId: message.parent_id, rootId: message.root_id }); }
    catch { targetSnapshot = Object.freeze({ status: 'target_unavailable' }); }
    if (incomingImages && extractIncomingImageKeys(message.message_type, message.content).status !== 'none') {
      setImmediate(() => { void routeOwnerImages(message, text, targetSnapshot); }); return;
    }
    if (text.trim() === '测试审批卡片') { setImmediate(() => { void sendCard(); }); return; }
    if (sessionRouter) setImmediate(() => { void routeOwnerMessage(message, text, targetSnapshot); });
    else if (turnRelay) setImmediate(() => { void queueOwnerFollowup(message.message_id, text); });
  }

  const navigationDelivery = sessionRouter ? createNavigationDelivery({
    router: sessionRouter, sendControl: sendSessionControl,
    sendText: text => sendOwnerMessage('text', { text }),
    isAllowed: connectionAllowed, onSwitched: () => management?.cancelDraft(), log,
  }) : null;

  /** Consume only the owner's live request; return a toast/card without awaiting network I/O. */
  function onCard(raw) {
    if (!connectionAllowed()) return { toast: { type: 'warning', content: '飞书连接已暂停。' } };
    const event = raw?.event ?? raw;
    if (sessionRouter && ['select_session', 'session_menu', 'session_page'].includes(event?.action?.value?.route)) {
      if (!state.owner || event?.operator?.open_id !== state.owner.openId || event?.context?.open_chat_id !== state.owner.chatId) {
        log('session_selection_rejected', { reason: 'not_owner' });
        return { toast: { type: 'warning', content: '仅已绑定本人可切换聊天。' } };
      }
      if (navigationDelivery.accepts(event.action.value)) return navigationDelivery.receive({
        value: event.action.value, messageId: event.context.open_message_id,
        eventId: raw?.header?.event_id ?? event.token,
      });
      let selected;
      try { selected = sessionRouter.handleControlAction(event.action.value, event.context.open_message_id); }
      catch (error) {
        log('session_control_failed', errorCode(error));
        return { toast: { type: 'warning', content: '未能确认操作结果，请发送“当前聊天”核对。' } };
      }
      if (selected.status === 'new_chat_requested') {
        setImmediate(() => { void beginChatCreation(selected).catch((error) => log('chat_creation_begin_failed', errorCode(error))); });
        return { toast: { type: 'success', content: '请按新消息填写标题和第一条任务。' },
          ...(selected.card ? { card: { type: 'raw', data: selected.card } } : {}) };
      }
      if (selected.status === 'switched') management?.cancelDraft();
      if (!selected.card) return { toast: { type: 'warning', content: '管理卡已处理、过期或无效，请重新发送“菜单”。' } };
      return { toast: { type: 'success', content: selected.status === 'switched' ? `已切换到${selected.session.title}；没有执行任务。` : '已打开聊天管理。' },
        card: { type: 'raw', data: selected.card } };
    }
    const result = consumeDecision(state, raw);
    if (!result.ok) {
      log('card_decision_rejected', { reason: result.reason });
      return { toast: { type: 'warning', content: '本次操作未生效：非本人、已处理或测试已过期。' } };
    }
    const request = state.requests[result.requestId];
    if (request.kind === 'codex_permission') {
      try {
        if (!bridge) throw new Error('bridge_not_enabled');
        bridge.decide(result.requestId, result.decision);
        log('bridge_decision_written', { requestId: result.requestId, harmlessTest: request.harmlessTest, decision: result.decision });
      } catch (error) {
        request.status = 'decision_rejected'; persist();
        log('bridge_decision_not_written', { requestId: result.requestId, ...errorCode(error) });
        return { toast: { type: 'warning', content: '决定没有回传：请求已过期、已处理或内容已改变。' } };
      }
      try { persist(); } catch { log('state_save_failed_after_decision'); }
      acceptedDecisions++;
      return { toast: { type: 'success', content: '决定已回传；Codex执行结果另行核实。' },
        card: { type: 'raw', data: testCard(result.requestId, result.decision, request.harmlessTest, request.chatLabel) } };
    }
    persist();
    acceptedDecisions++;
    log('card_decision_accepted', { requestId: result.requestId, decision: result.decision, actor: label(state.owner.openId) });
    setImmediate(() => {
      void sendOwnerMessage('text', { text: `飞书探针完成：已收到你的${result.decision === 'approve' ? '同意' : '拒绝'}。手机 → 飞书长连接 → 本地程序的回传已到达；本次没有执行 Codex 或任何待审批命令。` })
        .then((id) => log('probe_completion_report_sent', { message: label(id) }))
        .catch((error) => log('completion_report_send_failed', errorCode(error)));
    });
    return { toast: { type: 'success', content: '已收到测试决定；本次不会执行任何命令。' }, card: { type: 'raw', data: testCard(result.requestId, result.decision) } };
  }

  /** Stop this probe only; do not leave a background listener or trust stale requests. */
  function shutdown(reason, code = 0) {
    if (closing) return;
    closing = true;
    clearTimeout(timeout); clearTimeout(connectTimeout); clearInterval(bridgeTimer); clearInterval(turnTimer); clearInterval(managementTimer); clearInterval(healthTimer); input?.close();
    connected = false;
    try { runtime.stop(); } catch { log('health_shutdown_write_failed'); }
    for (const request of Object.values(state.requests)) if (request.status === 'pending') request.status = 'expired';
    try { persist(); } catch { log('state_shutdown_write_failed'); }
    try { bridge?.close(); } catch { log('bridge_shutdown_write_failed'); }
    ws?.close({ force: true });
    log('probe_stopped', { reason, connected, inboundMessages, acceptedDecisions, sentMessages });
    process.exit(code);
  }
  const eventDispatcher = new lark.EventDispatcher({ logger: safeLogger, loggerLevel: lark.LoggerLevel.warn }).register({
    'im.message.receive_v1': onMessage,
    'card.action.trigger': onCard,
  });
  ws = new lark.WSClient({ ...baseConfig, handshakeTimeoutMs: 15000,
    onReady() { connected = true; runtime.setConnected(true); clearTimeout(connectTimeout); log('websocket_ready'); },
    onError() { connected = false; runtime.setConnected(false); log('websocket_failed'); shutdown('websocket_failed', 1); },
    onReconnecting() { connected = false; runtime.setConnected(false); log('websocket_reconnecting'); },
    onReconnected() { connected = true; runtime.setConnected(true); clearTimeout(connectTimeout); log('websocket_reconnected'); },
  });
  process.on('SIGINT', () => shutdown('sigint'));
  process.on('SIGTERM', () => shutdown('sigterm'));
  if (!options.serviceMode) timeout = setTimeout(() => shutdown('duration_elapsed'), options.duration * 1000);
  connectTimeout = setTimeout(() => shutdown('initial_connection_timeout', 1), 30000);
  if (!options.serviceMode) {
    input = createInterface({ input: process.stdin, terminal: false });
    input.on('line', (line) => {
      if (line.trim() === 'card') void sendCard();
      if (line.trim() === 'menu' && sessionRouter) void sendSessionControl(sessionRouter.createMenu()).catch((error) => log('session_menu_send_failed', errorCode(error)));
      if (line.trim() === 'status') log('status', { connected, ownerPaired: Boolean(state.owner), inboundMessages, acceptedDecisions, sentMessages });
      if (line.trim() === 'quit') shutdown('local_quit');
    });
  }
  healthTimer = setInterval(() => {
    try { if (runtime.tick().restartRequired) shutdown('connection_watchdog_timeout', 1); }
    catch { log('health_heartbeat_failed'); shutdown('health_heartbeat_failed', 1); }
  }, HEALTH_INTERVAL_MS);
  log('probe_starting', { sdkVersion: '1.76.0', ownerPaired: Boolean(state.owner), serviceMode: options.serviceMode, durationSeconds: options.serviceMode ? null : options.duration, bridgeEnabled: Boolean(bridge), turnRelayEnabled: Boolean(turnRelay), catalogRoutingEnabled: Boolean(sessionRouter), chatManagementEnabled: Boolean(management), mediaEnabled: Boolean(incomingImages), dynamicReportTitles: Boolean(lookupMetadata), allLocalReportPolicy: Boolean(options.reportPolicy), recentRepliesEnabled: Boolean(recentChats), selectableChatLimit: recentChats ? 10 : null });
  if (bridge) { log('bridge_ready', { bridgeRunId: state.runId, expiresAtMs: bridge.runtime.expiresAtMs }); bridgeTimer = setInterval(() => { void pollBridge(); }, 500); }
  if (turnRelay) turnTimer = setInterval(() => { void pollTurnReports(); }, 500);
  if (management) managementTimer = setInterval(() => { void pollChatManagement(); }, 500);
  if (!state.owner) log('pairing_required', { sendThisExactTextInBotPrivateChat: pairCode, restrictedOwnerConfigured: Boolean(config.ownerOpenId) });
  await turnRelay?.reconcileSentReports();
  if (!connectionAllowed()) shutdown('connection_paused');
  await ws.start({ eventDispatcher });
}

main().catch((error) => {
  const known = /^[a-z0-9_]{1,80}$/.test(error?.message ?? '') ? error.message : 'probe_failed';
  log('fatal', { reason: known, ...errorCode(error) }); process.exit(1);
});
