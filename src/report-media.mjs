/** Prepare explicitly referenced local images and Mermaid blocks without replaying uncertain uploads. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';

const EVENT_ID = /^[a-f0-9]{64}$/i;
const IMAGE_KEY = /^img_[a-zA-Z0-9_-]{1,280}$/;
const IMAGE_SUFFIX = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

/** Validate private state storage; media source access remains the injected transport's responsibility. */
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('report_media_requires_private_directory');
}

/** Locate an unescaped matching delimiter, retaining nested brackets and parentheses. */
function closingDelimiter(text, start, opening, closing) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === opening) depth++;
    else if (text[index] === closing && --depth === 0) return index;
  }
  return -1;
}

/** Accept explicit local image references only; no external URL is fetched or uploaded. */
function localImagePath(target) {
  let value = target.trim();
  if (value.startsWith('<')) {
    const end = value.indexOf('>');
    if (end < 0) return null;
    value = value.slice(1, end);
  } else if (!(isAbsolute(value) && IMAGE_SUFFIX.test(value))) value = value.split(/\s/, 1)[0];
  value = value.replace(/\\([()])/g, '$1');
  if (/^file:/i.test(value)) {
    try { value = fileURLToPath(value); } catch { return null; }
  }
  return isAbsolute(value) && IMAGE_SUFFIX.test(value) && !value.includes('\0') ? value : null;
}

