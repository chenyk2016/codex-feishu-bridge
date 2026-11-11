/** Offline transport checks use private fixtures and SDK-shaped doubles; no account or network access. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { MAX_IMAGE_BYTES, detectImageType, downloadMessageImage, readAllowedImage, uploadImage } from './media-transport.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z6r8AAAAASUVORK5CYII=', 'base64');

/** Give each test a real owned image directory and clean it after completion. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'feishu-media-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const allowed = join(root, 'workspace'), cache = join(root, 'cache');
  mkdirSync(allowed, { mode: 0o700 }); mkdirSync(cache, { mode: 0o700 });
  const image = join(allowed, 'one.png'); writeFileSync(image, PNG, { mode: 0o600 });
  return { root, allowed, cache, image };
}

/** Match the verified SDK's streamed resource return contract. */
function clientWithResource(buffer = PNG, headers = {}) {
  const calls = [];
  return { calls, im: { v1: { messageResource: { get: async (payload) => {
    calls.push(payload);
    return { headers, getReadableStream: () => Readable.from([buffer.subarray(0, 20), buffer.subarray(20)]) };
  } } } } };
}

test('magic identifies only supported raster formats, independent of a MIME header', () => {
  assert.deepEqual(detectImageType(PNG), { mime: 'image/png', extension: 'png' });
  assert.equal(detectImageType(Buffer.from([255, 216, 255, 224])).extension, 'jpeg');
  assert.equal(detectImageType(Buffer.from('GIF89a0000')).extension, 'gif');
  assert.equal(detectImageType(Buffer.from('RIFF0000WEBP')).extension, 'webp');
  assert.equal(detectImageType(Buffer.from('BM000000000000')).extension, 'bmp');
  assert.equal(detectImageType(Buffer.from('<html>not an image</html>')), null);
  assert.equal(detectImageType('PNG'), null);
});

test('local upload bytes come from an explicitly allowed canonical regular image', (t) => {
  const f = fixture(t), value = readAllowedImage(f.image, { allowedRoots: [f.allowed] });
  assert.equal(value.size, PNG.length); assert.deepEqual(value.buffer, PNG);
  assert.equal(value.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.throws(() => readAllowedImage(f.image, { allowedRoots: [f.allowed], maxBytes: PNG.length - 1 }), /image_too_large/);
  assert.throws(() => readAllowedImage(f.image, { allowedRoots: [f.allowed], maxBytes: MAX_IMAGE_BYTES + 1 }), /invalid_size_limit/);
  assert.throws(() => readAllowedImage(join(f.allowed, 'missing.png'), { allowedRoots: [f.allowed] }), (error) => error.message === 'image_local_read_failed');
});

test('paths cannot escape roots, follow a final symlink, upload directories or mismatch their suffix', (t) => {
  const f = fixture(t), outside = join(f.root, 'outside.png'); writeFileSync(outside, PNG);
  const link = join(f.allowed, 'link.png'); symlinkSync(f.image, link);
  assert.throws(() => readAllowedImage(outside, { allowedRoots: [f.allowed] }), /path_not_allowed/);
  assert.throws(() => readAllowedImage(link, { allowedRoots: [f.allowed] }), /regular_file/);
  assert.throws(() => readAllowedImage(f.allowed, { allowedRoots: [f.allowed] }), /regular_file/);
  assert.throws(() => readAllowedImage('relative.png', { allowedRoots: [f.allowed] }), /path_not_allowed/);
  const wrong = join(f.allowed, 'one.jpg'); writeFileSync(wrong, PNG);
  assert.throws(() => readAllowedImage(wrong, { allowedRoots: [f.allowed] }), /format_not_supported/);
  const redirected = join(f.allowed, 'elsewhere'); symlinkSync(f.root, redirected);
  assert.throws(() => readAllowedImage(join(redirected, 'outside.png'), { allowedRoots: [f.allowed] }), /path_not_allowed/);
});

test('upload uses message image bytes and accepts actual SDK direct and response-envelope keys', async (t) => {
  const f = fixture(t);
  for (const response of [{ image_key: 'img_v3_direct' }, { code: 0, data: { image_key: 'img_v3_wrapped' } }]) {
    let calls = 0;
    const client = { im: { v1: { image: { create: async (payload) => {
      calls++; assert.equal(payload.data.image_type, 'message'); assert.deepEqual(payload.data.image, PNG); return response;
    } } } } };
    const result = await uploadImage(client, f.image, { allowedRoots: [f.allowed] });
    assert.equal(result.status, 'uploaded'); assert.equal(result.imageKey, response.image_key ?? response.data.image_key);
    assert.equal(calls, 1);
  }
});

test('validation and explicit API rejection differ from uncertain network or malformed upload outcomes', async (t) => {
  const f = fixture(t);
  for (const code of [99991672, '99991672']) {
    const client = { im: { v1: { image: { create: async () => ({ code, image_key: 'img_must_not_be_accepted' }) } } } };
    assert.equal((await uploadImage(client, f.image, { allowedRoots: [f.allowed] })).status, 'failed');
  }
  const disconnected = { im: { v1: { image: { create: async () => { const e = new Error('private payload must not escape'); e.code = 'ECONNRESET'; throw e; } } } } };
  assert.deepEqual(await uploadImage(disconnected, f.image, { allowedRoots: [f.allowed] }), { status: 'unknown', reason: 'image_transport_failed', code: 'ECONNRESET' });
  const malformed = { im: { v1: { image: { create: async () => ({ code: 0 }) } } } };
  assert.equal((await uploadImage(malformed, f.image, { allowedRoots: [f.allowed] })).status, 'unknown');
  assert.equal((await uploadImage(malformed, '/outside/not-there.png', { allowedRoots: [f.allowed] })).status, 'failed');
  assert.deepEqual(await uploadImage(malformed, f.image, { allowedRoots: [f.allowed], timeoutMs: 0 }), { status: 'failed', reason: 'image_invalid_timeout' });
});

test('download uses messageResource, privately publishes bytes and persists verified deduplication', async (t) => {
  const f = fixture(t), client = clientWithResource(PNG, { 'content-type': 'text/plain' });
  const options = { messageId: 'om_owner_image', imageKey: 'img_v3_received', directory: f.cache };
  const first = await downloadMessageImage(client, options);
  assert.equal(first.status, 'downloaded'); assert.deepEqual(readFileSync(first.path), PNG);
  assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.equal(statSync(f.cache).mode & 0o777, 0o700);
  const second = await downloadMessageImage(client, options);
  assert.equal(second.status, 'cached'); assert.equal(second.path, first.path); assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], { path: { message_id: options.messageId, file_key: options.imageKey }, params: { type: 'image' } });
  assert.ok(readdirSync(f.cache).every((name) => !name.includes('om_owner_image') && !name.includes('img_v3_received') && !name.endsWith('.tmp')));
});

