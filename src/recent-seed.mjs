/** Read confirmed deliveries once when creating recent-chat state; never replay or edit reports. */
import { lstatSync, opendirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readPrivateJson } from './probe-core.mjs';
import { validateTurnReport } from './turn-relay.mjs';

const EVENT_ID = /^[a-f0-9]{64}$/i;
const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MESSAGE_ID = /^om_[a-zA-Z0-9_-]{1,253}$/;
const MAX_FILE_BYTES = 65536;

/** Missing history is normal; unsafe history must not silently become an empty history. */
function privateDirectory(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('recent_seed_requires_owned_mode_700_directories');
  }
  return true;
}

/** Preflight rejects nonregular and oversized files; the shared reader also checks its opened fd. */
function privateRecord(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 || stat.size > MAX_FILE_BYTES) throw new Error('recent_seed_invalid_private_record');
  return readPrivateJson(path);
}

function receipt(ack, eventId, now) {
  if (ack.version !== 1 || ack.eventId !== eventId || !EVENT_ID.test(eventId) || ack.status !== 'sent' ||
      typeof ack.sessionId !== 'string' || !SESSION_ID.test(ack.sessionId) ||
      typeof ack.messageId !== 'string' || !MESSAGE_ID.test(ack.messageId) ||
      !Number.isSafeInteger(ack.sentAtMs) || ack.sentAtMs <= 0 || ack.sentAtMs > now + 30000) {
    throw new Error('recent_seed_invalid_receipt');
  }
  return { sessionId: ack.sessionId, eventId, messageId: ack.messageId, deliveredAtMs: ack.sentAtMs };
}

function readDelivery(outbox, reportStates, name, now) {
  const ack = privateRecord(join(reportStates, name));
  const delivery = receipt(ack, name.slice(0, -5), now);
  const report = validateTurnReport(privateRecord(join(outbox, name)), delivery.eventId, delivery.sessionId, now);
  if (report.createdAtMs > delivery.deliveredAtMs) throw new Error('recent_seed_receipt_precedes_report');
  return { delivery, report };
}

/** Metadata may contain registration/approval flags; only the three reply-routing fields cross this boundary. */
function sessionFields(value, sessionId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.sessionId !== sessionId ||
      typeof value.title !== 'string' || !value.title.trim() || [...value.title].length > 160 || value.title.includes('\0') ||
      typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || value.cwd.length > 1024 || value.cwd.includes('\0')) {
    throw new Error('recent_seed_invalid_session');
  }
  return { sessionId, title: value.title, cwd: value.cwd };
}

function newestFirst(a, b) { return b.deliveredAtMs - a.deliveredAtMs || a.eventId.localeCompare(b.eventId); }

/**
 * Return at most ten distinct successful chats in actual delivery order. The scan retains one
 * receipt per session, never report bodies. Lookup starts with the newest candidate and stops
 * once limit acceptable sessions exist; unknown metadata falls through to the next candidate.
 */
export function collectRecentSeeds({ outbox, sessionLookup, limit = 10, log = () => {} }) {
  if (typeof outbox !== 'string' || !isAbsolute(outbox) || outbox.includes('\0') ||
      typeof sessionLookup !== 'function' || typeof log !== 'function' ||
      !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('recent_seed_invalid_options');
  const reportStates = join(outbox, '.relay-state', 'reports');
  if (![outbox, join(outbox, '.relay-state'), reportStates].every(privateDirectory)) return [];
  const safeLog = (code) => { try { log(code); } catch { /* A logger cannot expose or enable an invalid candidate. */ } };
  const latest = new Map();
  const now = Date.now();
  const directory = opendirSync(reportStates);
  try {
    let file;
    while ((file = directory.readSync()) !== null) {
      if (!file.name.endsWith('.json') || !EVENT_ID.test(file.name.slice(0, -5))) continue;
      try {
        const { delivery } = readDelivery(outbox, reportStates, file.name, now);
        const previous = latest.get(delivery.sessionId);
        if (!previous || newestFirst(delivery, previous) < 0) latest.set(delivery.sessionId, delivery);
      } catch { safeLog('recent_seed_record_rejected'); }
    }
  } finally { directory.closeSync(); }

  const seeds = [];
  for (const candidate of [...latest.values()].sort(newestFirst)) {
    let report;
    try {
      const current = readDelivery(outbox, reportStates, `${candidate.eventId}.json`, now);
      if (Object.keys(candidate).some((key) => current.delivery[key] !== candidate[key])) throw new Error('recent_seed_record_changed');
      report = current.report;
    } catch { safeLog('recent_seed_record_rejected'); continue; }
    try {
      const value = sessionLookup(candidate.sessionId, report);
      if (value === undefined || value?.isArchived === true) { safeLog('recent_seed_session_unavailable'); continue; }
      const session = sessionFields(value, candidate.sessionId);
      seeds.push({ session, eventId: candidate.eventId, messageId: candidate.messageId, deliveredAtMs: candidate.deliveredAtMs });
    } catch {
      safeLog('recent_seed_metadata_unavailable');
      // An unreadable database cannot prove this newer target is gone. Retry startup instead of
      // silently directing the owner's first message to an older candidate or the initial chat.
      throw new Error('recent_seed_metadata_unavailable');
    }
    if (seeds.length === limit) break;
  }
  return seeds;
}
