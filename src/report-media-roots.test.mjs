import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reportMediaRoots } from './report-media-roots.mjs';

test('only the actual source workspace and explicit media folders are exposed to its report', t => {
  const root = mkdtempSync(join('/tmp','feishu-media-roots-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const media=join(root,'private-media'), a=join(root,'project-a'), b=join(root,'project-b'), unapproved=join(root,'new-project');
  for(const path of [media,a,b,unapproved])mkdirSync(path,{mode:0o700});
  const options={mediaDirectory:media,approvedWorkspaceRoots:[a,b]};
  assert.deepEqual(reportMediaRoots({...options,sourceCwd:a}),[realpathSync(media),realpathSync(a)]);
  assert.deepEqual(reportMediaRoots({...options,sourceCwd:unapproved}),[realpathSync(media)]);
  const sub=join(a,'worktree');mkdirSync(sub);
  assert.deepEqual(reportMediaRoots({...options,sourceCwd:sub}),[realpathSync(media),realpathSync(sub)]);
  const alias=join(a,'outside');symlinkSync(unapproved,alias);
  assert.deepEqual(reportMediaRoots({...options,sourceCwd:alias}),[realpathSync(media)]);
});

test('system roots and canonical aliases cannot become automatic media grants', t => {
  const root=mkdtempSync(join('/tmp','feishu-broad-root-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const media=join(root,'media');mkdirSync(media,{mode:0o700});
  for(const source of ['/','/System','/Library','/private/var',process.env.HOME]) {
    assert.deepEqual(reportMediaRoots({mediaDirectory:media,sourceCwd:source,approvedWorkspaceRoots:[source],explicitMediaRoots:[source]}),[realpathSync(media)]);
  }
  const alias=join(root,'system-alias');symlinkSync('/System',alias);
  assert.deepEqual(reportMediaRoots({mediaDirectory:media,sourceCwd:alias,approvedWorkspaceRoots:[alias],explicitMediaRoots:[alias]}),[realpathSync(media)]);
});
