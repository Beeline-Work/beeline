import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isAgentCommand, type AgentCommand } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';

/** Session-local output context. No transcript or sender policy enters this boundary. */
export class CommandExecutionContext {
  readonly generationId = randomUUID();
  readonly path: string;
  current?: AgentCommand;
  constructor(root?: string) {
    this.path = join(root ?? tmpdir(), `beeline-command-${this.generationId}.json`);
  }
  async enter(command: AgentCommand): Promise<void> {
    this.current = command;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(
      this.path,
      JSON.stringify({
        roomId: command.roomId,
        requestId: command.turnRequestId,
        generationId: this.generationId,
      }),
      { mode: 0o600 },
    );
  }
  async leave(): Promise<void> {
    this.current = undefined;
    await writeFile(this.path, '{}', { mode: 0o600 });
  }
  bind(api: DaemonApiClient): DaemonApiClient {
    return new Proxy(api, {
      get: (target, key) => {
        if (key === 'execute')
          return (
            name: Parameters<DaemonApiClient['execute']>[0],
            input: Record<string, unknown>,
          ) => {
            const turn = this.current;
            return target.execute(name, {
              ...input,
              ...(turn && (input.roomId === turn.roomId || input.cornerId === turn.roomId)
                ? {
                    generationId: this.generationId,
                    requestId: input.requestId ?? input.turnId ?? turn.turnRequestId,
                  }
                : {}),
            } as never);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

export function validateServerCommand(
  command: AgentCommand,
  roomId: string,
  agentId: string,
): void {
  if (!isAgentCommand(command) || command.roomId !== roomId || command.agentId !== agentId)
    throw new Error('invalid server command');
}

/**
 * Targeted commands -> claim -> local session mechanics. Inputs remain durable
 * and unclaimed while a session is busy. Stops are claimed even during a prompt.
 * Live traffic carries server-authorized commands. Durable reads recover every
 * second until push intake is acknowledged, then reconcile once per minute.
 */
export async function runServerCommandIntake(options: {
  api: DaemonApiClient;
  roomId: string;
  agentId: string;
  context: CommandExecutionContext;
  signal?: AbortSignal;
  pollMs?: number;
  presence?: { releaseVersion?: string; sourceSha?: string; available?: boolean };
  run: (command: AgentCommand) => Promise<void>;
  stop: (requestId: string) => void;
  onWake?: (wake: (() => void) | undefined) => void;
  onPoll?: () => void;
  onError?: (error: unknown) => void;
  closed?: () => Promise<boolean>;
}): Promise<void> {
  const { api, roomId, agentId, context, signal } = options;
  const first = await api.execute('getAgentCommands', { roomId });
  if (first?.commandProtocol !== 1)
    throw new Error('server command protocol 1 is required; refusing intake');
  let busy: Promise<void> | undefined;
  let wake: ((reconcile: boolean) => void) | undefined;
  let pushIntakeAcknowledged = false;
  let reconciliation: Promise<void> | undefined;
  let reconciliationError: unknown;
  let stopped = false;
  const pending = new Map(first.commands.map((command) => [command.id, command]));
  const claimed = new Set<string>();
  const notify = (commands: readonly AgentCommand[] = []) => {
    for (const command of commands) if (!claimed.has(command.id)) pending.set(command.id, command);
    wake?.(false);
  };
  const requestReconciliation = () => {
    if (reconciliation) return;
    reconciliation = api
      .execute('getAgentCommands', { roomId })
      .then((page) => {
        if (page.commandProtocol !== 1)
          throw new Error('server command protocol changed; refusing intake');
        if (!stopped) notify(page.commands);
      })
      .catch((error: unknown) => {
        reconciliationError = error;
        wake?.(false);
      })
      .finally(() => {
        reconciliation = undefined;
      });
  };
  options.onWake?.(notify);
  const off = api.liveSubscribe?.(
    roomId,
    undefined,
    undefined,
    (connected, capabilities) => {
      const acknowledged = connected && capabilities?.pushIntake === true;
      if (pushIntakeAcknowledged !== acknowledged) {
        pushIntakeAcknowledged = acknowledged;
        // Re-arm the recovery timer at the cadence this connection proved it
        // supports. A disconnect still reconciles immediately.
        wake?.(!connected);
      } else if (!connected) {
        wake?.(true);
      }
    },
    options.presence,
    notify,
  );
  try {
    while (!signal?.aborted) {
      if (reconciliationError) throw reconciliationError;
      if (options.closed && (await options.closed())) return;
      for (const command of [...pending.values()]) {
        validateServerCommand(command, roomId, agentId);
        if (busy && command.action !== 'stop') continue;
        pending.delete(command.id);
        // Reserve the id before the request yields. A slow reconciliation
        // response may contain the same command snapshot while this claim is
        // in flight; it must not put the command back into the local queue.
        claimed.add(command.id);
        try {
          await api.execute('claimAgentCommand', {
            roomId,
            commandId: command.id,
            generationId: context.generationId,
          });
        } catch (error) {
          claimed.delete(command.id);
          options.onError?.(error);
          continue;
        }
        if (command.action === 'stop') {
          options.stop(command.turnRequestId);
          await api.execute('acknowledgeAgentCommand', {
            roomId,
            commandId: command.id,
            generationId: context.generationId,
          });
        } else {
          await context.enter(command);
          busy = options
            .run(command)
            .catch((error) => {
              claimed.delete(command.id);
              options.onError?.(error);
            })
            .finally(async () => {
              await context.leave();
              busy = undefined;
              notify();
            });
        }
      }
      options.onPoll?.();
      const reconcile = await new Promise<boolean>((resolve) => {
        const done = (needed: boolean) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', aborted);
          wake = undefined;
          resolve(needed);
        };
        const aborted = () => done(false);
        wake = done;
        const timer = setTimeout(
          () => done(true),
          pushIntakeAcknowledged ? 60_000 : (options.pollMs ?? 1_000),
        );
        signal?.addEventListener('abort', aborted, { once: true });
        if (pending.size && !busy) done(false);
      });
      if (signal?.aborted) break;
      // The slow sweep is only a recovery net. Never make a command that
      // already arrived over the acknowledged push path wait behind its GET.
      if (reconcile) requestReconciliation();
    }
  } finally {
    stopped = true;
    off?.();
    options.onWake?.(undefined);
    if (context.current) options.stop(context.current.turnRequestId);
    await busy;
  }
}
