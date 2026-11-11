/** Explicit selection and card replies route the paired owner's messages to registered chats. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { label, readPrivateJson, writePrivateJson } from './probe-core.mjs';
import { runCodexQueue } from './turn-relay.mjs';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 8;

/** Report routing identities never carry approval tags into the recent-chat store. */
function chatIdentity({ sessionId, title, cwd }) { return { sessionId, title, cwd }; }

/** Validate at most one hundred deliberately registered chats; no chat is inferred from text. */
function validateCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || Object.keys(value).sort().join(',') !== 'defaultSessionId,sessions,version' ||
      typeof value.defaultSessionId !== 'string' || !Array.isArray(value.sessions) || value.sessions.length < 1 || value.sessions.length > 100) {
    throw new Error('session_catalog_invalid');
  }
  const seen = new Set();
  for (const session of value.sessions) {
    if (!session || typeof session !== 'object' || Object.keys(session).some((key) => !['sessionId', 'title', 'cwd', 'testCommandTag'].includes(key)) ||
        typeof session.sessionId !== 'string' || !ID.test(session.sessionId) || seen.has(session.sessionId) ||
        typeof session.title !== 'string' || !session.title.trim() || [...session.title].length > 160 ||
        typeof session.cwd !== 'string' || !isAbsolute(session.cwd) || session.cwd.length > 1024 ||
        (session.testCommandTag !== undefined && !['allow', 'deny'].includes(session.testCommandTag))) {
      throw new Error('session_catalog_invalid_entry');
    }
    seen.add(session.sessionId);
  }
  if (!seen.has(value.defaultSessionId)) throw new Error('session_catalog_default_missing');
  return value;
}

/** Read a complete atomically published catalog from an owned mode-600 file. */
export function loadSessionCatalog(path) { return validateCatalog(readPrivateJson(path)); }

/** Keep route state in owned, non-symlink folders, with no shared read access. */
function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('session_router_requires_owned_mode_700_directories');
  }
}

/** Derive a path-safe key without exposing full platform identifiers in filenames. */
function key(value) { return createHash('sha256').update(value).digest('hex'); }

/** Keep prefix context while distinguishing IDs created close together. */
export function shortSessionId(sessionId) { return sessionId.length <= 16 ? sessionId : `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}`; }

/** Serialize trusted local writers and fail explicitly rather than overwrite a concurrent update. */
function withPrivateLock(path, work) {
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) { if (error?.code === 'EEXIST') throw new Error('session_router_state_busy'); throw error; }
  try { return work(); } finally { closeSync(fd); unlinkSync(path); }
}

/** One row of management controls; all choices carry a fresh issued control token. */
function managementButtons(controlId) {
  return { tag: 'column_set', columns: [
    ['new_chat', '新建聊天'], ['switch_chat', '切换聊天'], ['current_chat', '当前聊天'],
  ].map(([action, title]) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [{
    tag: 'button', text: { tag: 'plain_text', content: title }, type: 'default',
    behaviors: [{ type: 'callback', value: { route: 'session_menu', action, control_id: controlId } }],
  }] })) };
}

