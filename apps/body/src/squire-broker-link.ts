/**
 * Beeline-owned, connect-only replacement for Squire's own relay
 * (`npx @trusty-squire/mcp server`, the installed package's `dist/relay.js`).
 *
 * `squireBrokerSocketReady` (`squire-host.ts`) only gates the MOMENT a façade
 * starts. Once running, Squire's own relay calls its internal
 * `ensureSharedMcp()` on every (re)connect — including a mid-session drop —
 * and `ensureSharedMcp` spawns a detached broker itself whenever its
 * `managedBrokerUnitIsLive()` probe (`systemctl --user show ...`) doesn't see
 * the host unit as live. That is not merely racy during a restart-loop: it
 * always fails closed to "spawn" from inside a bwrap-sandboxed agent
 * session, because the session bus it needs is unreachable there. Verified
 * on this host:
 *
 *   $ bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-pid \
 *       env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user show \
 *       --type=service -p Id -p ActiveState trusty-squire-broker.service
 *   Failed to connect to bus: No data available
 *
 * So relaying through Squire's own `server` subcommand can never be made
 * connect-only from the outside — the unsafe fallback lives inside code
 * Beeline does not own and the installed package exposes no env/flag to
 * disable it (checked npm dist-tag `latest` at 1.1.21 through the newest
 * `1.1.22-rc.1` prerelease; `dist/bot/broker/discovery.js`'s
 * `connectOrLaunchBroker`/`ensureSharedMcp` take no such override, and only
 * `.`/`./browser` are public `exports`). This module replaces that
 * subcommand entirely for every agent-launched façade: it IS the façade's
 * MCP transport for the life of the process, speaking exactly the protocol
 * the broker's shared MCP socket expects (`bot/broker/mcp-socket.js`
 * `listenSharedMcp`: one identity line, then newline-delimited JSON-RPC) and
 * mirroring the vendor relay's own framing, pending-request bookkeeping, and
 * capped-exponential-backoff reconnect — minus the on-demand-launch call.
 * A connection that cannot be re-established within `giveUpMs` of cumulative
 * disconnection fails every pending and future call with an error naming the
 * broker unit and stops; it never calls anything resembling
 * `ensureSharedMcp` and never spawns a process, so there is nothing left for
 * a restart-looping or sandbox-unreachable systemd check to race.
 */
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { SQUIRE_BROKER_UNAVAILABLE, TRUSTY_SQUIRE_BROKER_UNIT_NAME } from './squire-host.js';

const SQUIRE_RELAY_INITIAL_DELAY_MS = 100;
const SQUIRE_RELAY_MAX_DELAY_MS = 1_000;
/**
 * Bounds cumulative time spent disconnected (first connect or any later
 * reconnect) before giving up. Matches the installed package's own
 * `BROKER_CONNECT_TIMEOUT_MS` convention (`discovery.js`): long enough to
 * ride out one broker restart cycle (`trustySquireBrokerUnit`'s
 * `RestartSec=5s`), short enough that a genuinely gone broker fails the
 * call instead of hanging the turn.
 */
export const SQUIRE_RELAY_GIVE_UP_MS = 10_000;

type JsonRpcFrame = { id?: string | number; method?: string; error?: unknown };

function frameLines(
  chunk: Buffer<ArrayBufferLike>,
  buffered: Buffer<ArrayBufferLike>,
  receive: (line: string) => void,
): Buffer<ArrayBufferLike> {
  let input = Buffer.concat([buffered, chunk]);
  for (;;) {
    const end = input.indexOf(10);
    if (end < 0) return input;
    receive(input.subarray(0, end).toString('utf8'));
    input = input.subarray(end + 1);
  }
}

export type SquireBrokerLinkOptions = {
  readonly agentId: string;
  readonly socketPath: string;
  readonly giveUpMs?: number;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly logError?: (message: string) => void;
  /** Injectable for tests; defaults to a real Unix socket connection. */
  readonly connect?: (path: string) => Socket;
  /** Injectable for tests; defaults to real process signals. */
  readonly onShutdownSignal?: (handler: () => void) => void;
};

