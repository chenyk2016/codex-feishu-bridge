/** Expanding report recipients never expands the connector's approved file roots. */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

function canonicalDirectory(path) {
  try { return typeof path === 'string' && isAbsolute(path) && existsSync(path) && statSync(path).isDirectory() ? realpathSync(path) : undefined; }
  catch { return undefined; }
}
function within(parent, path) {
  const suffix = relative(parent, path);
  return suffix === '' || suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix);
}
function broadDirectory(path, home) {
  if (['/', home, '/Users', '/Volumes', '/private', '/private/tmp', '/tmp'].includes(path)) return true;
  if (['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/dev', '/proc', '/private/var'].some(root => within(root, path))) return true;
  return ['Desktop','Documents','Downloads','Pictures','Movies','Music','Public','.ssh','.aws','.gnupg','.kube','.config','.codex','Library'].some(name => path === resolve(home,name));
}

/** Grant the source folder only inside already approved workspaces, plus explicit media roots. */
export function reportMediaRoots({ mediaDirectory, sourceCwd, approvedWorkspaceRoots = [], explicitMediaRoots = [], homeDirectory = homedir() }) {
  const home = canonicalDirectory(homeDirectory) ?? resolve(homeDirectory), roots = [];
  const media = canonicalDirectory(mediaDirectory);
  if (media) roots.push(media);
  const approved = approvedWorkspaceRoots.map(canonicalDirectory).filter(path => path && !broadDirectory(path, home));
  const source = canonicalDirectory(sourceCwd);
  if (source && !broadDirectory(source, home) && approved.some(root => within(root, source))) roots.push(source);
  for (const path of explicitMediaRoots.map(canonicalDirectory)) {
    if (path && !broadDirectory(path, home)) roots.push(path);
  }
  return [...new Set(roots)];
}