/** Build a selection-only card: no button contains an executable instruction. */
export function sessionPickerCard(catalog, currentSessionId, selectionId, page = 0) {
  const totalPages = Math.ceil(catalog.sessions.length / PAGE_SIZE);
  if (!Number.isInteger(page) || page < 0 || page >= totalPages) throw new Error('session_router_invalid_page');
  const pageSessions = catalog.sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const elements = pageSessions.flatMap((session) => [
    { tag: 'div', text: { tag: 'plain_text', content: `${session.title}（${shortSessionId(session.sessionId)}）${session.sessionId === currentSessionId ? ' · 当前' : ''}\n目录：${session.cwd}` } },
    { tag: 'column_set', columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: [{
      tag: 'button', type: session.sessionId === currentSessionId ? 'primary' : 'default',
      text: { tag: 'plain_text', content: `切换到 ${[...session.title].slice(0, 20).join('')}（${shortSessionId(session.sessionId)}）` },
      behaviors: [{ type: 'callback', value: { route: 'select_session', selection_id: selectionId, session_id: session.sessionId } }],
    }] }] },
  ]);
  if (totalPages > 1) {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: `第 ${page + 1} / ${totalPages} 页` } });
    elements.push({ tag: 'column_set', columns: [[page - 1, '上一页'], [page + 1, '下一页']]
      .filter(([target]) => target >= 0 && target < totalPages)
      .map(([target, title]) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [{
        tag: 'button', text: { tag: 'plain_text', content: title }, type: 'default',
        behaviors: [{ type: 'callback', value: { route: 'session_page', selection_id: selectionId, page: target } }],
      }] })) });
  }
  return { schema: '2.0', header: { title: { tag: 'plain_text', content: '切换 Codex 聊天' }, template: 'blue' }, body: { elements:
    elements,
  } };
}

/** Persist chat selection, card mappings and once-only queue intents for the paired owner. */
export class SessionRouter {
  #replyTargets = new WeakMap();
  #defaultReplies = { blocked: false, sentAtMs: -1, eventId: null };
  #manualChoiceAtMs = -1;

  /** The approval catalog stays static; an optional store owns recent chats and reply selection. */
  constructor({ catalog, catalogPath, storageDirectory, binary, log = () => {}, queueRunner = runCodexQueue, recentChats, replyStatusLookup }) {
    const initial = catalogPath ? loadSessionCatalog(catalogPath) : validateCatalog(catalog);
    this.catalogPath = catalogPath;
    this.catalog = catalog ?? initial;
    Object.assign(this.catalog, initial);
    this.rootSessionId = initial.defaultSessionId;
    this.recentChats = recentChats;
    if (replyStatusLookup !== undefined && typeof replyStatusLookup !== 'function') throw new Error('session_router_invalid_reply_status_lookup');
    this.replyStatusLookup = replyStatusLookup;
    this.binary = binary; this.log = log; this.queueRunner = queueRunner;
    this.sessions = new Map(initial.sessions.map((session) => [session.sessionId, session]));
    this.directory = storageDirectory;
    this.cardsDirectory = join(storageDirectory, 'card-bindings');
    this.selectionsDirectory = join(storageDirectory, 'selections');
    this.messagesDirectory = join(storageDirectory, 'queued-messages');
    [storageDirectory, this.cardsDirectory, this.selectionsDirectory, this.messagesDirectory].forEach(ensurePrivateDirectory);
    const activationPath = join(storageDirectory, 'activation.json');
    if (existsSync(activationPath)) {
      const activation = readPrivateJson(activationPath);
      if (activation.version !== 1 || !Number.isSafeInteger(activation.activatedAtMs) || activation.activatedAtMs < 1 || activation.activatedAtMs > Date.now() + 30000) {
        throw new Error('session_router_invalid_activation_state');
      }
      this.activatedAtMs = activation.activatedAtMs;
    } else {
      this.activatedAtMs = Date.now();
      writePrivateJson(activationPath, { version: 1, activatedAtMs: this.activatedAtMs });
    }
    this.selectionPath = join(storageDirectory, 'selection.json');
    if (recentChats) {
      this.refreshCatalog();
    } else if (existsSync(this.selectionPath)) {
      this.readSelection();
    } else {
      this.currentSessionId = initial.defaultSessionId;
      this.selectionVersion = randomUUID();
      writePrivateJson(this.selectionPath, { version: 1, sessionId: this.currentSessionId, selectionVersion: this.selectionVersion, selectedAtMs: Date.now() });
    }
  }

