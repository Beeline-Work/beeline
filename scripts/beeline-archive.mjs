import { execFileSync } from 'node:child_process';
import { lstat, lutimes, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = [prefix, entry.name].filter(Boolean).join('/');
    if (entry.isDirectory()) files.push(...await filesUnder(directory, name));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(name);
    else throw new Error(`unsupported bundle entry: ${name}`);
  }
  return files;
}

export async function writeBeelineArchive(staging, archive, workdir) {
  const files = (await filesUnder(staging)).sort();
  for (const name of files) {
    const path = join(staging, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) await lutimes(path, 0, 0);
    else await utimes(path, 0, 0);
  }
  const list = resolve(workdir, 'bundle-files.txt');
  await writeFile(list, `${files.join('\n')}\n`);
  const raw = archive.slice(0, -3);
  await rm(raw, { force: true });
  execFileSync('tar', ['-C', staging, '-cf', raw, '-T', list], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  execFileSync('gzip', ['-n', '-f', raw]);
}
