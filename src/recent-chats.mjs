/** Bounded reply targets owned by the single supervised service, separate from approval registration. */
import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const MAX_STATE_BYTES = 65536;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['initial', 'seed', 'manual', 'created', 'delivery'];

function fields(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function timestamp(value) { return Number.isSafeInteger(value) && value > 0; }

/** Copy exactly the routing metadata; no message bodies or approval tags belong in this state. */
function sessionFields(value) {
  if (!fields(value, ['sessionId', 'title', 'cwd']) || typeof value.sessionId !== 'string' || !ID.test(value.sessionId) ||
      typeof value.title !== 'string' || !value.title.trim() || [...value.title].length > 160 || value.title.includes('\0') ||
      typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || value.cwd.length > 1024 || value.cwd.includes('\0')) {
    throw new Error('recent_chats_invalid_session');
  }
  return { sessionId: value.sessionId, title: value.title, cwd: value.cwd };
}

function entrySession(entry) { return sessionFields({ sessionId: entry.sessionId, title: entry.title, cwd: entry.cwd }); }

function receiptFields(value) {
  if (!fields(value, ['eventId', 'messageId', 'deliveredAtMs']) ||
      ![value.eventId, value.messageId].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id)) ||
      !timestamp(value.deliveredAtMs)) throw new Error('recent_chats_invalid_receipt');
  return { eventId: value.eventId, messageId: value.messageId, deliveredAtMs: value.deliveredAtMs };
}

function latestFields(value) {
  if (!fields(value, ['sessionId', 'eventId', 'messageId', 'deliveredAtMs']) || typeof value.sessionId !== 'string' || !ID.test(value.sessionId)) {
    throw new Error('recent_chats_invalid_state');
  }
  return { sessionId: value.sessionId, ...receiptFields({ eventId: value.eventId, messageId: value.messageId, deliveredAtMs: value.deliveredAtMs }) };
}

function snapshotFields(value) {
  if (!fields(value, ['sessionId', 'selectionVersion']) || typeof value.sessionId !== 'string' || !ID.test(value.sessionId) ||
      typeof value.selectionVersion !== 'string' || !value.selectionVersion || value.selectionVersion.length > 160) {
    throw new Error('recent_chats_invalid_selection_snapshot');
  }
  return value;
}

/** Reject corrupt or unbounded state instead of silently choosing a different chat on restart. */
function validateState(state, limit, now) {
  if (!fields(state, ['version', 'activatedAtMs', 'entries', 'selection', 'latestDelivery', 'deliveryHighWaterAtMs']) || state.version !== 1 ||
      !timestamp(state.activatedAtMs) || state.activatedAtMs > now + 30000 ||
      !Array.isArray(state.entries) || state.entries.length < 1 || state.entries.length > limit ||
      !Number.isSafeInteger(state.deliveryHighWaterAtMs) || state.deliveryHighWaterAtMs < 0 || state.deliveryHighWaterAtMs > now + 30000) {
    throw new Error('recent_chats_invalid_state');
  }
  const sessions = new Set(); const events = new Set();
  for (const entry of state.entries) {
    if (!fields(entry, ['sessionId', 'title', 'cwd', 'latestDelivery'])) throw new Error('recent_chats_invalid_state');
    entrySession(entry);
    if (sessions.has(entry.sessionId)) throw new Error('recent_chats_invalid_state');
    sessions.add(entry.sessionId);
    if (entry.latestDelivery !== null) {
      const receipt = receiptFields(entry.latestDelivery);
      if (receipt.deliveredAtMs > state.deliveryHighWaterAtMs || events.has(receipt.eventId)) throw new Error('recent_chats_invalid_state');
      events.add(receipt.eventId);
    }
  }
  const selection = state.selection;
  if (!fields(selection, ['sessionId', 'selectionVersion', 'selectedAtMs', 'reason']) || !sessions.has(selection.sessionId) ||
      typeof selection.selectionVersion !== 'string' || !TOKEN.test(selection.selectionVersion) ||
      !timestamp(selection.selectedAtMs) || selection.selectedAtMs < state.activatedAtMs || selection.selectedAtMs > now + 30000 ||
      !REASONS.includes(selection.reason)) throw new Error('recent_chats_invalid_state');
  if (state.latestDelivery === null) {
    if (state.deliveryHighWaterAtMs !== 0 || events.size) throw new Error('recent_chats_invalid_state');
  } else {
    const latest = latestFields(state.latestDelivery);
    if (latest.deliveredAtMs > state.deliveryHighWaterAtMs) throw new Error('recent_chats_invalid_state');
    const duplicate = state.entries.find((entry) => entry.latestDelivery?.eventId === latest.eventId);
    if (duplicate && (duplicate.sessionId !== latest.sessionId || duplicate.latestDelivery.messageId !== latest.messageId ||
        duplicate.latestDelivery.deliveredAtMs !== latest.deliveredAtMs)) throw new Error('recent_chats_invalid_state');
  }
  return state;
}