/** Extract ordered media outside ordinary code; incomplete Mermaid is explicitly marked unusable. */
export function extractReportMedia(text) {
  if (typeof text !== 'string' || [...text].length > 4000) throw new Error('report_media_invalid_text');
  const ranges = [], items = [];
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((match) => match[0]);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line[0]);
    if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) continue;
    const marker = opening[1][0], length = opening[1].length;
    const endPattern = new RegExp(`^ {0,3}${marker}{${length},}[ \\t]*\\r?\\n?$`);
    let end = index + 1;
    for (; end < lines.length && !endPattern.test(lines[end][0]); end++);
    const start = line.index, finish = end < lines.length ? lines[end].index + lines[end][0].length : text.length;
    ranges.push({ start, end: finish });
    if (opening[2].trim().split(/\s/, 1)[0].toLowerCase() === 'mermaid') {
      items.push({ kind: 'mermaid', source: text.slice(start + line[0].length, end < lines.length ? lines[end].index : finish).trim(),
        start, end: finish, complete: end < lines.length, label: '流程图' });
    }
    index = end;
  }
  for (let index = 0; index < text.length;) {
    const code = ranges.find((range) => index >= range.start && index < range.end);
    if (code) { index = code.end; continue; }
    if (text[index] === '\\') { index += 2; continue; }
    if (text[index] === '`') {
      const marker = /^`+/.exec(text.slice(index))[0];
      let end = index + marker.length;
      while ((end = text.indexOf(marker, end)) >= 0 && (text[end - 1] === '`' || text[end + marker.length] === '`')) end += marker.length;
      if (end >= 0) { index = end + marker.length; continue; }
      index += marker.length; continue;
    }
    if (text[index] === '!' && text[index + 1] === '[') {
      const labelEnd = closingDelimiter(text, index + 1, '[', ']');
      if (labelEnd >= 0 && text[labelEnd + 1] === '(') {
        const targetEnd = closingDelimiter(text, labelEnd + 1, '(', ')');
        if (targetEnd >= 0) {
          const source = localImagePath(text.slice(labelEnd + 2, targetEnd));
          if (source) items.push({ kind: 'image', source, start: index, end: targetEnd + 1,
            complete: true, label: text.slice(index + 2, labelEnd).replace(/[\r\n]/g, ' ').slice(0, 80) || '图片' });
          index = targetEnd + 1; continue;
        }
      }
    }
    index++;
  }
  return items.sort((left, right) => left.start - right.start);
}

/** Keep rewritten text within the original report contract while making any shortening explicit. */
function replaceSources(text, replacements, notices) {
  let result = text;
  for (const item of replacements.sort((left, right) => right.start - left.start)) result = result.slice(0, item.start) + item.replacement + result.slice(item.end);
  if ([...result].length > 4000) {
    const note = '\n（媒体说明较长，余下内容请在桌面聊天查看）';
    result = [...result].slice(0, 4000 - [...note].length).join('') + note;
    notices.push('媒体说明较长，本轮文字已缩短。');
  }
  return result;
}

/** Create a persistent preparation callback; image upload/render functions never receive arbitrary URLs. */
export function createReportMediaPreparer({ directory, uploadImage, renderMermaid, maxImages = 4, log = () => {} }) {
  if (!isAbsolute(directory) || typeof uploadImage !== 'function' || typeof renderMermaid !== 'function' || !Number.isInteger(maxImages) || maxImages < 1 || maxImages > 4) throw new Error('report_media_invalid_configuration');
  privateDirectory(directory);

  /** One report item owns one immutable claim, independent from the report's eventual message ack. */
  async function prepareItem(report, item, index) {
    const sourceHash = createHash('sha256').update(item.kind + '\0' + item.source).digest('hex');
    const itemId = createHash('sha256').update(`${report.eventId}\0${index}\0${sourceHash}`).digest('hex');
    const statePath = join(directory, `${itemId}.json`), claimPath = join(directory, `${itemId}.claim`);
    const identity = { version: 1, itemId, eventId: report.eventId, index, kind: item.kind, sourceHash };
    if (existsSync(statePath)) {
      const state = readPrivateJson(statePath);
      if (Object.entries(identity).some(([key, value]) => state[key] !== value)) throw new Error('report_media_state_identity_changed');
      if (state.status === 'uploaded' && IMAGE_KEY.test(state.imageKey ?? '')) return state;
      if (state.status === 'attempting') {
        const unknown = { ...state, status: 'unknown', reason: 'previous_attempt_unconfirmed' };
        writePrivateJson(statePath, unknown); return unknown;
      }
      if (['failed', 'unknown'].includes(state.status)) return state;
      throw new Error('report_media_invalid_state');
    }
    try { writeFileSync(claimPath, JSON.stringify(identity) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error?.code === 'EEXIST') return { ...identity, status: 'unknown', reason: 'attempt_already_claimed' };
      throw error;
    }
    let state = { ...identity, status: 'attempting', stage: item.kind === 'mermaid' ? 'rendering' : 'uploading', attemptedAtMs: Date.now() };
    writePrivateJson(statePath, state);
    let path = item.source;
    if (item.kind === 'mermaid') {
      try {
        const rendered = await renderMermaid(item.source);
        if (!rendered || rendered.status && rendered.status !== 'rendered' || !isAbsolute(rendered.path ?? '')) throw new Error('mermaid_not_rendered');
        path = rendered.path;
      } catch (error) {
        const renderCode = /^mermaid_(?:launch|document|library|diagram|fonts|screenshot)_failed$|^mermaid_render_timeout$/.test(error?.code ?? '') ? error.code : 'mermaid_render_failed';
        state = { ...state, status: 'failed', reason: 'mermaid_render_failed', renderCode };
        writePrivateJson(statePath, state);
        log('report_media_prepared', { eventId: report.eventId, index, kind: item.kind, status: 'failed', renderCode });
        return state;
      }
      state = { ...state, stage: 'uploading' }; writePrivateJson(statePath, state);
    }
    try {
      const result = await uploadImage(path, { sessionId: report.sessionId });
      const key = typeof result === 'string' ? result : result?.imageKey;
      if ((typeof result === 'string' || result?.status === 'uploaded' || result?.status === undefined) && IMAGE_KEY.test(key ?? '')) {
        state = { ...state, status: 'uploaded', imageKey: key };
      } else state = { ...state, status: result?.status === 'failed' ? 'failed' : 'unknown', reason: result?.status === 'failed' ? 'image_upload_failed' : 'image_upload_unconfirmed' };
    } catch { state = { ...state, status: 'unknown', reason: 'image_upload_unconfirmed' }; }
    writePrivateJson(statePath, state);
    log('report_media_prepared', { eventId: report.eventId, index, kind: item.kind, status: state.status });
    return state;
  }

  /** Continue delivering text when an image fails; only confirmed image keys become native elements. */
  return async function prepareReportMedia(report) {
    if (!report || !EVENT_ID.test(report.eventId ?? '') || typeof report.lastAssistantMessage !== 'string' || [...report.lastAssistantMessage].length > 4000) throw new Error('report_media_invalid_report');
    const items = extractReportMedia(report.lastAssistantMessage), elements = [], notices = [], replacements = [];
    for (const [index, item] of items.entries()) {
      const name = `${item.kind === 'mermaid' ? '流程图' : '图片'} ${index + 1}`;
      let status;
      if (index >= maxImages) status = { status: 'skipped', reason: 'image_count_limit' };
      else if (!item.complete || !item.source) status = { status: 'failed', reason: 'incomplete_mermaid' };
      else {
        try { status = await prepareItem(report, item, index); }
        catch { status = { status: 'failed', reason: 'media_state_unavailable' }; }
      }
      if (status.status === 'uploaded') {
        elements.push({ tag: 'img', img_key: status.imageKey, alt: { tag: 'plain_text', content: `${name}：${item.label}` } });
        replacements.push({ ...item, replacement: `（${name}见下图）\n` });
      } else {
        const description = status.reason === 'incomplete_mermaid' ? '代码不完整，未生成图片'
          : status.reason === 'image_count_limit' ? `超过本轮${maxImages}张限制，未发送`
          : status.reason === 'mermaid_render_failed' ? '生成失败，文字报告仍保留'
          : status.status === 'unknown' ? '处理结果不确定，本次不会重复上传' : '处理失败，文字报告仍保留';
        notices.push(`${name}：${description}。`);
        replacements.push({ ...item, replacement: `（${name}未发送，见说明）\n` });
      }
    }
    return { elements, notices, bodyText: replaceSources(report.lastAssistantMessage, replacements, notices) };
  };
}
