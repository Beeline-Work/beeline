/**
 * Daemon-side republishing of an agent's harness-advertised slash commands.
 *
 * ACP adapters push `available_commands_update` session updates at session
 * start and whenever the set changes mid-session (skills discovered in a
 * subdirectory, MCP servers coming online). `AcpClient` captures those
 * updates; this module turns them into exactly one durable relay record per
 * distinct list: bursts are debounced to the last push, and a list identical
 * to one already published in this process costs no write at all.
 *
 * Display-only by design: the published list never carries authority, and a
 * failed publish only logs (the next identical push retries it).
 */
import type { AcpAvailableCommand } from './acp.js';

/** Trailing debounce coalescing a burst of `available_commands_update` pushes into one publish. */
export const AGENT_COMMANDS_PUBLISH_DEBOUNCE_MS = 3_000;

export interface AgentCommandPublisher {
  /** Feed one captured command list (usually from AcpClient's 'commands' event). */
  onCommands: (commands: AcpAvailableCommand[]) => void;
  /** Detach timers; any still-pending list is dropped (the next push re-sends it). */
  dispose: () => void;
}

export function createAgentCommandPublisher(deps: {
  publish: (commands: AcpAvailableCommand[]) => Promise<void>;
  /** Dedupe store for already-published list signatures (per community+process). */
  publishedSignatures: Set<string>;
  dedupeKeyPrefix: string;
  debounceMs?: number;
}): AgentCommandPublisher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingCommands: AcpAvailableCommand[] | undefined;
  const debounceMs = deps.debounceMs ?? AGENT_COMMANDS_PUBLISH_DEBOUNCE_MS;

  const flush = () => {
    timer = undefined;
    const commands = pendingCommands;
    pendingCommands = undefined;
    if (!commands?.length) return;
    const signature = JSON.stringify(commands);
    const dedupeKey = `${deps.dedupeKeyPrefix}:${signature}`;
    if (deps.publishedSignatures.has(dedupeKey)) return;
    deps.publishedSignatures.add(dedupeKey);
    deps.publish(commands).catch((error: unknown) => {
      // Allow a later identical push to retry the publish.
      deps.publishedSignatures.delete(dedupeKey);
      console.error('[body] failed to publish agent command list:', error);
    });
  };

  return {
    onCommands: (commands) => {
      if (!commands.length) return;
      pendingCommands = commands;
      // Trailing debounce: adapters may push several times in quick succession
      // around session start (skills discovery), and only the last list matters.
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pendingCommands = undefined;
    },
  };
}
