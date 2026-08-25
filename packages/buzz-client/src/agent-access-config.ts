/** Paired-owner-signed replaceable access policy for one Workspace agent. */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { KIND_AGENT_ACCESS_CONFIG, TAG_AGENT_ACCESS_CONFIG } from './kinds.js';
import type { Identity } from './types.js';

export const AGENT_ACCESS_CONFIG_VERSION = 1 as const;
export const MAX_AGENT_ACCESS_ALLOWLIST = 64;
const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

export type AgentAccessPolicyV1 = 'everyone' | 'creator' | 'allowlist';

export interface AgentAccessConfigV1 {
  version: 1;
  workspaceId: string;
  agentPubkey: string;
  policy: AgentAccessPolicyV1;
  allowlist?: string[];
  revision: number;
  updatedAt: number;
}

export function agentAccessConfigKey(workspaceId: string, agentPubkey: string): string {
  if (!SAFE_ID.test(workspaceId) || !HEX_64.test(agentPubkey)) {
    throw new Error('invalid agent access config key');
  }
  return `${TAG_AGENT_ACCESS_CONFIG}:${workspaceId}:${agentPubkey}`;
}

function parseContent(value: unknown): AgentAccessConfigV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const list = input.allowlist;
  if (
    input.version !== 1 ||
    typeof input.workspaceId !== 'string' ||
    !SAFE_ID.test(input.workspaceId) ||
    typeof input.agentPubkey !== 'string' ||
    !HEX_64.test(input.agentPubkey) ||
    !['everyone', 'creator', 'allowlist'].includes(String(input.policy)) ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 1 ||
    !Number.isSafeInteger(input.updatedAt) ||
    (input.updatedAt as number) < 0
  ) {
    return undefined;
  }
  let allowlist: string[] | undefined;
  if (input.policy === 'allowlist') {
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > MAX_AGENT_ACCESS_ALLOWLIST ||
      list.some((pubkey) => typeof pubkey !== 'string' || !HEX_64.test(pubkey)) ||
      new Set(list).size !== list.length
    ) {
      return undefined;
    }
    allowlist = list as string[];
  } else if (list !== undefined) {
    return undefined;
  }
  return {
    version: 1,
    workspaceId: input.workspaceId,
    agentPubkey: input.agentPubkey,
    policy: input.policy as AgentAccessPolicyV1,
    ...(allowlist ? { allowlist } : {}),
    revision: input.revision as number,
    updatedAt: input.updatedAt as number,
  };
}

function uniqueTag(event: NostrEvent, name: string): string | undefined {
  const matches = event.tags.filter((tag) => tag[0] === name);
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

export function buildAgentAccessConfig(
  pairedOwner: Identity,
  input: AgentAccessConfigV1,
): NostrEvent {
  const value = parseContent(input);
  if (!value) throw new Error('invalid agent access config');
  return signEvent(
    {
      pubkey: pairedOwner.publicKey,
      created_at: value.updatedAt,
      kind: KIND_AGENT_ACCESS_CONFIG,
      tags: [
        ['d', agentAccessConfigKey(value.workspaceId, value.agentPubkey)],
        ['t', TAG_AGENT_ACCESS_CONFIG],
        ['workspace', value.workspaceId],
        ['agent', value.agentPubkey],
        ['policy', value.policy],
        ['revision', String(value.revision)],
        ['p', value.agentPubkey],
      ],
      content: JSON.stringify(value),
    },
    pairedOwner.secretKey,
  );
}

export function parseAgentAccessConfig(event: NostrEvent): AgentAccessConfigV1 | undefined {
  if (
    event.kind !== KIND_AGENT_ACCESS_CONFIG ||
    event.content.length > 8_000 ||
    !verifyEvent(event)
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return undefined;
  }
  const value = parseContent(parsed);
  if (
    !value ||
    event.created_at !== value.updatedAt ||
    uniqueTag(event, 'd') !== agentAccessConfigKey(value.workspaceId, value.agentPubkey) ||
    uniqueTag(event, 't') !== TAG_AGENT_ACCESS_CONFIG ||
    uniqueTag(event, 'workspace') !== value.workspaceId ||
    uniqueTag(event, 'agent') !== value.agentPubkey ||
    uniqueTag(event, 'policy') !== value.policy ||
    uniqueTag(event, 'revision') !== String(value.revision) ||
    uniqueTag(event, 'p') !== value.agentPubkey
  ) {
    return undefined;
  }
  return value;
}
