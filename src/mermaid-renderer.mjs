/** Render bounded Mermaid locally to private PNGs; diagram text never leaves this computer. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';

const require = createRequire(import.meta.url);
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_PLAYWRIGHT = require.resolve('playwright-core');
const MAX_SOURCE_CHARACTERS = 16000;
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const MAX_PNG_DIMENSION = 12000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RENDER_VERSION = 'mermaid-12.3.0-private-png-v1';

/** Accept diagram syntax while excluding directives, external assets and active navigation. */
export function validateMermaidSource(source) {
  if (typeof source !== 'string' || !source.trim() || [...source].length > MAX_SOURCE_CHARACTERS || source.includes('\0')) throw new Error('mermaid_invalid_source');
  const value = source.replace(/\r\n?/g, '\n').trim();
  if (/^---(?:\n|$)/.test(value) || /%%\s*\{/.test(value) || /(?:^|[;\n])\s*click\s+/i.test(value) ||
      /(?:https?|ftp|file|data|javascript|vbscript):/i.test(value) || /<\s*(?:script|iframe|object|embed|img|image|svg|a)\b/i.test(value) ||
      /@\s*\{[^}]*\b(?:img|icon)\s*:/is.test(value)) throw new Error('mermaid_external_or_active_content');
  return value;
}

/** Find complete or truncated Mermaid fences, preserving UTF-16 offsets into the original reply. */
export function extractMermaidBlocks(markdown, { maxBlocks = 4 } = {}) {
  if (typeof markdown !== 'string' || [...markdown].length > 100000 || !Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 16) throw new Error('mermaid_invalid_markdown');
  const lines = [...markdown.matchAll(/[^\n]*(?:\n|$)/g)].filter((match) => match[0]);
  const blocks = [];
  for (let index = 0; index < lines.length; index++) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)?$/.exec(lines[index][0]);
    if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) continue;
    const start = lines[index].index, bodyStart = start + lines[index][0].length;
    const marker = opening[1][0], closing = new RegExp(`^ {0,3}${marker}{${opening[1].length},}[ \\t]*(?:\\r?\\n)?$`);
    const language = opening[2].trim().split(/\s/, 1)[0].toLowerCase();
    let bodyEnd = markdown.length, end = markdown.length, closed = false;
    for (index++; index < lines.length; index++) {
      if (closing.test(lines[index][0])) {
        bodyEnd = lines[index].index; end = bodyEnd + lines[index][0].length; closed = true; break;
      }
    }
    if (language === 'mermaid') {
      if (blocks.length >= maxBlocks) throw new Error('mermaid_too_many_blocks');
      blocks.push({ source: markdown.slice(bodyStart, bodyEnd).replace(/\r\n?/g, '\n').trim(), index: blocks.length, start, end, closed });
    }
  }
  return blocks;
}

/** Require owned mode-700 storage, with no final-component directory alias. */
function ensurePrivateDirectory(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('mermaid_absolute_directory_required');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('mermaid_private_directory_required');
}

/** Read only bounded private regular artifacts; cache corruption is never called a valid render. */
function privateFile(path, maximumBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > maximumBytes) throw new Error('mermaid_invalid_cache_file');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** Unlike existsSync, lstat also detects a dangling alias instead of treating it as a cache miss. */
function cacheEntryExists(path) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600)) throw new Error('mermaid_invalid_cache_file');
  return Boolean(info);
}

/** Enforce the actual output image budget before caching or handing a file to the uploader. */
export function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > MAX_PNG_BYTES || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('mermaid_invalid_png');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) throw new Error('mermaid_png_dimensions_exceeded');
  return { width, height };
}

/** Recognize Playwright closure signals, never parser messages that echo arbitrary diagram text. */
export function isTransientMermaidBrowserFailure(error) {
  if (error?.message === 'mermaid_render_timeout' || ['TimeoutError', 'TargetClosedError'].includes(error?.name)) return true;
  const firstLine = typeof error?.message === 'string' ? error.message.split('\n', 1)[0].trim() : '';
  return /^(?:(?:browserType\.launch|browser\.newContext|browserContext\.newPage|page\.(?:setContent|addScriptTag|evaluate|screenshot)|locator\.screenshot): )?Target page, context or browser has been closed$/.test(firstLine);
}

