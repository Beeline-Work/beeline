/**
 * Per-agent model/effort picker state: two distinct kind:30078 records,
 * mirroring the soul-overlay/presence split in agent.ts.
 *
 * - The *catalog* is self-authored by the agent: a snapshot of what its ACP
 *   runtime currently advertises (`session/new`'s `configOptions`), so the
 *   app can render a picker without an ACP connection of its own.
 * - The *selection* is human-authored, same authorization shape as
 *   `setAgentSoul`: only a community member (never the agent itself) may
 *   choose a model/effort for an agent.
 *
 * `mode`/permission axes (Beeline's read-only/edit boundary) are never
 * exposed here — `ALLOWED_AGENT_MODEL_CONFIG_CATEGORIES` is the allow-list
 * both `parseAgentModelCatalog` (defensively, on read) and the daemon
 * (`apps/body/src/model-config.ts`, on capture and on set) enforce.
 */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { communityMembers } from './community.js';
import { publishEvent } from './http.js';
import {
  KIND_AGENT_MODEL_CATALOG,
  KIND_AGENT_MODEL_CONFIG,
  TAG_AGENT_MODEL_CATALOG,
  TAG_AGENT_MODEL_CONFIG,
  TAG_COMMUNITY,
} from './kinds.js';
import { tagValue } from './parse.js';
import { query } from './query.js';
import { isAgentIdentity, listAgents } from './agent.js';
import type {
  AgentModelCatalog,
  AgentModelConfig,
  AgentModelConfigInput,
  AgentModelConfigOption,
  AgentModelSelection,
} from './types.js';
import type { ChannelOpsContext } from './channel.js';

let lastModelConfigTimestamp = 0;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function nextModelConfigTimestamp(): number {
  lastModelConfigTimestamp = Math.max(now(), lastModelConfigTimestamp + 1);
  return lastModelConfigTimestamp;
}

function modelConfigKey(communityId: string, agentPubkey: string): string {
  return `${communityId}:${agentPubkey}`;
}

/**
 * The only `configOptions` categories a picker may ever read or write.
 * `mode` / `fast-mode` / `collaboration_mode` (or any other permission axis)
 * must never appear here — those control Beeline's read-only/edit boundary.
 */
export const ALLOWED_AGENT_MODEL_CONFIG_CATEGORIES = [
  'model',
  'thought_level',
  'effort',
  'reasoning_effort',
] as const;

export function isAllowedAgentModelConfigCategory(category: string): boolean {
  return (ALLOWED_AGENT_MODEL_CONFIG_CATEGORIES as readonly string[]).includes(category);
}

function parseOptionEntries(value: unknown): AgentModelConfigOption[] {
  if (!Array.isArray(value)) return [];
  const result: AgentModelConfigOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const category = record.category;
    if (typeof id !== 'string' || typeof category !== 'string') continue;
    if (!isAllowedAgentModelConfigCategory(category)) continue;
    const rawChoices = Array.isArray(record.options) ? record.options : [];
    const choices = rawChoices
      .filter(
        (choice): choice is Record<string, unknown> =>
          Boolean(choice) && typeof choice === 'object' && typeof (choice as any).id === 'string',
      )
      .map((choice) => ({
        id: choice.id as string,
        ...(typeof choice.name === 'string' ? { name: choice.name } : {}),
      }));
    result.push({
      id,
      category,
      ...(typeof record.currentValue === 'string' ? { currentValue: record.currentValue } : {}),
      options: choices,
    });
  }
  return result;
}

/** Parse a verified, self-authored model-catalog snapshot. Non-allow-listed categories are dropped. */
export function parseAgentModelCatalog(event: NostrEvent): AgentModelCatalog | null {
  if (event.kind !== KIND_AGENT_MODEL_CATALOG || !verifyEvent(event)) return null;
  if (tagValue(event, 't') !== TAG_AGENT_MODEL_CATALOG) return null;
  const communityId = tagValue(event, 'h');
  const agentPubkey = tagValue(event, 'p');
  if (!communityId || tagValue(event, TAG_COMMUNITY) !== communityId || !agentPubkey) return null;
  if (tagValue(event, 'd') !== modelConfigKey(communityId, agentPubkey)) return null;
  if (event.pubkey !== agentPubkey) return null; // self-authored only
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>;
    let selection: AgentModelSelection | undefined;
    if (content.selection && typeof content.selection === 'object') {
      const raw = content.selection as Record<string, unknown>;
      const model = typeof raw.model === 'string' ? raw.model : undefined;
      const effort = typeof raw.effort === 'string' ? raw.effort : undefined;
      if (model || effort) selection = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    }
    return {
      communityId,
      agentPubkey,
      options: parseOptionEntries(content.options),
      ...(selection ? { selection } : {}),
      updatedAt: event.created_at,
      raw: event,
    };
  } catch {
    return null;
  }
}

/**
 * Publish the agent's own advertised model/effort catalog. Called by the daemon
 * on session activation and at daemon start when a pair-time `--model`/
 * `--effort` default exists. `selection` is the agent's own effective choice
 * (a human pick when one exists, else that pair-time default) — it is what
 * makes a CLI-configured selection visible to the app before any session has
 * ever applied it.
 */
