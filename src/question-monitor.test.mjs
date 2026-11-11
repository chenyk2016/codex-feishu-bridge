import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQuestionMonitor } from './question-monitor.mjs';

test('overlapping scans are suppressed; pause during scan prevents sending discovered questions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'question-monitor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let allowed = true, scans = 0, deliveries = 0, release;
  const monitor = createQuestionMonitor({ database: '/unused', directory,
    relay: { poll: async () => deliveries++ }, isAllowed: () => allowed, log() {},
    scan: async () => { scans++; await new Promise(resolve => { release = resolve; }); return {}; } });
  const first = monitor.poll(); await monitor.poll();
  assert.equal(scans, 1); allowed = false; release(); await first;
  assert.equal(deliveries, 0);
});

test('restart preserves activation, and resume advances the cutoff without replaying old questions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'question-cutoff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { database: '/unused', directory, relay: {}, isAllowed: () => false, log() {} };
  const first = createQuestionMonitor(options);
  assert.equal(createQuestionMonitor(options).sinceMs, first.sinceMs);
  assert.equal(createQuestionMonitor({ ...options, resumeAtMs: first.sinceMs + 1000 }).sinceMs, first.sinceMs + 1000);
});
