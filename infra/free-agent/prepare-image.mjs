// Reuse the image's pinned packages without a first-turn npm installation.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, symlink } from 'node:fs/promises';

const root = '/usr/local/lib/node_modules';
const adapter = JSON.parse(await readFile(`${root}/pi-acp/package.json`, 'utf8'));
const cli = JSON.parse(await readFile(`${root}/@earendil-works/pi-coding-agent/package.json`, 'utf8'));
const key = createHash('sha256').update(`${adapter.name}@${adapter.version}:${cli.name}@${cli.version}:${process.version}`).digest('hex').slice(0, 16);
const target = `/opt/beeline/toolchains/pi-acp-${adapter.version}-${key}`;
await mkdir(`${target}/node_modules/.bin`, { recursive: true });
await mkdir(`${target}/bin`);
await symlink('/usr/local/bin/pi-acp', `${target}/node_modules/.bin/pi-acp`);
await symlink('/usr/local/bin/pi', `${target}/node_modules/.bin/pi`);
await symlink(process.execPath, `${target}/bin/node`);

// Allocate the helper's normal recovery reserve in the image instead of
// synchronously writing 128 MiB on the first Workspace's activation.
await mkdir('/root/.local/state/beeline/helper', { recursive: true, mode: 0o700 });
const file = await open('/root/.local/state/beeline/helper/private-recovery-reserve', 'wx', 0o600);
try {
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 128; i++) await file.write(block);
  await file.sync();
} finally { await file.close(); }