  /** Read persisted selection, including a stable compatibility token for older state files. */
  readSelection() {
    if (this.recentChats) {
      const selected = this.recentChats.getSelection();
      if (!selected || !this.sessions.has(selected.sessionId) || typeof selected.selectionVersion !== 'string' || !selected.selectionVersion) {
        throw new Error('session_router_selected_chat_not_registered');
      }
      this.currentSessionId = selected.sessionId;
      this.selectionVersion = selected.selectionVersion;
      if (['manual', 'created'].includes(selected.reason) && Number.isSafeInteger(selected.selectedAtMs)) {
        this.#manualChoiceAtMs = Math.max(this.#manualChoiceAtMs, selected.selectedAtMs);
      }
      return { ...selected };
    }
    const selected = readPrivateJson(this.selectionPath);
    if (selected.version !== 1 || !this.sessions.has(selected.sessionId) || !Number.isSafeInteger(selected.selectedAtMs)) {
      throw new Error('session_router_selected_chat_not_registered');
    }
    const version = selected.selectionVersion ?? `legacy:${selected.selectedAtMs}`;
    if (typeof version !== 'string' || !version || version.length > 160) throw new Error('session_router_invalid_selection_version');
    this.currentSessionId = selected.sessionId;
    this.selectionVersion = version;
    return { sessionId: selected.sessionId, selectionVersion: version };
  }

  /** Reload a complete published catalog and selection; failures never fall back to a guessed chat. */
  refreshCatalog() {
    const latest = this.catalogPath ? loadSessionCatalog(this.catalogPath) : validateCatalog(this.catalog);
    if (latest.defaultSessionId !== this.rootSessionId) throw new Error('session_catalog_root_changed');
    Object.assign(this.catalog, latest);
    this.sessions = new Map(latest.sessions.map((session) => [session.sessionId, session]));
    // Merge only in memory. In particular, never add report sources to the approval catalog.
    if (this.recentChats) {
      for (const session of this.recentChats.list()) this.sessions.set(session.sessionId, chatIdentity(session));
      this.readSelection();
    } else if (this.selectionPath && existsSync(this.selectionPath)) this.readSelection();
    return this.catalog;
  }

  /** Capture the explicit choice version before an asynchronous creation request starts. */
  captureSelection() {
    this.refreshCatalog();
    return this.recentChats ? { ...this.recentChats.captureSelection() } : { sessionId: this.currentSessionId, selectionVersion: this.selectionVersion };
  }

  /** Select a known chat, optionally only if no later explicit user choice has happened. */
  selectRegisteredSession(sessionId, { expectedSelection } = {}) {
    this.refreshCatalog();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('session_router_chat_not_registered');
    if (this.recentChats) {
      const result = this.recentChats.getSession(sessionId)
        ? this.recentChats.selectSession(sessionId, { expectedSelection })
        : this.recentChats.selectKnownSession(chatIdentity(session), { expectedSelection });
      this.refreshCatalog();
      if (result.selected) {
        this.#manualChoiceAtMs = Date.now();
        this.#defaultReplies.blocked = false;
        this.log('session_selected', { session: label(sessionId) });
      }
      return result;
    }
    return withPrivateLock(`${this.selectionPath}.lock`, () => {
      const current = this.readSelection();
      if (expectedSelection && (expectedSelection.sessionId !== current.sessionId || expectedSelection.selectionVersion !== current.selectionVersion)) {
        return { session, selected: false, selectionSnapshot: current };
      }
      const selectionVersion = randomUUID();
      writePrivateJson(this.selectionPath, { version: 1, sessionId, selectionVersion, selectedAtMs: Date.now() });
      this.selectionVersion = selectionVersion;
      this.currentSessionId = sessionId;
      this.#manualChoiceAtMs = Date.now();
      this.#defaultReplies.blocked = false;
      this.log('session_selected', { session: label(sessionId) });
      return { session, selected: true, selectionSnapshot: { sessionId, selectionVersion: this.selectionVersion } };
    });
  }

