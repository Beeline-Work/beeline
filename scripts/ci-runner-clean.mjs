#!/usr/bin/env node
// Fail closed before deleting anything outside this instance's disposable paths.
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';

const instance = await realpath(process.env.BEELINE_CI_INSTANCE);
const work = join(instance, '_work');
const workspace = resolve(process.env.GITHUB_WORKSPACE ?? '');
const subpath = relative(work, workspace);
if (!subpath || subpath.startsWith('..') || isAbsolute(subpath)) throw new Error('workspace must be inside the runner _work directory');
// Check parents as well as the leaf: a workspace symlink must not escape _work.
let parent = workspace;
while (parent !== instance) {
  try {
    if ((await lstat(parent)).isSymbolicLink()) throw new Error(`refusing symlink: ${parent}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  parent = resolve(parent, '..');
}
for (const directory of [workspace, join(instance, 'job-home'), join(instance, 'job-tmp')]) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}
