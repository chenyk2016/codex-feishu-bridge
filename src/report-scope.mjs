/** Reporting scope is independent from chat selection, task queueing, and approval registration. */
import { constants, closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

/** Require the exact owner-private policy; a malformed policy never enables broad reporting. */
export function readReportingPolicy(path, now = Date.now()) {
  if (!path || !existsSync(path)) return undefined;
  let value;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 2048) throw new Error('report_policy_invalid');
    const buffer = Buffer.alloc(2049);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 2048) throw new Error('report_policy_invalid');
    const text = buffer.subarray(0, length).toString('utf8');
    value = JSON.parse(text);
    const keys = [...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map(match => JSON.parse('"' + match[1] + '"'));
    if (keys.length !== 4 || new Set(keys).size !== 4) throw new Error('report_policy_invalid');
  } finally { closeSync(fd); }
  if (!value || Object.keys(value).sort().join(',') !== 'activatedAtMs,enabled,scope,version' ||
      value.version !== 1 || value.scope !== 'all_local_main_chats' || typeof value.enabled !== 'boolean' ||
      !Number.isSafeInteger(value.activatedAtMs) || value.activatedAtMs <= 0 || value.activatedAtMs > now) {
    throw new Error('report_policy_invalid');
  }
  return value;
}

/** Use current UI names for registered reports; accept other main chats only after explicit activation. */
export function createReportSessionLookup({ router, lookupMetadata, policyPath, log = () => {}, clock = Date.now }) {
  if (!router || typeof router.refreshCatalog !== 'function' || typeof router.getSession !== 'function' ||
      typeof lookupMetadata !== 'function' || typeof clock !== 'function') throw new Error('report_scope_invalid_configuration');
  const waitForDisplayName = (metadata, report) => {
    const age = clock() - report?.createdAtMs;
    if (metadata?.isMain && metadata.titleReady === false && age >= 0 && age < 15000) throw new Error('chat_title_pending');
  };
  return (sessionId, report) => {
    router.refreshCatalog();
    const registered = router.getRegisteredSession ? router.getRegisteredSession(sessionId) : router.getSession(sessionId);
    let metadata;
    try { metadata = lookupMetadata(sessionId); }
    catch (error) {
      if (!registered) throw error;
      log('report_title_lookup_unavailable');
    }
    if (registered) {
      waitForDisplayName(metadata, report);
      return { ...registered, ...(metadata?.isMain && metadata.sessionId === sessionId ? { title: metadata.title, isArchived: metadata.isArchived === true } : {}) };
    }
    const policy = readReportingPolicy(policyPath, clock());
    if (!policy?.enabled || !report || report.createdAtMs < policy.activatedAtMs) return undefined;
    if (!metadata) throw new Error('chat_metadata_unavailable');
    if (!metadata.isMain || metadata.sessionId !== sessionId) return undefined;
    waitForDisplayName(metadata, report);
    return { sessionId, title: metadata.title, cwd: metadata.cwd, reportOnly: true, isArchived: metadata.isArchived === true };
  };
}