function statIfPresent(path) {
  try { return lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function requirePrivateDirectory(directory, create = false) {
  if (create && !statIfPresent(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('recent_chats_requires_owned_mode_700_directory');
  }
}

function requirePrivateFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_STATE_BYTES) {
    throw new Error('recent_chats_requires_owned_bounded_mode_600_file');
  }
}

/** An fd check and O_NOFOLLOW prevent following a state-file symlink while reading. */
function readState(path) {
  requirePrivateFile(lstatSync(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    requirePrivateFile(fstatSync(fd));
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

/** Rename one complete state, so an evicted entry and its replacement selection cannot diverge. */
function writeState(directory, path, state) {
  requirePrivateDirectory(directory);
  const existing = statIfPresent(path);
  if (existing) requirePrivateFile(existing);
  const body = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error('recent_chats_state_too_large');
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd; let published = false;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    requirePrivateFile(fstatSync(fd));
    writeFileSync(fd, body, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path); published = true;
    const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published) { try { unlinkSync(temp); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
  }
}

/** One process performs all synchronous mutations; callers capture selection before asynchronous sends. */
export class RecentChats {
  #directory; #path; #clock; #limit; #state;

  constructor({ directory, initialSession, seedDeliveries = [], limit = 10, clock = Date.now }) {
    if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0') ||
        !Number.isInteger(limit) || limit < 1 || limit > 10 || typeof clock !== 'function') throw new Error('recent_chats_invalid_options');
    this.#directory = directory; this.#path = join(directory, 'recent-chats.json'); this.#clock = clock; this.#limit = limit;
    const now = this.#now();
    requirePrivateDirectory(directory, true);
    if (statIfPresent(this.#path)) {
      // Bootstrap hints are deliberately ignored after first activation.
      this.#state = validateState(readState(this.#path), limit, now);
      return;
    }
    const initial = sessionFields(initialSession);
    if (!Array.isArray(seedDeliveries)) throw new Error('recent_chats_invalid_seed');
    let seeded = [];
    for (const value of seedDeliveries) {
      if (!fields(value, ['session', 'eventId', 'messageId', 'deliveredAtMs'])) throw new Error('recent_chats_invalid_seed');
      const session = sessionFields(value.session);
      const receipt = receiptFields({ eventId: value.eventId, messageId: value.messageId, deliveredAtMs: value.deliveredAtMs });
      if (receipt.deliveredAtMs > now + 30000) throw new Error('recent_chats_invalid_seed');
      const previous = seeded.find((entry) => entry.sessionId === session.sessionId);
      if (previous && previous.latestDelivery.deliveredAtMs >= receipt.deliveredAtMs) continue;
      seeded = [...seeded.filter((entry) => entry.sessionId !== session.sessionId), { ...session, latestDelivery: receipt }]
        .sort((a, b) => b.latestDelivery.deliveredAtMs - a.latestDelivery.deliveredAtMs).slice(0, limit);
    }
    const latest = seeded[0];
    this.#state = { version: 1, activatedAtMs: now,
      entries: latest ? seeded : [{ ...initial, latestDelivery: null }],
      selection: { sessionId: latest?.sessionId ?? initial.sessionId, selectionVersion: randomUUID(), selectedAtMs: now, reason: latest ? 'seed' : 'initial' },
      latestDelivery: latest ? { sessionId: latest.sessionId, ...latest.latestDelivery } : null,
      deliveryHighWaterAtMs: latest?.latestDelivery.deliveredAtMs ?? 0 };
    validateState(this.#state, limit, now);
    writeState(this.#directory, this.#path, this.#state);
  }

  #now() {
    const now = this.#clock();
    if (!timestamp(now)) throw new Error('recent_chats_invalid_clock');
    return now;
  }

  #matches(expectedSelection) {
    if (expectedSelection === undefined) return true;
    snapshotFields(expectedSelection);
    return expectedSelection.sessionId === this.#state.selection.sessionId && expectedSelection.selectionVersion === this.#state.selection.selectionVersion;
  }

  #selection(sessionId, reason) {
    return { sessionId, selectionVersion: randomUUID(), selectedAtMs: Math.max(this.#now(), this.activatedAtMs), reason };
  }

  #commit(next) {
    requirePrivateDirectory(this.#directory);
    const current = validateState(readState(this.#path), this.#limit, this.#now());
    if (JSON.stringify(current) !== JSON.stringify(this.#state)) throw new Error('recent_chats_state_changed');
    validateState(next, this.#limit, this.#now());
    writeState(this.#directory, this.#path, next);
    this.#state = next;
  }

  #promote(entries, entry, selectedId) {
    const ordered = [entry, ...entries.filter((item) => item.sessionId !== entry.sessionId)];
    const bounded = ordered.slice(0, this.#limit);
    // Several late asynchronous results can share a stale snapshot. Preserve the newer manual target even at the cap.
    if (!bounded.some((item) => item.sessionId === selectedId)) {
      const selected = ordered.find((item) => item.sessionId === selectedId);
      if (!selected) throw new Error('recent_chats_selected_session_missing');
      bounded[bounded.length - 1] = selected;
    }
    return bounded;
  }

  get activatedAtMs() { return this.#state.activatedAtMs; }
  get latestDeliveryAtMs() { return this.#state.deliveryHighWaterAtMs; }
  list() { return this.#state.entries.map(entrySession); }
  getSession(sessionId) {
    const entry = this.#state.entries.find((item) => item.sessionId === sessionId);
    return entry ? entrySession(entry) : undefined;
  }
  getSelection() { return { ...this.#state.selection }; }
  captureSelection() { const { sessionId, selectionVersion } = this.#state.selection; return { sessionId, selectionVersion }; }
  getState() { return structuredClone(this.#state); }

  #select(session, expectedSelection, reason) {
    if (!this.#matches(expectedSelection)) return { selected: false, session, selectionSnapshot: this.captureSelection() };
    const previous = this.#state.entries.find((entry) => entry.sessionId === session.sessionId);
    const selection = this.#selection(session.sessionId, reason);
    const entry = { ...session, latestDelivery: previous?.latestDelivery ?? null };
    this.#commit({ ...this.#state, entries: this.#promote(this.#state.entries, entry, selection.sessionId), selection });
    return { selected: true, session: { ...session }, selectionSnapshot: this.captureSelection() };
  }

  /** A manual choice must name a visible recent target and makes that choice most recently used. */
  selectSession(sessionId, { expectedSelection } = {}) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('recent_chats_session_not_recent');
    return this.#select(session, expectedSelection, 'manual');
  }

  /** Only the caller's separately verified creation flow may introduce a new manually selected target. */
  selectKnownSession(session, { expectedSelection } = {}) { return this.#select(sessionFields(session), expectedSelection, 'created'); }

  /** Remember a verified creation without changing the owner's target or replaying stale catalog metadata. */
  rememberKnownSession(session) {
    const source = sessionFields(session);
    const known = this.getSession(source.sessionId);
    if (known) return { updated: false, session: known, selectionSnapshot: this.captureSelection() };
    this.#commit({ ...this.#state,
      entries: this.#promote(this.#state.entries, { ...source, latestDelivery: null }, this.#state.selection.sessionId) });
    return { updated: true, session: source, selectionSnapshot: this.captureSelection() };
  }

  /** Record only a confirmed successful send. Replayed receipts cannot override a later manual choice. */
  recordDelivery(session, { eventId, messageId, deliveredAtMs, expectedSelection, newlySent = true }) {
    const source = sessionFields(session);
    const receipt = receiptFields({ eventId, messageId, deliveredAtMs });
    if (typeof newlySent !== 'boolean' || deliveredAtMs > this.#now() + 30000) throw new Error('recent_chats_invalid_receipt');
    const matches = this.#matches(expectedSelection);
    const unchanged = (reason) => ({ updated: false, selected: false, session: source, selectionSnapshot: this.captureSelection(), reason });
    const duplicate = this.#state.latestDelivery?.eventId === eventId || this.#state.entries.some((entry) => entry.latestDelivery?.eventId === eventId);
    if (duplicate) return unchanged('duplicate_delivery');
    if (deliveredAtMs < this.activatedAtMs) return unchanged('historical_delivery');
    if (deliveredAtMs < this.latestDeliveryAtMs || (!newlySent && deliveredAtMs === this.latestDeliveryAtMs)) return unchanged('stale_delivery');
    // An ack recovered after a crash may predate a persisted owner choice, even if no newer delivery was recorded.
    const newerOwnerChoice = !newlySent && ['manual', 'created'].includes(this.#state.selection.reason) && this.#state.selection.selectedAtMs > deliveredAtMs;
    const selected = matches && !newerOwnerChoice;
    const selection = selected ? this.#selection(source.sessionId, 'delivery') : this.#state.selection;
    this.#commit({ ...this.#state,
      entries: this.#promote(this.#state.entries, { ...source, latestDelivery: receipt }, selection.sessionId), selection,
      latestDelivery: { sessionId: source.sessionId, ...receipt }, deliveryHighWaterAtMs: Math.max(this.latestDeliveryAtMs, deliveredAtMs) });
    return { updated: true, selected, session: source, selectionSnapshot: this.captureSelection(), reason: selected ? 'delivery' : 'selection_changed' };
  }
}
