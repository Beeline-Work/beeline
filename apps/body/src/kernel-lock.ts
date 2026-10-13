import { createHash } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';

/** A kernel-owned local socket is released on process death, with no stale-age takeover. */
export async function withKernelLock<T>(
  key: string,
  work: () => Promise<T>,
  waitMs = 600_000,
): Promise<T> {
  const hash = createHash('sha256').update(key).digest();
  // Linux abstract sockets have no stale filesystem inode and cannot collide
  // with HTTP fixture ports. Node supports them from 20.8 (our minimum is 20.11).
  // macOS uses loopback ports below its ephemeral range; hash collisions only
  // serialize otherwise unrelated owners rather than granting duplicate ownership.
  const address =
    process.platform === 'linux'
      ? { path: `\0beeline-lock-${hash.toString('hex')}` }
      : { port: 20_000 + (hash.readUInt32BE(0) % 10_000), host: '127.0.0.1' };
  const deadline = Date.now() + waitMs;
  for (;;) {
    const peers = new Set<Socket>();
    const server = createServer((peer) => {
      peers.add(peer);
      peer.on('error', () => undefined);
      peer.once('close', () => peers.delete(peer));
    });
    const acquired = await new Promise<boolean>((done, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? done(false) : reject(error),
      );
      server.listen(address, () => done(true));
    });
    if (acquired) {
      try {
        return await work();
      } finally {
        for (const peer of peers) peer.destroy();
        await new Promise<void>((done) => server.close(() => done()));
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timed out waiting for Beeline installer owner');
    // Wait for owner death/completion on the connection, rather than rereading a lock file.
    await new Promise<void>((done, reject) => {
      const peer = createConnection(address);
      // Consume EOF so a completed owner's connection closes. A paused
      // client can otherwise keep a Linux abstract address referenced after
      // the listener has gone, preventing the next owner from binding it.
      peer.resume();
      const timer = setTimeout(() => {
        peer.destroy();
        reject(new Error('timed out waiting for Beeline installer owner'));
      }, remaining);
      const finish = () => {
        clearTimeout(timer);
        peer.destroy();
        done();
      };
      peer.once('close', finish);
      peer.once('error', finish); // Owner disappeared between bind and connect.
    });
  }
}