  /** Register a confirmed real chat ID atomically; asynchronous completion cannot override a newer choice. */
  registerSession(session, { expectedSelection, select = false } = {}) {
    if (!this.catalogPath) throw new Error('session_catalog_path_required');
    if (!session || typeof session !== 'object' || Object.keys(session).sort().join(',') !== 'cwd,sessionId,title') {
      throw new Error('session_catalog_registration_invalid');
    }
    if (select && (!expectedSelection || typeof expectedSelection.sessionId !== 'string' || typeof expectedSelection.selectionVersion !== 'string')) {
      throw new Error('session_router_expected_selection_required');
    }
    const registered = withPrivateLock(`${this.catalogPath}.lock`, () => {
      const latest = loadSessionCatalog(this.catalogPath);
      if (latest.defaultSessionId !== this.rootSessionId) throw new Error('session_catalog_root_changed');
      const existing = latest.sessions.find((item) => item.sessionId === session.sessionId);
      if (existing) {
        if (existing.title !== session.title || existing.cwd !== session.cwd) throw new Error('session_catalog_registration_conflict');
        return false;
      }
      const next = validateCatalog({ ...latest, sessions: [...latest.sessions, session] });
      writePrivateJson(this.catalogPath, next);
      return true;
    });
    this.refreshCatalog();
    // A later owner choice must survive, while a confirmed created chat remains discoverable.
    this.recentChats?.rememberKnownSession(chatIdentity(session));
    this.refreshCatalog();
    // Replayed creation results may re-register a real ID, but must never re-apply a past selection.
    const selection = select && registered ? this.selectRegisteredSession(session.sessionId, { expectedSelection })
      : { session: this.sessions.get(session.sessionId), selected: false, selectionSnapshot: this.captureSelection() };
    return { ...selection, registered };
  }

  /** Return a known routing identity from the static catalog or the bounded recent list. */
  getSession(sessionId) { this.refreshCatalog(); return this.sessions.get(sessionId); }

  /** Approval and report authorization must use the deliberately registered catalog only. */
  getRegisteredSession(sessionId) { this.refreshCatalog(); return this.catalog.sessions.find((session) => session.sessionId === sessionId); }

  /** Report the explicit current chat without issuing a task. */
  getCurrentSession() { this.refreshCatalog(); return this.sessions.get(this.currentSessionId); }

  /** Record only an actual successful report receipt; networking belongs to the caller. */
  recordReportDelivery(session, receipt) {
    if (!this.recentChats) return { updated: false, selected: false, reason: 'recent_chats_disabled' };
    const result = this.recentChats.recordDelivery(chatIdentity(session), receipt);
    this.refreshCatalog();
    return result;
  }

  /** Availability is checked afresh; archival never redirects an instruction to another chat. */
  replyStatus(sessionId) {
    if (!this.replyStatusLookup) return 'ready';
    try {
      const status = this.replyStatusLookup(sessionId);
      return ['ready', 'session_archived', 'target_unavailable'].includes(status) ? status : 'target_unavailable';
    } catch { return 'target_unavailable'; }
  }