export async function publishAgentModelCatalog(
  ctx: ChannelOpsContext,
  communityId: string,
  options: AgentModelConfigOption[],
  selection?: AgentModelSelection,
): Promise<AgentModelCatalog> {
  const agentPubkey = ctx.identity.publicKey;
  // Normalize to the bare pair: callers may hand a full persisted record
  // (with `raw`/`authoredBy`/…), and none of that belongs on the wire.
  const cleanSelection = selection
    ? {
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.effort ? { effort: selection.effort } : {}),
      }
    : undefined;
  const event = signEvent(
    {
      pubkey: agentPubkey,
      created_at: nextModelConfigTimestamp(),
      kind: KIND_AGENT_MODEL_CATALOG,
      tags: [
        ['d', modelConfigKey(communityId, agentPubkey)],
        ['h', communityId],
        ['p', agentPubkey],
        ['t', TAG_AGENT_MODEL_CATALOG],
        [TAG_COMMUNITY, communityId],
      ],
      content: JSON.stringify({
        options,
        ...(cleanSelection && (cleanSelection.model || cleanSelection.effort)
          ? { selection: cleanSelection }
          : {}),
      }),
    },
    ctx.identity.secretKey,
  );
  await publishEvent(ctx.http, event);
  return parseAgentModelCatalog(event)!;
}

/** Read the latest advertised catalog for an agent, if any session has ever published one. */
export async function getAgentModelCatalog(
  ctx: ChannelOpsContext,
  communityId: string,
  agentPubkey: string,
): Promise<AgentModelCatalog | null> {
  const events = await query(ctx, [
    { kinds: [KIND_AGENT_MODEL_CATALOG], '#d': [modelConfigKey(communityId, agentPubkey)], limit: 5 },
  ]);
  let latest: AgentModelCatalog | null = null;
  for (const event of events) {
    const parsed = parseAgentModelCatalog(event);
    if (parsed && (!latest || latest.updatedAt < parsed.updatedAt)) latest = parsed;
  }
  return latest;
}

/** Parse a verified, human-authored model/effort selection. Authorization is checked by readers. */
export function parseAgentModelConfig(event: NostrEvent): AgentModelConfig | null {
  if (event.kind !== KIND_AGENT_MODEL_CONFIG || !verifyEvent(event)) return null;
  if (tagValue(event, 't') !== TAG_AGENT_MODEL_CONFIG) return null;
  const communityId = tagValue(event, 'h');
  const agentPubkey = tagValue(event, 'p');
  if (!communityId || tagValue(event, TAG_COMMUNITY) !== communityId || !agentPubkey) return null;
  if (tagValue(event, 'd') !== modelConfigKey(communityId, agentPubkey)) return null;
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>;
    const model = typeof content.model === 'string' ? content.model : undefined;
    const effort = typeof content.effort === 'string' ? content.effort : undefined;
    if (!model && !effort) return null;
    return {
      communityId,
      agentPubkey,
      authoredBy: event.pubkey,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      updatedAt: event.created_at,
      raw: event,
    };
  } catch {
    return null;
  }
}

/** Publish a human-chosen model/effort selection for an agent. Carries no authority over `mode`. */
export async function setAgentModelConfig(
  ctx: ChannelOpsContext,
  communityId: string,
  agentPubkey: string,
  input: AgentModelConfigInput,
): Promise<AgentModelConfig> {
  const members = await communityMembers(ctx, communityId);
  if (!members.some((member) => member.pubkey === ctx.identity.publicKey)) {
    throw new Error('only a community member can set an agent model config');
  }
  if (await isAgentIdentity(ctx, ctx.identity.publicKey)) {
    throw new Error('agent model config must be authored by a human community member');
  }
  const agents = await listAgents(ctx, communityId);
  if (!agents.some((agent) => agent.pubkey === agentPubkey)) {
    throw new Error('agent identity not found in community');
  }
  const model = input.model?.trim();
  const clearEffort = input.effort === null;
  const effort = typeof input.effort === 'string' ? input.effort.trim() : undefined;
  if (!model && !effort && !clearEffort) {
    throw new Error('agent model config requires a model or effort selection');
  }
  // Each picker row updates one axis. Preserve the other axis from the latest
  // human-authored selection so choosing effort after model does not erase the
  // model (and vice versa).
  const current = await getAgentModelConfig(ctx, communityId, agentPubkey);
  const nextModel = model ?? current?.model;
  const nextEffort = clearEffort ? undefined : effort ?? current?.effort;
  const event = signEvent(
    {
      pubkey: ctx.identity.publicKey,
      created_at: nextModelConfigTimestamp(),
      kind: KIND_AGENT_MODEL_CONFIG,
      tags: [
        ['d', modelConfigKey(communityId, agentPubkey)],
        ['h', communityId],
        ['p', agentPubkey],
        ['t', TAG_AGENT_MODEL_CONFIG],
        [TAG_COMMUNITY, communityId],
      ],
      content: JSON.stringify({
        ...(nextModel ? { model: nextModel } : {}),
        ...(nextEffort ? { effort: nextEffort } : {}),
      }),
    },
    ctx.identity.secretKey,
  );
  await publishEvent(ctx.http, event);
  return parseAgentModelConfig(event)!;
}

/** Read the latest persisted model/effort selection for an agent, if any. */
export async function getAgentModelConfig(
  ctx: ChannelOpsContext,
  communityId: string,
  agentPubkey: string,
): Promise<AgentModelConfig | null> {
  const events = await query(ctx, [
    { kinds: [KIND_AGENT_MODEL_CONFIG], '#d': [modelConfigKey(communityId, agentPubkey)], limit: 20 },
  ]);
  const members = await communityMembers(ctx, communityId);
  const memberPubkeys = new Set(members.map((member) => member.pubkey));
  let latest: AgentModelConfig | null = null;
  for (const event of events) {
    const parsed = parseAgentModelConfig(event);
    if (!parsed || !memberPubkeys.has(parsed.authoredBy)) continue;
    if (!latest || latest.updatedAt < parsed.updatedAt) latest = parsed;
  }
  return latest;
}
