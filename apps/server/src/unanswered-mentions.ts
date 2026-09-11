import { createHash } from 'node:crypto';
import {
  AGENT_REACHABLE_HORIZON_MS,
  accessNoticeBucket,
  parseAgentAccessPolicy,
  senderMayAddressAgent,
} from '@beeline/api-contract/agent-access';
import type { SqlDatabase } from './database.js';
import { systemIdentityMention, systemLine } from './system-line.js';

function personMention(handle: string | null | undefined): string | undefined {
  const canonical = handle?.trim().replace(/^@/, '');
  return canonical ? `@${canonical}` : undefined;
}

interface MentionedAgent {
  agent_id: string;
  agent_name: string;
  agent_handle: string | null;
  access_policy: unknown;
  owner_id: string | null;
  owner_handle: string | null;
  member: boolean;
  corner: boolean;
  reachable: boolean;
}

interface Sender {
  kind: 'human' | 'agent';
  handle: string | null;
}

function unansweredMentionPhrase(agent: MentionedAgent, sender: Sender, senderId: string) {
  if (!agent.member) {
    return agent.corner
      ? {
          reason: 'not-a-member',
          verb: 'could not be reached',
          consequence: 'not a member of this corner',
        }
      : undefined;
  }
  const permitted =
    sender.kind !== 'human' ||
    senderMayAddressAgent(
      parseAgentAccessPolicy(agent.access_policy),
      senderId,
      agent.owner_id ?? undefined,
    );
  const asked = personMention(sender.handle);
  const object = asked ? { text: asked, id: senderId } : undefined;
  const agentMention = systemIdentityMention({
    id: agent.agent_id,
    kind: 'agent',
    name: agent.agent_name,
    handle: agent.agent_handle,
  });
  if (!permitted) {
    return {
      reason: 'refused',
      verb: 'did not answer',
      ...(object ? { object } : {}),
      consequence: `only ${personMention(agent.owner_handle) ?? 'the owner'} may address ${agentMention}. Ask the user for permission to access the agent in the members page`,
    };
  }
  if (agent.reachable) return undefined;
  return {
    reason: 'unreachable',
    verb: 'did not answer',
    ...(object ? { object } : {}),
    consequence: 'its helper is offline',
  };
}

/**
 * Say why a mentioned agent will not answer. This is shared by the send path,
 * which knows an agent is already unreachable, and the delivery deadline,
 * which proves that an apparently-online agent did not pick the command up.
 * The derived id keeps both paths one idempotent producer.
 */
export async function noteUnansweredMentions(
  database: SqlDatabase,
  roomId: string,
  senderId: string,
  mentionIds: readonly string[],
  afterMessageId?: string,
): Promise<void> {
  if (!mentionIds.length) return;
  try {
    const sender = (
      await database.query<Sender>(`SELECT kind,handle FROM identities WHERE id=$1`, [senderId])
    ).rows[0];
    if (!sender) return;
    const agents = await database.query<MentionedAgent>(
      `SELECT identity.id agent_id,COALESCE(NULLIF(identity.name,''),'The agent') agent_name,
              identity.handle agent_handle,
              a.access_policy,a.owner_id,owner.handle owner_handle,
              EXISTS(SELECT 1 FROM rooms room WHERE room.id=$2 AND room.parent_id IS NOT NULL) corner,
              EXISTS(
                SELECT 1 FROM memberships membership
                WHERE membership.room_id=$2 AND membership.identity_id=identity.id
                  AND membership.removed_at IS NULL
              ) member,
              COALESCE((SELECT lo.body->>'status'='online'
                  AND lo.updated_at >= now()-make_interval(secs => $3::double precision / 1000)
                FROM live_outputs lo
                WHERE lo.agent_id=identity.id AND lo.kind='presence'
                ORDER BY lo.updated_at DESC LIMIT 1),false) reachable
       FROM identities identity
       LEFT JOIN agents a ON a.agent_id=identity.id
       LEFT JOIN identities owner ON owner.id=a.owner_id
       WHERE identity.id=ANY($1::text[]) AND identity.kind='agent'`,
      [[...mentionIds], roomId, AGENT_REACHABLE_HORIZON_MS],
    );
    const bucket = accessNoticeBucket(Date.now());
    for (const agent of agents.rows) {
      const phrase = unansweredMentionPhrase(agent, sender, senderId);
      if (!phrase) continue;
      await systemLine(database, {
        roomId,
        id: createHash('sha256')
          .update(
            `access-notice|${roomId}|${agent.agent_id}|${senderId}|${phrase.reason}|${bucket}`,
          )
          .digest('hex'),
        subject: { kind: 'agent', id: agent.agent_id, name: agent.agent_name },
        verb: phrase.verb,
        ...(phrase.object ? { object: phrase.object } : {}),
        consequence: phrase.consequence,
        afterMessageId,
      });
    }
  } catch (error) {
    console.error('[server] could not inscribe an unanswered mention:', error);
  }
}
