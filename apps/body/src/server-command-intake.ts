import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
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
        taskId: command.rootCommandId,
        generationId: this.generationId,
      }),
      { mode: 0o600 },
    );
  }
  /**
   * The prompt sections this turn was assembled from, for `report_feedback`
   * to attach. Rewrites the same context file the tools already read; a
   * turn that has left keeps its empty file.
   */
  notePromptSections(ids: readonly string[]): void {
    const command = this.current;
    if (!command) return;
    writeFileSync(
      this.path,
      JSON.stringify({
        roomId: command.roomId,
        requestId: command.turnRequestId,
        taskId: command.rootCommandId,
        generationId: this.generationId,
        promptSectionIds: [...new Set(ids)],
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
 * Live traffic carries server-authorized commands. The initial snapshot and
 * each subsequent socket subscription reconcile missed commands exactly once.
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
  restart?: (command: AgentCommand) => void;
  canStartTurn?: () => boolean;
  onWake?: (wake: (() => void) | undefined) => void;
  onPoll?: () => void;
  onSubscriptionState?: (connected: boolean) => void;
  /**
   * Fired the instant this caller decides to attempt claiming a real
   * (non-stop/non-restart) command, strictly before the claim's own network
   * round trip. A caller's own busy flag must flip here, not merely once
   * `run()` gets around to setting it deep inside a prompt: reconcile reads
   * that flag to decide whether a Room mid-claim is idle and safe to
   * restart, and the gap from "about to claim" through `context.enter()`'s
   * own file I/O was a real window where a same-tick repository-revision
   * change could stop this loop while a turn was already claimed (or about
   * to be) and about to execute. `onClaimFailed` undoes the mark when the
   * claim itself is refused (lost to a concurrent claimant, a stale
   * generation, etc.) so a failed attempt never leaves this caller stuck
   * "busy" over nothing.
   */
  onClaiming?: (command: AgentCommand) => void;
  onClaimFailed?: (command: AgentCommand) => void;
  onError?: (error: unknown) => void;
  onEnter?: (command: AgentCommand) => void;
  onLeave?: (command: AgentCommand) => void;
  closed?: () => Promise<boolean>;
}): Promise<void> {
  const { api, roomId, agentId, context, signal } = options;
  const first = await api.execute('getAgentCommands', { roomId });
  if (first?.commandProtocol !== 1)
    throw new Error('server command protocol 1 is required; refusing intake');
  let busy: Promise<void> | undefined;
  let wake: ((reconcile: boolean) => void) | undefined;
  let hasSubscribed = false;
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
      options.onSubscriptionState?.(connected && capabilities?.pushIntake === true);
      if (!connected) return;
      if (capabilities?.pushIntake !== true) {
        options.onError?.(new Error('server push intake is required; refusing timer-free intake'));
        return;
      }
      // The initial GET precedes the first subscription; the server also
      // sends a command snapshot on subscribe. Reconnects need one fresh GET.
      if (hasSubscribed) requestReconciliation();
      hasSubscribed = true;
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
        if (busy && command.action !== 'stop' && command.action !== 'restart') continue;
        if (
          (command.action === 'input' || command.action === 'resume') &&
          options.canStartTurn?.() === false
        )
          continue;
        pending.delete(command.id);
        // Reserve the id before the request yields. A slow reconciliation
        // response may contain the same command snapshot while this claim is
        // in flight; it must not put the command back into the local queue.
        claimed.add(command.id);
        // A real (non-stop/non-restart) command is about to become this
        // caller's turn the moment this claim attempt succeeds; mark it
        // before the attempt even starts, not after it resolves - the claim
        // itself is a real network round trip a same-tick reconcile
        // busy-check can land inside just as easily as it could land inside
        // context.enter()'s own I/O afterward (C112).
        const startingTurn = command.action !== 'restart' && command.action !== 'stop';
        if (startingTurn) options.onClaiming?.(command);
        try {
          await api.execute('claimAgentCommand', {
            roomId,
            commandId: command.id,
            generationId: context.generationId,
          });
        } catch (error) {
          claimed.delete(command.id);
          if (startingTurn) options.onClaimFailed?.(command);
          options.onError?.(error);
          continue;
        }
        if (command.action === 'restart') {
          if (!options.restart) throw new Error('restart command is not supported by this helper');
          // Leave the command claimed. A genuinely new process lifecycle completes
          // it on announce; acknowledging before exit could falsely report success.
          options.restart(command);
        } else if (command.action === 'stop') {
          options.stop(command.turnRequestId);
          await api.execute('acknowledgeAgentCommand', {
            roomId,
            commandId: command.id,
            generationId: context.generationId,
          });
        } else {
          await context.enter(command);
          options.onEnter?.(command);
          busy = options
            .run(command)
            .catch((error) => {
              claimed.delete(command.id);
              options.onError?.(error);
            })
            .finally(async () => {
              options.onLeave?.(command);
              await context.leave();
              busy = undefined;
              notify();
            });
        }
      }
      options.onPoll?.();
      const reconcile = await new Promise<boolean>((resolve) => {
        const done = (needed: boolean) => {
          signal?.removeEventListener('abort', aborted);
          wake = undefined;
          resolve(needed);
        };
        const aborted = () => done(false);
        wake = done;
        signal?.addEventListener('abort', aborted, { once: true });
        // `closed()` and command claims can yield after shutdown has already
        // aborted the signal, before this listener is installed.
        if (signal?.aborted) done(false);
        else if (
          !busy &&
          [...pending.values()].some(
            (command) =>
              command.action === 'stop' ||
              command.action === 'restart' ||
              options.canStartTurn?.() !== false,
          )
        )
          done(false);
      });
      if (signal?.aborted) break;
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
