// Install the exact release artifact in the image through the normal verifier.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const [version, commit] = process.argv.slice(2);
const root = '/bundle';
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
const bundle = manifest.bundles?.['linux-x64'];
if (
  !/^[0-9a-f]{40}$/.test(commit ?? '') ||
  manifest.sourceCommit !== commit ||
  manifest.version !== version ||
  bundle?.commit !== commit ||
  bundle?.version !== version ||
  bundle?.verified !== true
)
  throw new Error('baked helper must match the image release SHA and version');
const archive = await readFile(`${root}/${bundle.file}`);
if (createHash('sha256').update(archive).digest('hex') !== bundle.sha256)
  throw new Error('helper archive checksum mismatch');
const recovery = await readFile(`${root}/beeline-bootstrap.mjs`);
if (createHash('sha256').update(recovery).digest('hex') !== manifest.recovery?.sha256)
  throw new Error('helper recovery checksum mismatch');
const server = createServer(async (req, res) => {
  const file = req.url?.slice(1);
  if (!['manifest.json', bundle.file, `${bundle.file}.sha256`].includes(file)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.end(await readFile(`${root}/${file}`));
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const child = spawn(
    process.execPath,
    [
      `${root}/beeline-bootstrap.mjs`,
      'install-only',
      '--manifest-url',
      `http://127.0.0.1:${server.address().port}/manifest.json`,
    ],
    {
      env: { ...process.env, HOME: '/root', BEELINE_LAB: '1' },
      stdio: 'inherit',
    },
  );
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`helper installation exited ${code}`)),
    );
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
