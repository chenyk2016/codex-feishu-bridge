/** Lifecycle checks are offline and use isolated private health files, never a Feishu connection. */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { bridgeExpiresAtMs, DISCONNECT_LIMIT_MS, HEALTH_INTERVAL_MS, ServiceRuntime, validateLifecycleOptions } from './service-runtime.mjs';

/** Each test owns a private temporary directory and removes its health record afterwards. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-service-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, healthFile: join(directory, 'health.json') };
}

test('explicit service mode has no duration deadline and ordinary probes retain bounded defaults', () => {
  const bounded = { duration: 900, serviceMode: false };
  assert.equal(validateLifecycleOptions(bounded), bounded);
  assert.equal(bridgeExpiresAtMs(bounded, 1000), 901000);
  assert.equal(bridgeExpiresAtMs({ serviceMode: true }, 1000), Number.MAX_SAFE_INTEGER);
  assert.equal(Number.isSafeInteger(bridgeExpiresAtMs({ serviceMode: true })), true);
  for (const duration of [0, 29, 3601, Infinity, NaN, '900']) assert.throws(() => validateLifecycleOptions({ duration }), /duration_requires/);
  assert.throws(() => validateLifecycleOptions({ duration: 900, serviceMode: true }), /service_requires_health_file/);
  assert.throws(() => validateLifecycleOptions({ duration: 900, serviceMode: true, durationExplicit: true, healthFile: '/private/health.json' }), /service_cannot_use_explicit_duration/);
  assert.throws(() => validateLifecycleOptions({ duration: 900, healthFile: 'relative.json' }), /health_file_requires_absolute/);
  for (const property of ['credentials', 'state', 'sessionCatalog']) {
    assert.throws(() => validateLifecycleOptions({ duration: 900, healthFile: '/private/state.json', [property]: '/private/state.json' }), /health_file_cannot_replace/);
  }
});

test('health is exactly the seven-field private contract and records readiness, pairing and orderly stop', (t) => {
  const { directory, healthFile } = fixture(t);
  const runtime = new ServiceRuntime({ healthFile, serviceMode: true, now: 1000, pid: 42 });
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(healthFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(healthFile, 'utf8')), {
    pid: 42, serviceMode: true, connected: false, ownerPaired: false, startedAtMs: 1000, heartbeatAtMs: 1000, lastReadyAtMs: null,
  });
  runtime.setOwnerPaired(true, 1100);
  runtime.setConnected(true, 1200);
  assert.deepEqual(runtime.tick(2200), { restartRequired: false });
  assert.deepEqual(JSON.parse(readFileSync(healthFile, 'utf8')), {
    pid: 42, serviceMode: true, connected: true, ownerPaired: true, startedAtMs: 1000, heartbeatAtMs: 2200, lastReadyAtMs: 1200,
  });
  runtime.stop(2300);
  runtime.setConnected(true, 2400);
  assert.equal(JSON.parse(readFileSync(healthFile, 'utf8')).connected, false);
  assert.equal(JSON.parse(readFileSync(healthFile, 'utf8')).heartbeatAtMs, 2300);
});

test('repeated reconnect attempts cannot reset the five-minute outage budget; successful reconnect starts a new budget', (t) => {
  const { healthFile } = fixture(t);
  const runtime = new ServiceRuntime({ healthFile, serviceMode: true, now: 1000 });
  assert.equal(HEALTH_INTERVAL_MS, 10000);
  assert.equal(DISCONNECT_LIMIT_MS, 300000);
  runtime.setConnected(true, 1500);
  runtime.setConnected(false, 2000);
  runtime.setConnected(false, 200000);
  assert.equal(runtime.tick(301999).restartRequired, false);
  assert.equal(runtime.tick(302000).restartRequired, true);
  runtime.setConnected(true, 302100);
  assert.equal(runtime.tick(900000).restartRequired, false);
  runtime.setConnected(false, 901000);
  assert.equal(runtime.tick(1200999).restartRequired, false);
  assert.equal(runtime.tick(1201000).restartRequired, true);
  const bounded = new ServiceRuntime({ serviceMode: false, now: 1000 });
  assert.equal(bounded.tick(1000000).restartRequired, false);
});

test('health writer rejects shared directories, symlink parents and symlink destinations', (t) => {
  const { directory, healthFile } = fixture(t);
  chmodSync(directory, 0o755);
  assert.throws(() => new ServiceRuntime({ healthFile }), /health_parent_requires/);
  chmodSync(directory, 0o700);
  const parentLink = join(directory, 'link');
  symlinkSync(directory, parentLink);
  assert.throws(() => new ServiceRuntime({ healthFile: join(parentLink, 'health.json') }), /health_parent_requires/);
  const target = join(directory, 'target.json');
  writeFileSync(target, 'unchanged', { mode: 0o600 });
  symlinkSync(target, healthFile);
  assert.throws(() => new ServiceRuntime({ healthFile }), /state_symlink_rejected/);
  assert.equal(readFileSync(target, 'utf8'), 'unchanged');
});

test('the actual CLI rejects ambiguous permanent lifetime before loading credentials and exposes the service flags', () => {
  const conflict = spawnSync(process.execPath, ['probe.mjs', 'listen', '--service', '--duration', '900', '--state', '/private/not-read.json', '--health-file', '/private/health.json'], { cwd: new URL('.', import.meta.url), encoding: 'utf8' });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /service_cannot_use_explicit_duration/);
  const help = spawnSync(process.execPath, ['probe.mjs', '--help'], { cwd: new URL('.', import.meta.url), encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--service --health-file/);
  assert.match(help.stdout, /outside service mode/);
});
