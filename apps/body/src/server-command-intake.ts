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
 * Live traffic is only a wakeup; it is never interpreted as conversational input.
 */
export async function runServerCommandIntake(options: {
  api: DaemonApiClient;
  roomId: string;
  agentId: string;
  context: CommandExecutionContext;
  signal?: AbortSignal;
  pollMs?: number;
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
  let wake: (() => void) | undefined;
  let dirty = true;
  let live = false;
  const notify = () => {
    dirty = true;
    wake?.();
  };
  options.onWake?.(notify);
  const off = api.liveSubscribe?.(roomId, undefined, notify, (connected, capabilities) => {
    live = connected && capabilities?.pushIntake === true;
    notify();
  });
  let page = first;
  try {
    while (!signal?.aborted) {
      if (options.closed && (await options.closed())) return;
      for (const command of page.commands) {
        validateServerCommand(command, roomId, agentId);
        if (busy && command.action !== 'stop') continue;
        try {
          await api.execute('claimAgentCommand', {
            roomId,
            commandId: command.id,
            generationId: context.generationId,
          });
        } catch (error) {
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
            .catch((error) => options.onError?.(error))
            .finally(async () => {
              await context.leave();
              busy = undefined;
              notify();
            });
        }
      }
      options.onPoll?.();
      if (!dirty)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            wake = undefined;
            resolve();
          };
          const timer = setTimeout(done, live ? 60_000 : (options.pollMs ?? 1_000));
          wake = done;
          signal?.addEventListener('abort', done, { once: true });
        });
      dirty = false;
      if (signal?.aborted) break;
      page = await api.execute('getAgentCommands', { roomId });
      if (page.commandProtocol !== 1)
        throw new Error('server command protocol changed; refusing intake');
    }
  } finally {
    off?.();
    options.onWake?.(undefined);
    if (context.current) options.stop(context.current.turnRequestId);
    await busy;
  }
}
