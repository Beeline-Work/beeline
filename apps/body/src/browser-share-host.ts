import { createConnection, createServer, type Server } from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { shareChromiumPage, type ChromiumPage } from './browser-share.js';
import { privateSocketPath, preparePrivateSocketDirectory } from './local-socket.js';

export function browserShareHostPath(stateRoot: string, agentId: string): string {
  return privateSocketPath(JSON.stringify(['browser-share', resolve(stateRoot), process.pid, agentId]));
}

type ShareRequest = {
  page: ChromiumPage;
  shareId: string;
  roomId: string;
  serverBaseUrl: string;
  daemonToken: string;
};

/** One socket per hosted agent, outside short lived model turn sandboxes. */
export class BrowserShareHost {
  private server?: Server;
  constructor(readonly socketPath: string) {}

  async start(): Promise<void> {
    await preparePrivateSocketDirectory(this.socketPath);
    rmSync(this.socketPath, { force: true });
    this.server = createServer({ allowHalfOpen: true }, (socket) => {
      let text = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        text += chunk;
        if (text.length > 65_536) socket.destroy();
      });
      socket.once('end', () => {
        void (async () => {
          const request = JSON.parse(text) as ShareRequest;
          if (!request.page?.webSocketDebuggerUrl || !request.shareId || !request.roomId ||
              !request.serverBaseUrl || !request.daemonToken) throw new Error('Invalid browser share request');
          await shareChromiumPage({
            page: request.page,
            shareId: request.shareId,
            serverBaseUrl: request.serverBaseUrl,
            daemonToken: request.daemonToken,
            onEnded: async () => {
              await fetch(new URL('/v1/daemon/operations/endComputerSession', request.serverBaseUrl), {
                method: 'POST',
                headers: { authorization: `Bearer ${request.daemonToken}`, 'content-type': 'application/json' },
                body: JSON.stringify({ roomId: request.roomId, sessionId: request.page.id }),
                signal: AbortSignal.timeout(10_000),
              }).catch(() => {});
            },
          });
          socket.end(JSON.stringify({ ok: true }));
        })().catch((error: unknown) => socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => { this.server!.off('error', reject); resolve(); });
    });
    chmodSync(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    rmSync(this.socketPath, { force: true });
  }
}

export function startHostedBrowserShare(socketPath: string, request: ShareRequest): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => socket.destroy(new Error('Browser share host timed out')));
    socket.once('connect', () => socket.end(JSON.stringify(request)));
    socket.on('data', (chunk: string) => { output += chunk; });
    socket.once('error', reject);
    socket.once('close', () => {
      try {
        const result = JSON.parse(output) as { ok?: boolean; error?: string };
        if (!result.ok) throw new Error(result.error ?? 'Browser share host failed');
        resolve();
      } catch (error) { reject(error); }
    });
  });
}
