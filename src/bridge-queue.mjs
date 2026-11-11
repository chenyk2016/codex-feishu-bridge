/** Private file queue restricted to the two agreed harmless Codex approval probes. */
import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const REQUEST_KEYS = ['version', 'requestId', 'kind', 'harmlessTest', 'sessionId', 'turnId', 'bridgeRunId', 'createdAtMs', 'expiresAtMs'];

/** Refuse shared or symlink directories before handling any local request files. */
function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('bridge_requires_owned_mode_700_directories');
  }
}

/** Validate the whole wire contract, rejecting commands, text, stale runs and excessive TTL. */
export function validateRequest(value, fileId, runtime, now = Date.now(), catalog) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== REQUEST_KEYS.length || REQUEST_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('bridge_invalid_request_fields');
  }
  if (value.version !== 1 || !UUID.test(value.requestId) || value.requestId !== fileId || value.kind !== 'codex_permission') {
    throw new Error('bridge_invalid_request_identity');
  }
  if (!['allow', 'deny'].includes(value.harmlessTest)) throw new Error('bridge_test_not_allowed');
  if (catalog) {
    const session = catalog.sessions.find((item) => item.sessionId === value.sessionId);
    if (!session || session.testCommandTag !== value.harmlessTest) throw new Error('bridge_chat_or_test_not_registered');
  }
  if (typeof value.sessionId !== 'string' || typeof value.turnId !== 'string' ||
      !ID.test(value.sessionId) || !ID.test(value.turnId)) throw new Error('bridge_invalid_session_or_turn');
  if (value.bridgeRunId !== runtime.bridgeRunId) throw new Error('bridge_previous_run');
  if (![value.createdAtMs, value.expiresAtMs].every(Number.isSafeInteger) || value.createdAtMs > now + 30000 ||
      value.expiresAtMs <= value.createdAtMs || value.expiresAtMs - value.createdAtMs > 600000 ||
      value.expiresAtMs > runtime.expiresAtMs || value.expiresAtMs <= now || runtime.expiresAtMs <= now) {
    throw new Error('bridge_request_expired_or_invalid_ttl');
  }
  return Object.fromEntries(REQUEST_KEYS.map((key) => [key, value[key]]));
}

/** Publish an entire mode-600 decision atomically, without replacing an existing decision. */
function createDecision(path, value) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { linkSync(temp, path); } finally { unlinkSync(temp); }
}

/** A single-process queue adapter; it never executes commands or accepts arbitrary action text. */
export class BridgeQueue {
  /** Create private inbox/outbox folders and publish the current listener lifetime. */
  constructor(directory, runId, expiresAtMs, catalog) {
    this.directory = directory;
    this.requestsDirectory = join(directory, 'requests');
    this.decisionsDirectory = join(directory, 'decisions');
    [directory, this.requestsDirectory, this.decisionsDirectory].forEach(ensurePrivateDirectory);
    this.runtime = { version: 1, bridgeRunId: runId, startedAtMs: Date.now(), expiresAtMs };
    this.catalog = catalog;
    this.accepted = new Map();
    this.seen = new Set();
    writePrivateJson(join(directory, 'runtime.json'), this.runtime);
  }

  /** An older listener must not keep answering after a newer run publishes its identity. */
  assertCurrentRun() {
    const current = readPrivateJson(join(this.directory, 'runtime.json'));
    if (current.version !== 1 || current.bridgeRunId !== this.runtime.bridgeRunId || current.expiresAtMs !== this.runtime.expiresAtMs) {
      throw new Error('bridge_previous_run');
    }
  }

  /** Read each finalized UUID request once; return valid requests and bounded rejection reasons. */
  scan(now = Date.now()) {
    this.assertCurrentRun();
    const requests = [];
    const rejected = [];
    const names = readdirSync(this.requestsDirectory).filter((name) => name.endsWith('.json') && UUID.test(name.slice(0, -5)) && !this.seen.has(name)).slice(0, 1000);
    for (const name of names) {
      if (this.seen.has(name)) continue;
      this.seen.add(name);
      const requestId = name.slice(0, -5);
      try {
        if (existsSync(join(this.decisionsDirectory, name))) throw new Error('bridge_already_decided');
        const request = validateRequest(readPrivateJson(join(this.requestsDirectory, name)), requestId, this.runtime, now, this.catalog);
        this.accepted.set(requestId, request);
        requests.push(request);
      } catch (error) {
        rejected.push({ requestId, reason: /^bridge_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'bridge_request_unreadable' });
      }
    }
    return { requests, rejected };
  }

  /** Revalidate the unchanged source and current lifetime before publishing one decision. */
  decide(requestId, decision, now = Date.now()) {
    this.assertCurrentRun();
    if (!['approve', 'deny'].includes(decision)) throw new Error('bridge_invalid_decision');
    const accepted = this.accepted.get(requestId);
    if (!accepted) throw new Error('bridge_request_not_accepted');
    const current = validateRequest(readPrivateJson(join(this.requestsDirectory, `${requestId}.json`)), requestId, this.runtime, now, this.catalog);
    if (JSON.stringify(current) !== JSON.stringify(accepted)) throw new Error('bridge_request_changed');
    const result = { version: 1, requestId, kind: 'codex_permission', harmlessTest: accepted.harmlessTest,
      sessionId: accepted.sessionId, turnId: accepted.turnId, bridgeRunId: this.runtime.bridgeRunId, decision, decidedAtMs: now };
    createDecision(join(this.decisionsDirectory, `${requestId}.json`), result);
    return result;
  }

  /** Expire this run's public metadata on shutdown, without touching another listener's run. */
  close() {
    const path = join(this.directory, 'runtime.json');
    if (existsSync(path) && readPrivateJson(path).bridgeRunId === this.runtime.bridgeRunId) {
      this.runtime.expiresAtMs = Date.now();
      writePrivateJson(path, this.runtime);
    }
  }
}
