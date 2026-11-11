/** Bound local image access and Feishu upload/download; callers own recipient and message authorization. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative } from 'node:path';
import { readPrivateJson, writePrivateJson } from './probe-core.mjs';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RESOURCE_ID = /^[a-zA-Z0-9_-]{1,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SUFFIXES = { png: ['.png'], jpeg: ['.jpg', '.jpeg'], gif: ['.gif'], webp: ['.webp'], bmp: ['.bmp'] };

/** Use a fixed error vocabulary: external error bodies, tokens and local paths never escape. */
function apiFailure(error, upload) {
  const raw = error?.response?.data?.code ?? error?.code;
  const code = typeof raw === 'number' || (typeof raw === 'string' && /^[A-Z0-9_-]{1,64}$/.test(raw)) ? raw : undefined;
  const apiCode = error?.response?.data?.code ?? (typeof error?.code === 'number' && error.code > 0 ? error.code : undefined);
  const httpStatus = error?.response?.status;
  const definitive = ((typeof apiCode === 'number' || (typeof apiCode === 'string' && /^\d+$/.test(apiCode))) && Number(apiCode) !== 0) ||
    (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500);
  return { status: upload && !definitive ? 'unknown' : 'failed', reason: definitive ? 'image_api_rejected' : 'image_transport_failed', ...(code !== undefined ? { code } : {}) };
}

/** Detect only raster formats accepted by this connector, independently of untrusted names/headers. */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') return { mime: 'image/png', extension: 'png' };
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', extension: 'jpeg' };
  if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return { mime: 'image/gif', extension: 'gif' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  if (buffer.length >= 14 && buffer.toString('ascii', 0, 2) === 'BM') return { mime: 'image/bmp', extension: 'bmp' };
  return null;
}

/** Validate a usable bounded budget; a caller may tighten but never enlarge the platform upload limit. */
function imageLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_IMAGE_BYTES) throw new Error('image_invalid_size_limit');
  return maxBytes;
}

/** Bound reads to max+1 bytes so a growing local file cannot cause an unbounded allocation. */
function readBoundedDescriptor(fd, limit) {
  const chunks = [], chunk = Buffer.alloc(Math.min(65536, limit + 1));
  let size = 0;
  while (size <= limit) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, limit + 1 - size), null);
    if (!count) break;
    chunks.push(Buffer.from(chunk.subarray(0, count))); size += count;
  }
  if (size > limit) throw new Error('image_too_large');
  return Buffer.concat(chunks, size);
}

/** Read an explicitly referenced raster image only inside caller-approved canonical directories. */
function readLocalImage(path, { allowedRoots, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const limit = imageLimit(maxBytes);
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || !Array.isArray(allowedRoots) || !allowedRoots.length) throw new Error('image_path_not_allowed');
  const original = lstatSync(path);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error('image_requires_regular_file');
  const canonical = realpathSync(path);
  const allowed = allowedRoots.some((root) => {
    if (typeof root !== 'string' || !isAbsolute(root)) return false;
    const resolved = realpathSync(root), info = lstatSync(resolved);
    if (!info.isDirectory()) return false;
    const within = relative(resolved, canonical);
    return within !== '' && within !== '..' && !within.startsWith('../') && !isAbsolute(within);
  });
  if (!allowed) throw new Error('image_path_not_allowed');
  const before = lstatSync(canonical);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('image_requires_regular_file');
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino) throw new Error('image_file_changed');
    if (actual.size < 1) throw new Error('image_empty');
    if (actual.size > limit) throw new Error('image_too_large');
    const buffer = readBoundedDescriptor(fd, limit), after = fstatSync(fd);
    if (after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || buffer.length !== actual.size) throw new Error('image_file_changed');
    const type = detectImageType(buffer);
    if (!type || !SUFFIXES[type.extension].includes(extname(canonical).toLowerCase())) throw new Error('image_format_not_supported');
    return { buffer, ...type, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
  } finally { closeSync(fd); }
}

/** Keep local filesystem errors bounded and path-free for callers and diagnostics. */
export function readAllowedImage(path, options = {}) {
  try { return readLocalImage(path, options); }
  catch (error) {
    if (/^image_[a-z_]+$/.test(error?.message ?? '')) throw error;
    throw new Error('image_local_read_failed');
  }
}

/** Ensure cache storage is owned, mode 700 and not a redirected final directory. */
function privateDirectory(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('image_invalid_cache_directory');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('image_cache_requires_private_directory');
}

/** Enforce a deadline around an SDK call without interpreting a late upload as definitely failed. */
async function withDeadline(work, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('image_invalid_timeout');
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new Error('image_timeout'); error.code = 'ETIMEDOUT'; reject(error); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Upload validated bytes; callers must not automatically replay an unknown upload outcome. */
export async function uploadImage(client, path, { allowedRoots, maxBytes = MAX_IMAGE_BYTES, timeoutMs = 30000 } = {}) {
  let image;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('image_invalid_timeout');
    image = readAllowedImage(path, { allowedRoots, maxBytes });
  }
  catch (error) { return { status: 'failed', reason: /^image_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'image_local_read_failed' }; }
  try {
    const response = await withDeadline(() => client.im.v1.image.create({ data: { image_type: 'message', image: image.buffer } }), timeoutMs);
    if (response?.code !== undefined && Number(response.code) !== 0) return { status: 'failed', reason: 'image_api_rejected', ...(typeof response.code === 'number' || /^\d{1,12}$/.test(response.code) ? { code: response.code } : {}) };
    const imageKey = response?.image_key ?? response?.data?.image_key;
    if (typeof imageKey !== 'string' || !RESOURCE_ID.test(imageKey)) return { status: 'unknown', reason: 'image_upload_unconfirmed' };
    return { status: 'uploaded', imageKey, sha256: image.sha256, size: image.size, mime: image.mime, extension: image.extension };
  } catch (error) { return apiFailure(error, true); }
}

