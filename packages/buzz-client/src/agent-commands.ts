/**
 * Per-agent advertised slash-command/skill list: a self-authored kind:30078
 * record, mirroring the model-catalog pattern in `agent-model-config.ts`.
 *
 * The source of truth is the agent's own ACP runtime: adapters push an
 * `available_commands_update` session update (at session start and whenever
 * the set changes — e.g. skills discovered mid-session). The daemon captures
 * those updates and republishes them here, so the mobile composer can render
 * a command palette without an ACP connection of its own.
 *
 * This is display metadata ONLY: it carries no authority, and publishing it
 * never executes anything. A harness that never advertises commands simply
 * has no record on the relay, which readers must render as "this agent does
 * not advertise commands" (plus Beeline's built-in verbs), never as an empty
 * hardcoded inventory.
 */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { publishEvent } from './http.js';
import {
  KIND_AGENT_COMMANDS,
  TAG_AGENT_COMMANDS,
  TAG_COMMUNITY,
} from './kinds.js';
import { tagValue } from './parse.js';
import { query } from './query.js';
import type { AgentCommandInfo, AgentCommandList } from './types.js';
import type { ChannelOpsContext } from './channel.js';

let lastCommandsTimestamp = 0;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function nextCommandsTimestamp(): number {
  lastCommandsTimestamp = Math.max(now(), lastCommandsTimestamp + 1);
  return lastCommandsTimestamp;
}

/** Canonical replaceable-record key shared by command publishers and readers. */
export function agentCommandsKey(workspaceRootId: string, agentPubkey: string): string {
  return `${workspaceRootId}:${agentPubkey}`;
}

/** Bounds keeping one replaceable event well under relay size limits. */
export const MAX_AGENT_COMMANDS = 200;
const MAX_COMMAND_NAME_CHARS = 80;
const MAX_COMMAND_DESCRIPTION_CHARS = 300;
const MAX_COMMAND_HINT_CHARS = 120;

function sanitizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^\/+/, '');
  if (!name || name.length > MAX_COMMAND_NAME_CHARS) return null;
  return name;
}

function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Defensively parse the wire shape; malformed entries are dropped, never thrown. */
export function parseAgentCommandEntries(value: unknown): AgentCommandInfo[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: AgentCommandInfo[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = sanitizeName(record.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push({
      name,
      ...(clamp(record.description, MAX_COMMAND_DESCRIPTION_CHARS)
        ? { description: clamp(record.description, MAX_COMMAND_DESCRIPTION_CHARS) }
        : {}),
      ...(clamp(
        record.inputHint ??
          ((record.input as { hint?: unknown } | undefined)?.hint ?? undefined),
        MAX_COMMAND_HINT_CHARS,
      )
        ? {
            inputHint: clamp(
              record.inputHint ??
                ((record.input as { hint?: unknown } | undefined)?.hint ?? undefined),
              MAX_COMMAND_HINT_CHARS,
            ),
          }
        : {}),
    });
    if (result.length >= MAX_AGENT_COMMANDS) break;
  }
  return result;
}

/** Parse a verified, self-authored command list. Malformed or foreign events parse to `null`. */
export function parseAgentCommands(event: NostrEvent): AgentCommandList | null {
  if (event.kind !== KIND_AGENT_COMMANDS || !verifyEvent(event)) return null;
  if (tagValue(event, 't') !== TAG_AGENT_COMMANDS) return null;
  const communityId = tagValue(event, 'h');
  const agentPubkey = tagValue(event, 'p');
  if (!communityId || tagValue(event, TAG_COMMUNITY) !== communityId || !agentPubkey) return null;
  if (tagValue(event, 'd') !== agentCommandsKey(communityId, agentPubkey)) return null;
  if (event.pubkey !== agentPubkey) return null; // self-authored only
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>;
    return {
      communityId,
      agentPubkey,
      commands: parseAgentCommandEntries(content.commands),
      updatedAt: event.created_at,
      raw: event,
    };
  } catch {
    return null;
  }
}

/**
 * Publish (or replace) this agent's advertised command list. Called by the
 * daemon when an ACP `available_commands_update` lands — at session start and
 * on mid-session changes. An empty list is deliberately NOT published: absence
 * of a record IS the "does not advertise" signal.
 */
export async function publishAgentCommands(
  ctx: ChannelOpsContext,
  communityId: string,
  commands: AgentCommandInfo[],
): Promise<AgentCommandList> {
  const agentPubkey = ctx.identity.publicKey;
  const event = signEvent(
    {
      pubkey: agentPubkey,
      created_at: nextCommandsTimestamp(),
      kind: KIND_AGENT_COMMANDS,
      tags: [
        ['d', agentCommandsKey(communityId, agentPubkey)],
        ['h', communityId],
        ['p', agentPubkey],
        ['t', TAG_AGENT_COMMANDS],
        [TAG_COMMUNITY, communityId],
      ],
      content: JSON.stringify({ commands }),
    },
    ctx.identity.secretKey,
  );
  await publishEvent(ctx.http, event);
  return parseAgentCommands(event)!;
}

/** Read the latest advertised command list for an agent, if any session has ever published one. */
export async function getAgentCommands(
  ctx: ChannelOpsContext,
  communityId: string,
  agentPubkey: string,
): Promise<AgentCommandList | null> {
  const events = await query(ctx, [
    {
      kinds: [KIND_AGENT_COMMANDS],
      '#d': [agentCommandsKey(communityId, agentPubkey)],
      limit: 5,
    },
  ]);
  let latest: AgentCommandList | null = null;
  for (const event of events) {
    const parsed = parseAgentCommands(event);
    if (parsed && (!latest || latest.updatedAt < parsed.updatedAt)) latest = parsed;
  }
  return latest;
}