/** Keep the agent's stdio MCP connection alive across broker restarts, connect-only. */
export async function runSquireBrokerLink(options: SquireBrokerLinkOptions): Promise<{ ok: boolean }> {
  const {
    agentId,
    socketPath,
    giveUpMs = SQUIRE_RELAY_GIVE_UP_MS,
    input = process.stdin,
    output = process.stdout,
    logError = (message: string) => process.stderr.write(`${message}\n`),
    connect = (path: string) => createConnection(path),
    onShutdownSignal = (handler: () => void) => {
      process.once('SIGHUP', handler);
      process.once('SIGTERM', handler);
      process.once('SIGINT', handler);
    },
  } = options;

  let socket: Socket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disconnectedSince: number | undefined;
  let inBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let outBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let initializeLine: string | undefined;
  let initializedLine: string | undefined;
  let replayId: string | undefined;
  let delayMs = SQUIRE_RELAY_INITIAL_DELAY_MS;
  let stopped = false;
  let gaveUp = false;
  let connectedOnce = false;
  let ready = false;
  const pending = new Map<string, string | number>();
  const queued: string[] = [];

  let resolveDone!: (ok: boolean) => void;
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve;
  });

  const failResponse = (id: string | number) =>
    `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: 'Trusty Squire broker connection lost' },
    })}\n`;

  const flush = () => {
    while (queued.length) {
      const line = queued.shift()!;
      const frame = JSON.parse(line) as JsonRpcFrame;
      if (frame.id !== undefined && frame.method) pending.set(JSON.stringify(frame.id), frame.id);
      socket?.write(`${line}\n`);
    }
  };

  function stop(ok: boolean): void {
    if (stopped) return;
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.destroy();
    resolveDone(ok);
  }

  const giveUp = () => {
    if (gaveUp) return;
    gaveUp = true;
    logError(`${SQUIRE_BROKER_UNAVAILABLE}: ${TRUSTY_SQUIRE_BROKER_UNIT_NAME} is not reachable at ${socketPath}`);
    for (const id of pending.values()) output.write(failResponse(id));
    pending.clear();
    // A request that arrived before any successful connect was never
    // flushed, so it was never added to `pending` either — without this it
    // would hang silently instead of failing.
    for (const line of queued.splice(0)) {
      const frame = JSON.parse(line) as JsonRpcFrame;
      if (frame.id !== undefined && frame.method) output.write(failResponse(frame.id));
    }
    stop(false);
  };

  const reconnect = () => {
    if (stopped || retryTimer || gaveUp) return;
    disconnectedSince ??= Date.now();
    if (Date.now() - disconnectedSince >= giveUpMs) {
      giveUp();
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      doConnect();
    }, delayMs);
    delayMs = Math.min(delayMs * 2, SQUIRE_RELAY_MAX_DELAY_MS);
  };

  const attach = (peer: Socket) => {
    if (stopped) {
      peer.destroy();
      return;
    }
    socket = peer;
    outBuffer = Buffer.alloc(0);
    peer.once('connect', () => {
      delayMs = SQUIRE_RELAY_INITIAL_DELAY_MS;
      disconnectedSince = undefined;
      peer.write(`${agentId}\n`);
      if (connectedOnce && initializeLine) {
        replayId = `beeline-squire-relay-${randomUUID()}`;
        const frame = JSON.parse(initializeLine) as Record<string, unknown>;
        peer.write(`${JSON.stringify({ ...frame, id: replayId })}\n`);
      } else {
        ready = true;
        flush();
      }
      connectedOnce = true;
    });
    peer.on('data', (chunk: Buffer) => {
      outBuffer = frameLines(chunk, outBuffer, (line) => {
        const frame = JSON.parse(line) as JsonRpcFrame;
        if (frame.id === replayId) {
          replayId = undefined;
          if (frame.error) {
            peer.destroy(new Error('broker rejected relay initialization'));
            return;
          }
          if (initializedLine) peer.write(`${initializedLine}\n`);
          ready = true;
          flush();
          return;
        }
        if (frame.id !== undefined && !frame.method) pending.delete(JSON.stringify(frame.id));
        output.write(`${line}\n`);
      });
    });
    peer.on('error', (error) => {
      if (!stopped) logError(`squire relay: ${error instanceof Error ? error.message : String(error)}`);
    });
    peer.once('close', () => {
      if (socket !== peer || stopped) return;
      socket = undefined;
      ready = false;
      replayId = undefined;
      for (const id of pending.values()) output.write(failResponse(id));
      pending.clear();
      reconnect();
    });
  };

  const doConnect = () => {
    if (stopped) return;
    try {
      attach(connect(socketPath));
    } catch {
      reconnect();
    }
  };

  input.on('data', (chunk: Buffer) => {
    inBuffer = frameLines(chunk, inBuffer, (line) => {
      const frame = JSON.parse(line) as JsonRpcFrame;
      if (gaveUp) {
        // Given up already stops the process in production, but a caller
        // that keeps writing after that (as the injected-stream tests do)
        // gets a clean, immediate failure rather than silence.
        if (frame.id !== undefined && frame.method) output.write(failResponse(frame.id));
        return;
      }
      if (frame.method === 'initialize') initializeLine = line;
      if (frame.method === 'notifications/initialized') initializedLine = line;
      queued.push(line);
      if (ready) flush();
    });
  });

  const close = () => stop(!gaveUp);
  input.once('end', close);
  input.once('close', close);
  onShutdownSignal(close);

  doConnect();
  const ok = await done;
  return { ok };
}