test('one message with distinct image keys cannot share or overwrite another cached image', async (t) => {
  const f = fixture(t), client = clientWithResource();
  const a = await downloadMessageImage(client, { messageId: 'om_multi', imageKey: 'img_one', directory: f.cache });
  const b = await downloadMessageImage(client, { messageId: 'om_multi', imageKey: 'img_two', directory: f.cache });
  assert.equal(a.status, 'downloaded'); assert.equal(b.status, 'downloaded'); assert.notEqual(a.path, b.path); assert.equal(client.calls.length, 2);
});

test('oversized headers and stream bytes fail without finalized cache files', async (t) => {
  const f = fixture(t);
  const header = await downloadMessageImage(clientWithResource(PNG, { 'content-length': String(MAX_IMAGE_BYTES + 1) }), { messageId: 'om_large_header', imageKey: 'img_one', directory: f.cache });
  assert.equal(header.reason, 'image_too_large');
  const streamed = await downloadMessageImage(clientWithResource(PNG), { messageId: 'om_large_stream', imageKey: 'img_one', directory: f.cache, maxBytes: PNG.length - 1 });
  assert.equal(streamed.reason, 'image_too_large'); assert.equal(readdirSync(f.cache).length, 0);
});

test('MIME cannot disguise non-images; structured API rejections retain safe error codes', async (t) => {
  const f = fixture(t);
  const bad = await downloadMessageImage(clientWithResource(Buffer.from('<html>not image</html>'), { 'content-type': 'image/png' }), { messageId: 'om_bad', imageKey: 'img_bad', directory: f.cache });
  assert.equal(bad.reason, 'image_format_not_supported');
  const denied = await downloadMessageImage(clientWithResource(Buffer.from('{"code":99991672,"msg":"private details"}')), { messageId: 'om_denied', imageKey: 'img_one', directory: f.cache });
  assert.deepEqual(denied, { status: 'failed', reason: 'image_api_rejected', code: 99991672 });
});

test('cache corruption or a symlink replacement is not a verified cache hit and triggers no API replay', async (t) => {
  const f = fixture(t), client = clientWithResource();
  const options = { messageId: 'om_cached', imageKey: 'img_one', directory: f.cache };
  const first = await downloadMessageImage(client, options);
  writeFileSync(first.path, PNG.subarray(0, 24));
  const bad = await downloadMessageImage(client, options);
  assert.equal(bad.status, 'failed'); assert.equal(client.calls.length, 1);
  unlinkSync(first.path); symlinkSync(f.image, first.path);
  assert.equal((await downloadMessageImage(client, options)).status, 'failed'); assert.equal(client.calls.length, 1);
});

test('invalid resource ids, shared cache folders and redirected directories are rejected before network', async (t) => {
  const f = fixture(t), client = clientWithResource();
  assert.equal((await downloadMessageImage(client, { messageId: '../message', imageKey: 'img_one', directory: f.cache })).status, 'failed');
  chmodSync(f.cache, 0o755);
  assert.equal((await downloadMessageImage(client, { messageId: 'om_owner', imageKey: 'img_one', directory: f.cache })).reason, 'image_cache_requires_private_directory');
  const link = join(f.root, 'cache-link'); symlinkSync(f.cache, link);
  assert.equal((await downloadMessageImage(client, { messageId: 'om_owner', imageKey: 'img_one', directory: link })).reason, 'image_cache_requires_private_directory');
  assert.equal(client.calls.length, 0);
});

test('stalled streams time out and an upload deadline remains unknown without a second upload', async (t) => {
  const f = fixture(t); let uploadCalls = 0;
  const client = { im: { v1: { image: { create: () => { uploadCalls++; return new Promise(() => {}); } }, messageResource: { get: async () => ({ getReadableStream: () => new Readable({ read() {} }) }) } } } };
  assert.equal((await uploadImage(client, f.image, { allowedRoots: [f.allowed], timeoutMs: 5 })).status, 'unknown');
  const result = await downloadMessageImage(client, { messageId: 'om_stall', imageKey: 'img_one', directory: f.cache, timeoutMs: 5 });
  assert.equal(result.status, 'failed'); assert.equal(uploadCalls, 1); assert.equal(readdirSync(f.cache).length, 0);
});
