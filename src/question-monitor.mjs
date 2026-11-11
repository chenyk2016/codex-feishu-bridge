/** Incremental question discovery is isolated from both WebSocket callbacks and final reports. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';

const SCANNER = fileURLToPath(new URL('./question-scan.py', import.meta.url));

export function scanQuestions(database, directory, sinceMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', SCANNER, '--database', database, '--root', directory, '--since-ms', String(sinceMs)],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) child.kill('SIGKILL'); else stdout += chunk; });
    // Never forward a helper's raw stderr, which could include paths or question text.
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('question_scan_failed')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || bytes > 16384) { reject(new Error('question_scan_failed')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('question_scan_invalid_result')); }
    });
  });
}

export function createQuestionMonitor({ database, directory, relay, resumeAtMs = 0, isAllowed, log, scan = scanQuestions }) {
  const path = join(directory, 'activation.json');
  if (!existsSync(path)) writePrivateJson(path, { version: 1, activatedAtMs: Date.now() });
  const activation = readPrivateJson(path);
  if (activation.version !== 1 || !Number.isSafeInteger(activation.activatedAtMs) || activation.activatedAtMs <= 0 || activation.activatedAtMs > Date.now()) {
    throw new Error('question_activation_invalid');
  }
  const sinceMs = Math.max(activation.activatedAtMs, resumeAtMs);
  let polling = false;
  let lastDiagnostic = '';
  return {
    sinceMs,
    async poll() {
      if (polling || !isAllowed()) return;
      polling = true;
      try {
        const counts = await scan(database, directory, sinceMs);
        const diagnostic = Object.fromEntries(['created', 'unsupportedSync', 'unboundQuestions', 'rejectedFiles', 'budgetLimited', 'threadLimited', 'unacceptedQuestions', 'pendingLimited', 'resolvedNative', 'resolutionLimited']
          .map(key => [key, Number.isSafeInteger(counts?.[key]) ? counts[key] : 0]));
        const signature = JSON.stringify(diagnostic);
        if (Object.values(diagnostic).some(Boolean) && signature !== lastDiagnostic) log('question_scan_observed', diagnostic);
        lastDiagnostic = signature;
        if (isAllowed()) await relay.poll(sinceMs);
      } catch { log('question_monitor_failed'); }
      finally { polling = false; }
    },
  };
}
