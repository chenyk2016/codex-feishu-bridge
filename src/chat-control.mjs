#!/usr/bin/env node
/** Root-chat-only helper: one creation claim, then an idempotent real desktop result. */
import { isAbsolute } from 'node:path';
import { claimCreation, completeCreation } from './chat-management.mjs';

/** Accept explicit local paths and ids; no shell execution, credentials or task-body output. */
function main() {
  const [command, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--directory', '--request', '--thread', '--outcome'].includes(args[i]) || !args[i + 1]) throw new Error('invalid_chat_control_arguments');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!isAbsolute(options.directory ?? '') || !options.request || !process.env.CODEX_THREAD_ID) throw new Error('chat_control_requires_root_context');
  let result;
  if (command === 'claim') result = claimCreation(options.directory, options.request, process.env.CODEX_THREAD_ID);
  else if (command === 'complete') result = completeCreation(options.directory, options.request, process.env.CODEX_THREAD_ID, { status: 'created', sessionId: options.thread });
  else if (command === 'fail') result = completeCreation(options.directory, options.request, process.env.CODEX_THREAD_ID, { status: options.outcome });
  else throw new Error('invalid_chat_control_command');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`${/^[a-z0-9_]{1,100}$/.test(error.message) ? error.message : 'chat_control_failed'}\n`); process.exitCode = 1;
}