/** Read the streamed message resource within both byte and wall-clock limits; MIME headers are hints only. */
async function readImageStream(resource, maxBytes, timeoutMs) {
  const contentLength = resource?.headers?.['content-length'] ?? resource?.headers?.['Content-Length'];
  const stream = resource?.getReadableStream?.();
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error('image_resource_not_stream');
  if (contentLength !== undefined && /^\d+$/.test(String(contentLength)) && Number(contentLength) > maxBytes) {
    stream.destroy?.(); throw new Error('image_too_large');
  }
  const chunks = [], iterator = stream[Symbol.asyncIterator]();
  let size = 0;
  const started = Date.now();
  try {
    for (;;) {
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new Error('image_download_timeout');
      const result = await withDeadline(() => iterator.next(), remaining);
      if (result.done) break;
      const chunk = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
      size += chunk.length;
      if (size > maxBytes) throw new Error('image_too_large');
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks, size);
    if (!buffer.length) throw new Error('image_empty');
    if (!detectImageType(buffer)) {
      if (buffer.length <= 65536) {
        let value;
        try { value = JSON.parse(buffer.toString('utf8')); } catch { /* Not an image or a structured API rejection. */ }
        if (value?.code !== undefined && Number(value.code) !== 0) {
          const error = new Error('resource_api_rejected'); error.response = { data: { code: value.code } }; throw error;
        }
      }
      throw new Error('image_format_not_supported');
    }
    return buffer;
  } catch (error) { stream.destroy?.(); throw error; }
}

/** Reopen only a complete verified cache entry; truncated or replaced files are never reported as downloaded. */
function cachedImage(directory, cacheId, keyHash, maxBytes) {
  const path = join(directory, `${cacheId}.json`);
  if (!existsSync(path)) return null;
  const metadata = readPrivateJson(path);
  if (metadata.version !== 1 || metadata.cacheId !== cacheId || metadata.resourceHash !== keyHash || !SHA256.test(metadata.sha256 ?? '') ||
      !Object.hasOwn(SUFFIXES, metadata.extension) || metadata.filename !== `${cacheId}.${metadata.extension}`) throw new Error('image_cache_invalid');
  const imagePath = join(directory, metadata.filename), image = readAllowedImage(imagePath, { allowedRoots: [directory], maxBytes });
  const info = lstatSync(imagePath);
  if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || image.sha256 !== metadata.sha256 || image.size !== metadata.size || image.mime !== metadata.mime) throw new Error('image_cache_invalid');
  return { status: 'cached', path: imagePath, sha256: image.sha256, size: image.size, mime: image.mime, extension: image.extension };
}

/** Download a verified owner's image resource once by stable message+key identity; no arbitrary URL is fetched. */
export async function downloadMessageImage(client, { messageId, imageKey, directory, maxBytes = MAX_IMAGE_BYTES, timeoutMs = 30000 } = {}) {
  let cacheId, resourceHash, temporary;
  try {
    const limit = imageLimit(maxBytes);
    if (typeof messageId !== 'string' || !RESOURCE_ID.test(messageId) || typeof imageKey !== 'string' || !RESOURCE_ID.test(imageKey)) throw new Error('image_invalid_resource_identity');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('image_invalid_timeout');
    privateDirectory(directory);
    cacheId = createHash('sha256').update(`${messageId}\0${imageKey}`).digest('hex');
    resourceHash = createHash('sha256').update(imageKey).digest('hex');
    const cached = cachedImage(directory, cacheId, resourceHash, limit);
    if (cached) return cached;
    const resource = await withDeadline(() => client.im.v1.messageResource.get({ path: { message_id: messageId, file_key: imageKey }, params: { type: 'image' } }), timeoutMs);
    const buffer = await readImageStream(resource, limit, timeoutMs), type = detectImageType(buffer);
    const sha256 = createHash('sha256').update(buffer).digest('hex'), filename = `${cacheId}.${type.extension}`;
    const target = join(directory, filename);
    temporary = join(directory, `.${cacheId}.${randomUUID()}.tmp`);
    writeFileSync(temporary, buffer, { mode: 0o600, flag: 'wx' });
    try { linkSync(temporary, target); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readAllowedImage(target, { allowedRoots: [directory], maxBytes: limit });
      const info = lstatSync(target);
      if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || current.sha256 !== sha256) throw new Error('image_cache_conflict');
    }
    writePrivateJson(join(directory, `${cacheId}.json`), { version: 1, cacheId, resourceHash, filename, sha256, size: buffer.length, ...type });
    return { status: 'downloaded', path: target, sha256, size: buffer.length, ...type };
  } catch (error) {
    if (/^image_[a-z_]+$/.test(error?.message ?? '')) return { status: 'failed', reason: error.message };
    return apiFailure(error, false);
  } finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
  }
}