/** Use a separate headless Chrome profile, a local bundled library, strict Mermaid and a blocked network. */
async function renderInBrowser(source, { browserExecutable, playwrightModulePath, mermaidBundlePath, timeoutMs }) {
  let browser, timer, stage = 'launch';
  const run = async () => {
    const { chromium } = require(playwrightModulePath);
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true, timeout: Math.min(timeoutMs, 20000),
      args: ['--disable-background-networking', '--no-first-run', '--disable-sync', '--disable-extensions', '--disable-component-update'] });
    stage = 'document';
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
    await context.route('**/*', (route) => route.abort('blockedbyclient'));
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.setContent('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; style-src \'unsafe-inline\'; img-src data:; font-src data:"><style>html,body{margin:0;background:#fff}#diagram{display:inline-block;padding:32px;background:#fff;font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif}svg{display:block}</style></head><body><div id="diagram"></div></body></html>');
    stage = 'library';
    await page.addScriptTag({ content: readFileSync(mermaidBundlePath, 'utf8') });
    stage = 'diagram';
    await page.evaluate(async (diagramSource) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', htmlLabels: false,
        fontFamily: 'PingFang SC, Microsoft YaHei, Arial, sans-serif', maxTextSize: 16000, maxEdges: 200,
        flowchart: { htmlLabels: false }, themeVariables: { background: '#ffffff' } });
      const result = await mermaid.render('private_mermaid_diagram', diagramSource);
      const holder = document.getElementById('diagram');
      holder.innerHTML = result.svg;
      holder.querySelectorAll('script,iframe,object,embed,image,img,a').forEach((element) => element.remove());
      const svg = holder.querySelector('svg');
      if (!svg) throw new Error('mermaid_missing_svg');
      const box = svg.viewBox.baseVal;
      const naturalWidth = box.width, naturalHeight = box.height;
      if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) throw new Error('mermaid_empty_svg');
      const scale = Math.min(1336 / naturalWidth, 5936 / naturalHeight, 2);
      if (scale < 0.25) throw new Error('mermaid_diagram_too_large_to_read');
      svg.style.maxWidth = 'none';
      svg.setAttribute('width', String(Math.ceil(naturalWidth * scale)));
      svg.setAttribute('height', String(Math.ceil(naturalHeight * scale)));
    }, source);
    stage = 'fonts';
    await page.evaluate(() => document.fonts.ready);
    stage = 'screenshot';
    return Buffer.from(await page.locator('#diagram').screenshot({ type: 'png', omitBackground: false, scale: 'device', timeout: timeoutMs }));
  };
  try {
    return await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('mermaid_render_timeout')), timeoutMs); })]);
  } catch (error) {
    const failure = new Error('mermaid_render_failed');
    failure.code = error?.message === 'mermaid_render_timeout' ? 'mermaid_render_timeout' : `mermaid_${stage}_failed`;
    // Only a local browser timeout/closure can repeat; parser errors are deterministic.
    failure.retryable = isTransientMermaidBrowserFailure(error);
    throw failure;
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close().catch(() => {});
  }
}

/** Build a private source-keyed cache; the optional renderer injection is for isolated offline checks. */
export function createMermaidRenderer({ directory, browserExecutable = DEFAULT_CHROME, playwrightModulePath = DEFAULT_PLAYWRIGHT,
  mermaidBundlePath = require.resolve('mermaid/dist/mermaid.min.js'), timeoutMs = 25000, renderPng = renderInBrowser, log = () => {} } = {}) {
  ensurePrivateDirectory(directory);
  if (![browserExecutable, playwrightModulePath, mermaidBundlePath].every((value) => typeof value === 'string' && isAbsolute(value)) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000 || typeof renderPng !== 'function' || typeof log !== 'function') throw new Error('mermaid_invalid_options');
  const inFlight = new Map();
  return {
    /** Render once per normalized source; validate cache identity and file bytes before every reuse. */
    async render(rawSource) {
      const source = validateMermaidSource(rawSource);
      const sourceHash = createHash('sha256').update(`${RENDER_VERSION}\0${source}`).digest('hex');
      const path = join(directory, `${sourceHash}.png`), metadataPath = join(directory, `${sourceHash}.json`);
      const hasPng = cacheEntryExists(path), hasMetadata = cacheEntryExists(metadataPath);
      if (hasPng && hasMetadata) {
        const bytes = privateFile(path, MAX_PNG_BYTES), metadata = JSON.parse(privateFile(metadataPath, 4096).toString());
        const dimensions = pngDimensions(bytes), sha256 = createHash('sha256').update(bytes).digest('hex');
        if (metadata.version !== 1 || metadata.sourceHash !== sourceHash || metadata.sha256 !== sha256 || metadata.width !== dimensions.width || metadata.height !== dimensions.height) throw new Error('mermaid_cache_identity_mismatch');
        return { status: 'rendered', path, sha256, sourceHash, ...dimensions, cached: true };
      }
      if (inFlight.has(sourceHash)) return inFlight.get(sourceHash);
      const pending = (async () => {
        let bytes;
        const deadline = Date.now() + timeoutMs;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            bytes = await renderPng(source, { browserExecutable, playwrightModulePath, mermaidBundlePath,
              timeoutMs: attempt === 1 ? timeoutMs : Math.max(1, deadline - Date.now()) });
            log('mermaid_render_attempt', { attempt, status: 'rendered' });
            break;
          } catch (error) {
            const code = /^mermaid_(?:launch|document|library|diagram|fonts|screenshot)_failed$|^mermaid_render_timeout$/.test(error?.code ?? '') ? error.code : 'mermaid_render_failed';
            const retry = attempt === 1 && error?.retryable === true && code !== 'mermaid_render_failed' && deadline - Date.now() >= 1000;
            log('mermaid_render_attempt', { attempt, status: 'failed', code, retry });
            if (!retry) throw error;
          }
        }
        const dimensions = pngDimensions(bytes), sha256 = createHash('sha256').update(bytes).digest('hex');
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
        const metaTemporary = `${metadataPath}.${randomUUID()}.tmp`;
        writeFileSync(metaTemporary, `${JSON.stringify({ version: 1, sourceHash, sha256, ...dimensions, bytes: bytes.length })}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(metaTemporary, metadataPath);
        return { status: 'rendered', path, sha256, sourceHash, ...dimensions, cached: false };
      })();
      inFlight.set(sourceHash, pending);
      try { return await pending; } finally { inFlight.delete(sourceHash); }
    },
  };
}
