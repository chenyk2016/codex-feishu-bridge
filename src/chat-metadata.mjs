/** Bounded synchronous adapter for the local read-only Codex metadata helper. */
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID = /^[_a-zA-Z0-9-]{1,128}$/;
const ERROR = 'chat_metadata_unavailable';
const MAX_BYTES = 16 * 1024;
const HELPER = fileURLToPath(new URL('./chat-metadata.py', import.meta.url));

function unavailable() { return new Error(ERROR); }

/** Resolve one ID afresh so names and archive protection never use stale state. */
export function createChatMetadataLookup({ database, pythonBinary = '/usr/bin/python3', timeoutMs = 1500, spawnImpl = spawnSync } = {}) {
  if (typeof database !== 'string' || !isAbsolute(database) || database.includes('\0') ||
      typeof pythonBinary !== 'string' || !isAbsolute(pythonBinary) || pythonBinary.includes('\0') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || typeof spawnImpl !== 'function') throw unavailable();

  return function lookup(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined;
    try {
      const result = spawnImpl(pythonBinary, ['-I', HELPER, database, sessionId], {
        encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: MAX_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      if (!result || result.error || result.status !== 0 || result.signal ||
          (result.stderr !== undefined && result.stderr !== null && result.stderr.length > 0) ||
          (typeof result.stdout !== 'string' && !Buffer.isBuffer(result.stdout)) ||
          Buffer.byteLength(result.stdout) > MAX_BYTES) throw unavailable();
      const value = JSON.parse(result.stdout.toString());
      if (value === null) return undefined;
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).sort().join(',') !== 'cwd,isArchived,isMain,sessionId,title,titleReady' ||
          value.sessionId !== sessionId || typeof value.title !== 'string' || !value.title.trim() ||
          [...value.title].length > 160 || value.title.includes('\0') ||
          typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || [...value.cwd].length > 1024 ||
          value.cwd.includes('\0') || typeof value.isMain !== 'boolean' || typeof value.titleReady !== 'boolean' || typeof value.isArchived !== 'boolean') throw unavailable();
      return value;
    } catch { throw unavailable(); }
  };
}
