import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import type { HelperStatusFile } from './helper-status.js';

export interface MachineRequest {
  operation: 'status' | 'converge' | 'stop' | 'update';
  releaseId?: string;
  agentId?: string;
  sourceGeneration?: string;
}

export function machineControlPath(stateRoot: string): string {
  // Darwin truncates Unix socket paths at 104 bytes. Neither the install/home
  // path nor os.tmpdir() (usually /var/folders/.../T on macOS) is bounded.
  // A private, installation-specific directory under the literal /tmp keeps
  // both sides on the same short endpoint, including for Unicode state homes.
  const key = createHash('sha256').update(resolve(stateRoot)).digest('hex').slice(0, 32);
  return `/tmp/beeline-${process.getuid!()}-${key}/control.sock`;
}

async function prepareControlDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0)
    throw new Error(`expected a private helper control directory: ${directory}`);
}

/** The live connection, rather than a PID or a disk snapshot, proves the process generation. */
export class MachineControl {
  readonly #clients = new Set<Socket>();
  readonly #server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    let input = '';
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (input.length > 4096) {
        socket.destroy();
        return;
      }
      const end = input.indexOf('\n');
      if (end < 0) return;
      const line = input.slice(0, end);
      input = input.slice(end + 1);
      void (async () => {
        const request = JSON.parse(line) as MachineRequest;
        if (!['status', 'converge', 'stop', 'update'].includes(request.operation))
          throw new Error('invalid helper operation');
        this.#clients.add(socket);
        await this.onRequest(request);
        this.send(socket);
      })().catch((error) => socket.end(`${JSON.stringify({ error: String(error) })}\n`));
    });
    socket.once('close', () => this.#clients.delete(socket));
  });
  #status: HelperStatusFile | undefined;

  constructor(
    readonly path: string,
    readonly onRequest: (request: MachineRequest) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    await prepareControlDirectory(this.path);
    // Machine ownership is held by the native supervisor and the process lock.
    await rm(this.path, { force: true });
    await new Promise<void>((done, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.path, done);
    });
    await chmod(this.path, 0o600);
  }

  publish(status: HelperStatusFile): void {
    this.#status = status;
    for (const socket of this.#clients) this.send(socket);
  }

  private send(socket: Socket): void {
    if (this.#status && !socket.destroyed) socket.write(`${JSON.stringify(this.#status)}\n`);
  }

  async stop(): Promise<void> {
    if (!this.#server.listening) return;
    for (const socket of this.#clients) socket.destroy();
    await new Promise<void>((done) => this.#server.close(() => done()));
    await rm(this.path, { force: true });
  }
}

/** Subscribe once; readiness changes and successor socket creation drive completion. */
export async function requestMachine(
  stateRoot: string,
  request: MachineRequest,
  accept: (status: HelperStatusFile) => boolean,
  timeoutMs = 600_000,
): Promise<HelperStatusFile> {
  const path = machineControlPath(stateRoot);
  await prepareControlDirectory(path);
  return new Promise((done, reject) => {
    let socket: Socket | undefined;
    let connecting = false;
    let reconnectNeeded = false;
    let settled = false;
    let lastStatus: HelperStatusFile | undefined;
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename === basename(path)) {
        reconnectNeeded = true;
        if (!socket && !connecting) connect();
      }
    });
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `helper convergence timed out${
              lastStatus
                ? `: ${Object.entries(lastStatus.agents)
                    .filter(([, agent]) => agent.state !== 'serving' && agent.state !== 'stopped')
                    .map(([id, agent]) => `${id}: ${agent.state} (${agent.status})`)
                    .join('; ')}`
                : '; no live helper acknowledgment'
            }`,
          ),
        ),
      timeoutMs,
    );
    function finish(error?: Error, status?: HelperStatusFile) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      socket?.destroy();
      if (error) reject(error);
      else done(status!);
    }
    function connect() {
      if (settled) return;
      connecting = true;
      reconnectNeeded = false;
      const peer = createConnection(path);
      socket = peer;
      let input = '';
      peer.setEncoding('utf8');
      peer.once('connect', () => {
        connecting = false;
        peer.write(`${JSON.stringify(request)}\n`);
      });
      peer.on('data', (chunk: string) => {
        input += chunk;
        if (input.length > 1_000_000) return finish(new Error('invalid helper acknowledgment'));
        let end: number;
        while ((end = input.indexOf('\n')) >= 0) {
          const line = input.slice(0, end);
          input = input.slice(end + 1);
          try {
            const status = JSON.parse(line) as HelperStatusFile & { error?: string };
            if (status.error) throw new Error(status.error);
            if (
              typeof status.generation !== 'string' ||
              !status.generation ||
              !Number.isSafeInteger(status.pid) ||
              status.pid <= 0 ||
              !['starting', 'serving', 'stopping'].includes(status.processState) ||
              !status.agents ||
              typeof status.agents !== 'object' ||
              Array.isArray(status.agents)
            )
              throw new Error('invalid helper acknowledgment');
            lastStatus = status;
            if (accept(status)) finish(undefined, status);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      peer.once('error', (error: NodeJS.ErrnoException) => {
        if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code ?? '')) finish(error);
      });
      peer.once('close', () => {
        if (socket === peer) socket = undefined;
        connecting = false;
        if (reconnectNeeded) connect();
      });
    }
    connect();
  });
}
