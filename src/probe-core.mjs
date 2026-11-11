/** Pure approval rules and private-file helpers for the Feishu-only probe. */
import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Read only an owner-readable regular file, without following a symlink. */
export function readPrivateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
      throw new Error('private_file_requires_owned_regular_mode_600');
    }
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_private_json');
    return value;
  } finally { closeSync(fd); }
}

/** Atomically persist sensitive state with mode 600; never replace a symlink. */
export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('state_symlink_rejected');
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

/** Validate explicitly supplied credentials; environment credentials must form a pair. */
export function loadConfig(env, credentialPath) {
  const file = credentialPath ? readPrivateJson(credentialPath) : {};
  const usingEnv = Boolean(env.FEISHU_APP_ID || env.FEISHU_APP_SECRET);
  const appId = usingEnv ? env.FEISHU_APP_ID : (file.app_id ?? file.appId);
  const appSecret = usingEnv ? env.FEISHU_APP_SECRET : (file.app_secret ?? file.appSecret);
  const ownerOpenId = env.FEISHU_OWNER_OPEN_ID ?? file.owner_open_id ?? file.ownerOpenId;
  if (typeof appId !== 'string' || !/^cli_[a-fA-F0-9]{16}$/.test(appId)) throw new Error('valid_app_id_required');
  if (typeof appSecret !== 'string' || appSecret.length < 8) throw new Error('app_secret_required');
  if (ownerOpenId !== undefined && (typeof ownerOpenId !== 'string' || !/^ou_[a-zA-Z0-9_-]+$/.test(ownerOpenId))) {
    throw new Error('invalid_owner_open_id');
  }
  return { appId, appSecret, ownerOpenId };
}

/** Produce an opaque stable label, never logging an actual user/chat/message identifier. */
export function label(value) {
  return typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0, 10) : null;
}

/** Build a V2 card whose buttons only record a Feishu probe decision. */
export function testCard(requestId, decision, harmlessTest, chatLabel) {
  if (harmlessTest !== undefined && !['allow', 'deny'].includes(harmlessTest)) throw new Error('bridge_test_not_allowed');
  const bridge = harmlessTest !== undefined;
  const approved = decision === 'approve';
  const title = bridge
    ? (decision ? `已${approved ? '同意' : '拒绝'} · Codex无害测试` : `Codex无害测试 · ${harmlessTest === 'allow' ? '同意分支' : '拒绝分支'}`)
    : (decision ? (approved ? '已同意 · 飞书探针' : '已拒绝 · 飞书探针') : '测试审批 · 飞书探针');
  const bridgeContent = decision
    ? `已将你的${approved ? '同意' : '拒绝'}回传本机审批hook。**这只表示决定已写入，Codex是否恢复和命令是否执行需另看真实结果。**`
    : `这是一次真实Codex待批请求的无害测试。命令仅输出固定文本 **codex-feishu-live-${harmlessTest}**。\n${harmlessTest === 'allow' ? '请点同意，验证原待批请求恢复。' : '请点拒绝，验证原待批请求被阻止。'}\n每张卡只能处理一次；卡片过期后不会继续。`;
  const elements = [{
    tag: 'markdown',
    content: bridge ? bridgeContent : decision
      ? `已记录你的${approved ? '同意' : '拒绝'}。本次只验证卡片回调，未执行 Codex、命令或文件修改。`
      : '本次只验证手机按钮能否回传。**不会执行 Codex、命令或文件修改。**\n请选择同意或拒绝；每张卡片只记录一次。',
  }];
  if (chatLabel !== undefined) {
    if (typeof chatLabel !== 'string' || chatLabel.length > 1600) throw new Error('invalid_chat_label');
    elements.unshift({ tag: 'div', text: { tag: 'plain_text', content: chatLabel } });
  }
  if (!decision) elements.push({
    tag: 'column_set', flex_mode: 'none', columns: ['approve', 'deny'].map((choice) => ({
      tag: 'column', width: 'weighted', weight: 1,
      elements: [{ tag: 'button', text: { tag: 'plain_text', content: choice === 'approve' ? '同意（测试）' : '拒绝（测试）' },
        type: choice === 'approve' ? 'primary' : 'danger',
        behaviors: [{ type: 'callback', value: { probe: bridge ? 'codex-harmless-bridge' : 'feishu-only', request_id: requestId, decision: choice } }],
      }],
    })),
  });
  return { schema: '2.0', config: { update_multi: true }, header: {
    title: { tag: 'plain_text', content: title }, template: decision ? (approved ? 'green' : 'grey') : 'blue',
  }, body: { elements } };
}

/** Check identity and request lifetime, then consume a decision exactly once in this run. */
export function consumeDecision(state, raw, now = Date.now()) {
  const event = raw?.event ?? raw;
  const actor = event?.operator?.open_id;
  const chatId = event?.context?.open_chat_id ?? raw?.context?.open_chat_id;
  const value = event?.action?.value;
  if (!state.owner || actor !== state.owner.openId || (chatId && chatId !== state.owner.chatId)) {
    return { ok: false, reason: 'unauthorized' };
  }
  if (!value || !['feishu-only', 'codex-harmless-bridge'].includes(value.probe) || !['approve', 'deny'].includes(value.decision) || typeof value.request_id !== 'string') {
    return { ok: false, reason: 'invalid_action' };
  }
  const request = state.requests[value.request_id];
  if (!request || request.runId !== state.runId || request.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (value.probe !== (request.kind === 'codex_permission' ? 'codex-harmless-bridge' : 'feishu-only')) return { ok: false, reason: 'invalid_action' };
  if (request.status !== 'pending') return { ok: false, reason: 'already_processed' };
  request.status = value.decision;
  request.decidedAt = new Date(now).toISOString();
  return { ok: true, requestId: value.request_id, decision: value.decision };
}
