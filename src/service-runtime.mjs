/** Explicit daemon lifetime and non-sensitive health state for the supervised Feishu connection. */
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { writePrivateJson } from './probe-core.mjs';

export const HEALTH_INTERVAL_MS = 10000;
export const DISCONNECT_LIMIT_MS = 300000;

/** Keep ordinary probes bounded; permanent operation must be explicit and observable. */
export function validateLifecycleOptions(options) {
  if (options.serviceMode && options.durationExplicit) throw new Error('service_cannot_use_explicit_duration');
  if (options.serviceMode && !options.healthFile) throw new Error('service_requires_health_file');
  if (!Number.isInteger(options.duration) || options.duration < 30 || options.duration > 3600) throw new Error('duration_requires_30_to_3600_seconds');
  if (options.healthFile && !isAbsolute(options.healthFile)) throw new Error('health_file_requires_absolute_path');
  if (options.healthFile && [options.credentials, options.state, options.sessionCatalog].some((path) => path && resolve(path) === resolve(options.healthFile))) {
    throw new Error('health_file_cannot_replace_configuration');
  }
  return options;
}

/** A permanent listener has no bridge lifetime deadline; each approval request keeps its own short TTL. */
export function bridgeExpiresAtMs(options, now = Date.now()) {
  return options.serviceMode ? Number.MAX_SAFE_INTEGER : now + options.duration * 1000;
}

/** Write only owned, private health metadata; no owner ids, task text or credentials enter this file. */
export class ServiceRuntime {
  /** Start disconnected and publish the initial heartbeat; connection readiness is set separately. */
  constructor({ healthFile, serviceMode = false, ownerPaired = false, now = Date.now(), pid = process.pid }) {
    if (healthFile !== undefined && (typeof healthFile !== 'string' || !isAbsolute(healthFile))) throw new Error('health_file_requires_absolute_path');
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(pid) || pid < 1 || typeof serviceMode !== 'boolean' || typeof ownerPaired !== 'boolean') {
      throw new Error('service_runtime_invalid_configuration');
    }
    this.healthFile = healthFile;
    this.disconnectedAtMs = now;
    this.stopped = false;
    this.state = { pid, serviceMode, connected: false, ownerPaired, startedAtMs: now, heartbeatAtMs: now, lastReadyAtMs: null };
    if (healthFile) {
      const parent = dirname(healthFile);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('health_parent_requires_owned_mode_700_directory');
    }
    this.publish(now);
  }

  /** Atomically refresh the seven-field health contract with a validated timestamp. */
  publish(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('service_runtime_invalid_timestamp');
    this.state.heartbeatAtMs = now;
    if (this.healthFile) writePrivateJson(this.healthFile, this.state);
  }

  /** Record actual SDK readiness; reconnect notifications do not restart an existing outage budget. */
  setConnected(connected, now = Date.now()) {
    if (typeof connected !== 'boolean') throw new Error('service_runtime_invalid_connection_state');
    if (this.stopped) return;
    if (connected) {
      this.state.lastReadyAtMs = now;
      this.disconnectedAtMs = null;
    } else if (this.state.connected) this.disconnectedAtMs = now;
    this.state.connected = connected;
    this.publish(now);
  }

  /** Pairing affects health visibility only; the existing owner-authentication rules remain authoritative. */
  setOwnerPaired(ownerPaired, now = Date.now()) {
    if (typeof ownerPaired !== 'boolean') throw new Error('service_runtime_invalid_pairing_state');
    if (this.stopped) return;
    this.state.ownerPaired = ownerPaired;
    this.publish(now);
  }

  /** Heartbeat and report a sustained service outage so the supervisor can restart this process. */
  tick(now = Date.now()) {
    if (this.stopped) return { restartRequired: false };
    this.publish(now);
    return { restartRequired: this.state.serviceMode && !this.state.connected && this.disconnectedAtMs !== null && now - this.disconnectedAtMs >= DISCONNECT_LIMIT_MS };
  }

  /** Leave a disconnected final heartbeat; an old health file must never claim an orderly stop is live. */
  stop(now = Date.now()) {
    this.state.connected = false;
    this.stopped = true;
    this.publish(now);
  }
}
