import { mkdir, open } from 'node:fs/promises';

// Allocate the helper's normal recovery reserve in the image instead of
// synchronously writing 128 MiB on the first Workspace's activation.
await mkdir('/root/.local/state/beeline/helper', { recursive: true, mode: 0o700 });
const file = await open('/root/.local/state/beeline/helper/private-recovery-reserve', 'wx', 0o600);
try {
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 128; i++) await file.write(block);
  await file.sync();
} finally { await file.close(); }