  /** A newer unreconciled delivery blocks only new messages that rely on the default target. */
  blockDefaultReplies({ eventId, sentAtMs } = {}) {
    this.validateDeliveryWatermark(eventId, sentAtMs);
    // Reconciliation may retry the same locally failed receipt after an explicit owner choice.
    if (sentAtMs <= this.#manualChoiceAtMs || sentAtMs < this.#defaultReplies.sentAtMs) return false;
    this.#defaultReplies = { eventId, sentAtMs, blocked: true };
    return true;
  }

  /** Older successes cannot clear a later failure; ties from other reports stay blocked. */
  allowDefaultReplies({ eventId, sentAtMs } = {}) {
    this.validateDeliveryWatermark(eventId, sentAtMs);
    const current = this.#defaultReplies;
    if (sentAtMs < current.sentAtMs || (sentAtMs === current.sentAtMs && current.blocked && eventId !== current.eventId)) return false;
    this.#defaultReplies = { eventId, sentAtMs, blocked: false };
    return true;
  }

  validateDeliveryWatermark(eventId, sentAtMs) {
    if (typeof eventId !== 'string' || !eventId || eventId.length > 256 || !Number.isSafeInteger(sentAtMs) || sentAtMs < 0) {
      throw new Error('session_router_invalid_delivery_watermark');
    }
  }

  /** Format literal metadata for approval cards, including the registered directory. */
  chatLabel(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('session_router_chat_not_registered');
    return `${session.title}（${shortSessionId(session.sessionId)}）\n目录：${session.cwd}`;
  }

  /** Save the actual platform message ID so quoted replies retain their original chat binding. */
  bindCard(messageId, sessionId, details = {}) {
    this.refreshCatalog();
    if (typeof messageId !== 'string' || !messageId || messageId.length > 256 || !this.sessions.has(sessionId) || !['approval', 'report', 'selection'].includes(details.kind)) {
      throw new Error('session_router_invalid_card_binding');
    }
    const path = join(this.cardsDirectory, `${key(messageId)}.json`);
    if (existsSync(path)) {
      const previous = readPrivateJson(path);
      if (previous.messageId !== messageId || (previous.sessionId !== sessionId && !(previous.kind === 'selection' && details.kind === 'selection'))) {
        throw new Error('session_router_card_binding_conflict');
      }
      // Management cards can reflect another explicit selection; source approval/report bindings stay immutable.
      if (previous.sessionId === sessionId) return;
    }
    writePrivateJson(path, { version: 1, messageId, sessionId, kind: details.kind,
      ...(details.requestId ? { requestId: details.requestId } : {}), ...(details.turnId ? { turnId: details.turnId } : {}), createdAtMs: Date.now() });
  }

  /** Issue a fresh, one-use control token; no task text or approval decision is stored here. */
  issueControl(kind, details = {}, now = Date.now()) {
    const controlId = randomUUID();
    writePrivateJson(join(this.selectionsDirectory, `${controlId}.json`), { version: 1, controlId, kind,
      createdAtMs: now, expiresAtMs: now + 600000, status: 'pending', ...details });
    return controlId;
  }

  /** Read only a still-live control that was actually delivered as this exact platform message. */
  readControl(controlId, messageId, now = Date.now()) {
    if (typeof controlId !== 'string' || !TOKEN.test(controlId)) return null;
    const path = join(this.selectionsDirectory, `${controlId}.json`);
    if (!existsSync(path)) return null;
    const control = readPrivateJson(path);
    return control.version === 1 && control.controlId === controlId && control.status === 'pending' &&
      control.expiresAtMs > now && control.messageId && control.messageId === messageId ? control : null;
  }

  /** Mark a validated control used, so old button clicks cannot replay management actions. */
  consumeControl(control, now = Date.now()) {
    writePrivateJson(join(this.selectionsDirectory, `${control.controlId}.json`), { ...control, status: 'handled', handledAtMs: now });
  }

  /** Create a fresh three-button management card for a text or first-menu entry point. */
  createMenu(now = Date.now()) { return this.createManagementCard('session_menu', 'Codex 聊天菜单', now); }

  /** Create a current-chat card with fresh management controls, without queueing work. */
  createCurrent(now = Date.now()) { return this.createManagementCard('current_session', '当前聊天', now); }

  /** Build literal current-chat metadata and controls; every card needs a delivered-message binding. */
  createManagementCard(status, title, now = Date.now()) {
    this.refreshCatalog();
    const session = this.sessions.get(this.currentSessionId);
    const available = this.replyStatus(session.sessionId);
    const notice = available === 'session_archived' ? '该聊天已归档，请在桌面恢复或切换到其他聊天。'
      : available !== 'ready' ? '暂时无法核实目标状态，请稍后重试或切换聊天。'
      : '普通消息将发到这个聊天；下方按钮只管理聊天。';
    const controlId = this.issueControl(status === 'current_session' ? 'current' : 'menu', {}, now);
    const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: title }, template: 'blue' }, body: { elements: [
      { tag: 'div', text: { tag: 'plain_text', content: `${session.title}（${shortSessionId(session.sessionId)}）\n目录：${session.cwd}\n${notice}` } },
      managementButtons(controlId),
    ] } };
    return { status, controlId, session, card };
  }

  /** Create one page of fresh selection controls; pages contain at most eight registered chats. */
  createPicker(now = Date.now(), page = 0) {
    this.refreshCatalog();
    const catalog = this.pickerCatalog();
    if (!catalog.sessions.length) {
      const result = this.createCurrent(now);
      result.card.body.elements[0].text.content += '\n最近列表暂无可用聊天；已归档聊天请先在桌面恢复。';
      return result;
    }
    const totalPages = Math.ceil(catalog.sessions.length / PAGE_SIZE);
    if (!Number.isInteger(page) || page < 0 || page >= totalPages) throw new Error('session_router_invalid_page');
    const visibleSessionIds = catalog.sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((session) => session.sessionId);
    const selectionId = this.issueControl('picker', { page, visibleSessionIds }, now);
    return { status: 'choose_session', controlId: selectionId, selectionId, page, totalPages,
      card: sessionPickerCard(catalog, this.currentSessionId, selectionId, page) };
  }

  /** Reports may evict even the control root from the picker without changing its catalog entry. */
  pickerCatalog() {
    const sessions = this.recentChats ? this.recentChats.list() : this.catalog.sessions;
    return { sessions: sessions.filter(session => this.replyStatus(session.sessionId) === 'ready') };
  }

  /** Bind any newly issued control to its sent message; another message cannot borrow the token. */
  noteControlSent(controlId, messageId) {
    if (typeof controlId !== 'string' || !TOKEN.test(controlId)) throw new Error('session_router_invalid_control');
    const path = join(this.selectionsDirectory, `${controlId}.json`);
    const control = readPrivateJson(path);
    if (typeof messageId !== 'string' || !messageId || messageId.length > 256 || control.controlId !== controlId || control.status !== 'pending' ||
        (control.messageId && control.messageId !== messageId)) throw new Error('session_router_invalid_control');
    writePrivateJson(path, { ...control, messageId });
  }

  /** Compatibility alias for integrations that still bind only picker cards. */
  notePickerSent(selectionId, messageId) { this.noteControlSent(selectionId, messageId); }

  /** Apply a visible owner choice; the selection method never calls the task runner. */
  selectSession(value, messageId, now = Date.now()) {
    this.refreshCatalog();
    if (!value || value.route !== 'select_session' || !this.pickerCatalog().sessions.some((session) => session.sessionId === value.session_id)) return { status: 'invalid_selection' };
    const control = this.readControl(value.selection_id, messageId, now);
    if (!control || control.kind !== 'picker' || !control.visibleSessionIds?.includes(value.session_id)) return { status: 'invalid_selection' };
    const result = this.selectRegisteredSession(value.session_id);
    this.consumeControl(control, now);
    this.bindCard(messageId, result.session.sessionId, { kind: 'selection' });
    const current = this.createCurrent(now);
    current.card.header.title.content = '已切换聊天';
    current.card.header.template = 'green';
    this.noteControlSent(current.controlId, messageId);
    return { ...current, status: 'switched', session: result.session, selectionSnapshot: result.selectionSnapshot, replaceMessage: true };
  }

  /** Handle only issued management controls; callbacks cannot create or queue a task directly. */
  handleControlAction(value, messageId, now = Date.now()) {
    this.refreshCatalog();
    if (value?.route === 'select_session') return this.selectSession(value, messageId, now);
    const id = value?.route === 'session_page' ? value.selection_id : value?.control_id;
    const control = this.readControl(id, messageId, now);
    if (!control) return { status: 'invalid_selection' };
    let result;
    if (value.route === 'session_page') {
      const totalPages = Math.ceil(this.pickerCatalog().sessions.length / PAGE_SIZE);
      if (control.kind !== 'picker' || !Number.isInteger(value.page) || Math.abs(value.page - control.page) !== 1 || value.page < 0 || value.page >= totalPages) {
        return { status: 'invalid_selection' };
      }
      result = this.createPicker(now, value.page);
    } else if (value.route === 'session_menu' && ['menu', 'current'].includes(control.kind)) {
      if (value.action === 'new_chat') result = { ...this.createMenu(now), status: 'new_chat_requested', selectionSnapshot: this.captureSelection() };
      else if (value.action === 'switch_chat') result = this.createPicker(now);
      else if (value.action === 'current_chat') result = this.createCurrent(now);
      else return { status: 'invalid_selection' };
    } else return { status: 'invalid_selection' };
    this.consumeControl(control, now);
    if (result.controlId) this.noteControlSent(result.controlId, messageId);
    return { ...result, replaceMessage: true };
  }

  /** Resolve known approval/report references only; unknown references never fall back to current. */
  resolveReference(parentId, rootId) {
    const ids = [...new Set([parentId, rootId].filter((id) => typeof id === 'string' && id.length > 0))];
    if (!ids.length) return { status: 'no_reference' };
    const bindings = [];
    for (const id of ids) {
      const path = join(this.cardsDirectory, `${key(id)}.json`);
      if (!existsSync(path)) continue;
      const binding = readPrivateJson(path);
      if (binding.version === 1 && binding.messageId === id && ['approval', 'report'].includes(binding.kind) && this.sessions.has(binding.sessionId)) bindings.push(binding);
    }
    if (!bindings.length) return { status: 'unknown_reference' };
    if (new Set(bindings.map((item) => item.sessionId)).size !== 1) return { status: 'conflicting_reference' };
    return { status: 'referenced', sessionId: bindings[0].sessionId };
  }

  /** Capture synchronously after owner authentication, before downloads or other asynchronous work. */
  captureReplyTarget({ parentId, rootId } = {}) {
    this.refreshCatalog();
    const reference = this.resolveReference(parentId, rootId);
    if (['unknown_reference', 'conflicting_reference'].includes(reference.status)) return Object.freeze({ ...reference });
    if (reference.status === 'no_reference' && this.#defaultReplies.blocked) return Object.freeze({ status: 'target_unavailable' });
    const session = this.sessions.get(reference.status === 'referenced' ? reference.sessionId : this.currentSessionId);
    if (!session) return Object.freeze({ status: 'unknown_session' });
    const available = this.replyStatus(session.sessionId);
    if (available !== 'ready') return Object.freeze({ status: available });
    const snapshot = Object.freeze({ status: 'ready', session: Object.freeze(chatIdentity(session)),
      selectionSnapshot: Object.freeze({ ...this.captureSelection() }) });
    this.#replyTargets.set(snapshot, { session: snapshot.session, source: reference.status === 'referenced' ? 'card_reply' : 'selected_chat' });
    return snapshot;
  }

  /** Route one ordinary owner message, preserving its target and once-only intent before queueing. */
  async routeMessage({ messageId, text, parentId, rootId, createTime, targetSessionId, targetSnapshot }) {
    if (typeof text !== 'string' || !text.trim()) return { status: 'ignored' };
    // An authenticated arrival snapshot remains usable even if its chat was evicted or the store is now unavailable.
    // Controls deliberately resolve current state instead and never issue a queued task.
    if (text.trim() === '菜单') return this.createMenu();
    if (text.trim() === '当前聊天') return this.createCurrent();
    if (text.trim() === '切换聊天') return this.createPicker();
    if (['新建', '新建聊天'].includes(text.trim())) return { status: 'new_chat_requested', selectionSnapshot: this.captureSelection() };
    if (typeof createTime !== 'string' || !/^\d{10,16}$/.test(createTime) || !Number.isSafeInteger(Number(createTime)) || Number(createTime) > Date.now() + 30000) {
      return { status: 'unverified_message_time' };
    }
    if (Number(createTime) < this.activatedAtMs) {
      this.log('historical_message_ignored', { message: label(messageId) }); return { status: 'historical_message_ignored' };
    }
    const prefix = ['继续 ', 'continue '].find((item) => text.startsWith(item));
    const body = prefix ? text.slice(prefix.length) : text;
    if (!body.trim() || body.includes('\0')) return { status: 'invalid_instruction' };
    if ([...body].length > 4000) return { status: 'instruction_too_long' };
    if (typeof messageId !== 'string' || !messageId || messageId.length > 256) return { status: 'invalid_message_id' };
    let session, source;
    if (targetSnapshot !== undefined) {
      const captured = targetSnapshot && typeof targetSnapshot === 'object' ? this.#replyTargets.get(targetSnapshot) : null;
      if (!captured || targetSnapshot.status !== 'ready') return { status: 'invalid_target' };
      if (targetSessionId !== undefined && targetSessionId !== captured.session.sessionId) return { status: 'invalid_target' };
      ({ session, source } = captured);
    } else {
      this.refreshCatalog();
      const reference = this.resolveReference(parentId, rootId);
      if (['unknown_reference', 'conflicting_reference'].includes(reference.status)) return reference;
      if (reference.status === 'no_reference' && this.#defaultReplies.blocked) return { status: 'target_unavailable' };
      // Compatibility IDs still require a currently known chat; only issued snapshots survive eviction.
      if (targetSessionId !== undefined && (typeof targetSessionId !== 'string' || !this.sessions.has(targetSessionId))) return { status: 'unknown_session' };
      if (targetSessionId !== undefined && reference.status === 'referenced' && targetSessionId !== reference.sessionId) return { status: 'conflicting_reference' };
      session = this.sessions.get(targetSessionId ?? (reference.status === 'referenced' ? reference.sessionId : this.currentSessionId));
      source = targetSessionId !== undefined ? 'image_message' : reference.status === 'referenced' ? 'card_reply' : 'selected_chat';
    }
    if (!session) return { status: 'unknown_session' };
    const available = this.replyStatus(session.sessionId);
    if (available !== 'ready') return { status: available, session };
    const path = join(this.messagesDirectory, `${key(messageId)}.json`);
    if (existsSync(path)) {
      const previous = readPrivateJson(path);
      if (previous.messageId !== messageId || typeof previous.sessionId !== 'string' || !ID.test(previous.sessionId)) throw new Error('session_router_invalid_message_state');
      return { status: 'duplicate', session: previous.sessionId === session.sessionId ? session : this.sessions.get(previous.sessionId) };
    }
    const intent = { version: 1, messageId, sessionId: session.sessionId, status: 'attempting', source, createdAtMs: Date.now() };
    try { writeFileSync(path, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error?.code === 'EEXIST') return { status: 'duplicate', session }; throw error; }
    let result;
    try { result = await this.queueRunner(this.binary, session.sessionId, body); } catch { result = { status: 'unknown' }; }
    if (!['queued', 'failed', 'unknown'].includes(result?.status)) result = { status: 'unknown' };
    writePrivateJson(path, { ...intent, status: result.status, finishedAtMs: Date.now() });
    this.log(result.status === 'queued' ? 'routed_followup_queued' : 'routed_followup_unconfirmed', { session: label(session.sessionId), message: label(messageId), source: intent.source, status: result.status });
    return { ...result, session };
  }
}
