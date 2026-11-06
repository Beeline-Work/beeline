import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import type { RoomView } from '@beeline/api-contract/phone';
import { accessNoticeBucket, parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import { resolveCurrentMemberMentions, typedMentionHandles } from '../message-mentions.js';
import { type SqlDatabase } from '../database.js';
import { systemIdentityMention, systemLine } from '../system-line.js';
import type { PhoneContext } from './context.js';
import { phoneReadLiveDelta } from './live-reads.js';
import { messageId, mentionNoticeId, personMention } from './values.js';
import { phoneProjectPendingAgentCommands } from './message-enrichment.js';



  /**
   * Active turns targeted by the human write. The command and message commit
   * in one transaction, so the phone can distinguish a server-accepted steer
   * from text that merely looked addressed locally.
   */
  export async function phoneReceiptMessage(ctx: PhoneContext, roomId: string, viewerId: string, messageIdValue: string, database: SqlDatabase) {
    const delta = await phoneReadLiveDelta(ctx, roomId, viewerId, {
      type: 'message', messageId: messageIdValue,
    }, database);
    return delta?.type === 'message-delta' ? { message: delta.message } : {};
  }


  export async function phoneActiveSteerAgentIds(ctx: PhoneContext, database: SqlDatabase, messageIdValue: string) {
    const commands = await database.query<{ agent_id: string }>(
      `SELECT DISTINCT command.agent_id
       FROM agent_commands command
       JOIN agent_turns turn ON turn.room_id=command.room_id
         AND turn.agent_id=command.agent_id AND turn.status='working'
         AND COALESCE(turn.generation_id,'') NOT LIKE 'pending:%'
         AND turn.request_id<>command.turn_request_id
       WHERE command.source_message_id=$1 AND command.action='input'
       ORDER BY command.agent_id`,
      [messageIdValue],
    );
    return commands.rows.map((command) => command.agent_id);
  }

  export async function phonePendingAgentCommandsForMessage(ctx: PhoneContext,
    database: SqlDatabase,
    roomId: string,
    messageIdValue: string,
  ): Promise<NonNullable<RoomView['pendingAgentCommands']>> {
    const commands = await database.query<{
      agent_id: string;
      turn_request_id: string;
      created_at: Date;
    }>(
      `SELECT command.agent_id,command.turn_request_id,command.created_at
       FROM agent_commands command
       WHERE command.room_id=$1 AND command.source_message_id=$2
         AND command.state='pending' AND command.action='input'
         AND command.reason IN ('human_tag','direct_message')
       ORDER BY command.created_at,command.agent_id`,
      [roomId, messageIdValue],
    );
    return phoneProjectPendingAgentCommands(ctx, commands.rows);
  }

  /**
   * Say out loud why a mentioned agent will not answer. ONE producer for every
   * reason a mention lands and nothing happens.
   *
   * Silence is the failure this exists to end. A mention dropped by the agent's
   * access policy, a mention nobody is alive to read, and a mention of an agent
   * that is not in this corner all look identical in a Room, and all three look
   * like a broken product. So the SERVER — which owns the policy, sees the
   * helper's presence and knows the roster — inscribes one ordinary system line
   * (`presentation='system'`, the one grammar in `system-line.ts`). The line
   * mentions nobody, so it wakes no daemon and reaches a phone only where every
   * message already does — a DM, which is where the person who was refused most
   * needs to hear it.
   *
   * The reasons are ordered, not summed: an agent that is not in the corner is
   * told that and nothing else, because its policy and its availability are beside
   * the point. At most one line per (Room, agent, sender, reason) per
   * `ACCESS_NOTICE_WINDOW_MS` — the id is derived from the window bucket, so a
   * repeat inside it collides on the primary key and writes nothing. A chatty
   * non-permitted member gets one explanation, not a storm.
   *
   * Never throws: a notice is a courtesy on top of a message that is already
   * written, and must not fail the send.
   *
   * `afterMessageId` is the message the mentions rode in on: the line is its
   * consequence, so it is stamped strictly past that message's second and can
   * never render above it (see `orderingFloor` in `system-line.ts`).
   */
  export async function phoneNoteUnansweredMentions(ctx: PhoneContext,
    roomId: string,
    senderId: string,
    agentIds: readonly string[],
    afterMessageId?: string,
  ): Promise<void> {
    if (!agentIds.length) return;
    try {
      const sender = (
        await ctx.database.query<{ kind: 'human' | 'agent'; handle: string | null }>(
          `SELECT kind,handle FROM identities WHERE id=$1`,
          [senderId],
        )
      ).rows[0];
      if (!sender) return;
      const agents = await ctx.database.query<{
        agent_id: string;
        agent_name: string;
        agent_handle: string | null;
        access_policy: unknown;
        owner_id: string | null;
        owner_handle: string | null;
        member: boolean;
        corner: boolean;
      }>(
        `SELECT identity.id agent_id,COALESCE(NULLIF(identity.name,''),$3::text) agent_name,
                identity.handle agent_handle,
                a.access_policy,a.owner_id,owner.handle owner_handle,
                EXISTS(SELECT 1 FROM rooms room WHERE room.id=$2 AND room.parent_id IS NOT NULL) corner,
                EXISTS(
                  SELECT 1 FROM memberships membership
                  WHERE membership.room_id=$2 AND membership.identity_id=identity.id
                    AND membership.removed_at IS NULL
                ) member
         FROM identities identity
         LEFT JOIN agents a ON a.agent_id=identity.id
         LEFT JOIN identities owner ON owner.id=a.owner_id
         WHERE identity.id=ANY($1::text[]) AND identity.kind='agent'
           AND NOT EXISTS(SELECT 1 FROM rooms_mcp_members WHERE member_id=identity.id)`,
        [[...agentIds], roomId, systemMessage("system-line.agent-name")],
      );
      const bucket = accessNoticeBucket(Date.now());
      for (const agent of agents.rows) {
        const phrase = phoneUnansweredMentionPhrase(ctx, agent, sender, senderId);
        if (!phrase) continue;
        await phoneWriteMentionNotice(ctx, ctx.database, {
          roomId,
          id: mentionNoticeId(roomId, agent.agent_id, senderId, phrase.reason, bucket),
          agentId: agent.agent_id,
          agentName: agent.agent_name,
          phrase,
          afterMessageId,
        });
      }
    } catch (error) {
      console.error('[server] could not inscribe an unanswered mention:', error);
    }
  }


  export async function phoneWriteMentionNotice(ctx: PhoneContext,
    database: SqlDatabase,
    input: {
      readonly roomId: string;
      readonly id: string;
      readonly agentId: string;
      readonly agentName: string;
      readonly phrase: {
        readonly reason: string;
        readonly verb: string;
        readonly consequence: string;
        readonly object?: { text: string; id: string };
      };
      readonly afterMessageId?: string;
    },
  ): Promise<void> {
    await systemLine(database, {
      roomId: input.roomId,
      id: input.id,
      subject: { kind: 'agent', id: input.agentId, name: input.agentName },
      verb: input.phrase.verb,
      ...(input.phrase.object ? { object: input.phrase.object } : {}),
      consequence: input.phrase.consequence,
      afterMessageId: input.afterMessageId,
    });
  }


  export function phoneUnansweredMentionPhrase(ctx: PhoneContext,
    agent: {
      agent_id: string;
      agent_name: string;
      agent_handle: string | null;
      access_policy: unknown;
      owner_id: string | null;
      owner_handle: string | null;
      member: boolean;
      corner: boolean;
    },
    sender: { kind: 'human' | 'agent'; handle: string | null },
    senderId: string,
  ):
    | { reason: string; verb: string; consequence: string; object?: { text: string; id: string } }
    | undefined {
    // A corner is carried by its MEMBERS, so a mention of an agent that is not
    // one resolves fine and then produces nothing at all — no turn, no message,
    // no error.
    if (!agent.member) {
      return agent.corner
        ? {
            reason: 'not-a-member',
            verb: systemMessage("phone-service.could-not-be-reached"),
            consequence: systemMessage("phone-service.not-a-member-of-this-corner"),
          }
        : undefined;
    }
    // An agent is a server-validated Room member; the owner's cost policy gates
    // people, and an agent-to-agent hop is capped elsewhere.
    const permitted =
      sender.kind !== 'human' ||
      senderMayAddressAgent(
        parseAgentAccessPolicy(agent.access_policy),
        senderId,
        agent.owner_id ?? undefined,
      );
    // A person is named by their @handle, never by a display name: the handle is
    // the address the reader can actually use, and it is unique where a display
    // name is not. A person with no handle is left unnamed rather than described.
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
        verb: systemMessage("phone-service.did-not-answer"),
        ...(object ? { object } : {}),
        consequence: systemMessage("phone-service.only-may-address-ask-the-user-for-permission-to-access-the-agent", personMention(agent.owner_handle) ?? systemMessage("phone-service.the-owner"), agentMention),
      };
    }
    return undefined;
  }

  /**
   * The agents this message tries to reach, for the sole purpose of saying so
   * when one of them cannot answer. This is NOT the message's address — who a
   * message tags is read from its text on demand (`message-mentions.ts`) and
   * never recorded. It is the wider set worth explaining: an agent named in a
   * corner it has not joined is unreachable in a way the writer should hear
   * about, and a tag alone would say nothing.
   */
  export async function phoneUnansweredMentionTargets(ctx: PhoneContext,
    roomId: string,
    author: string,
    text: string,
    source?: { authorKind: 'human' | 'agent'; direct: boolean; corner: boolean },
  ): Promise<readonly string[]> {
    // A send already read these facts in its membership-fenced insert. Replies
    // retain the lookup because they do not carry that same source context.
    const authorKind = source?.authorKind ?? (
      await ctx.database.query<{ kind: 'human' | 'agent' }>(
        `SELECT kind FROM identities WHERE id=$1`,
        [author],
      )
    ).rows[0]?.kind;
    if (authorKind !== 'human') return [];
    const resolvedMembers = await resolveCurrentMemberMentions(ctx.database, roomId, text, author);
    const typedHandles = typedMentionHandles(text);
    const noticeAgentIds = new Set(
      resolvedMembers.filter((member) => member.kind === 'agent').map((member) => member.id),
    );
    const directAgents = source?.direct === false ? { rows: [] } : await ctx.database.query<{ id: string }>(
      `SELECT identity.id
       FROM rooms room
       JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(room.direct_participants)='array'
           THEN room.direct_participants ELSE '[]'::jsonb END
       ) participant(id) ON true
       JOIN identities identity ON identity.id=participant.id AND identity.kind='agent'
       JOIN memberships membership ON membership.room_id=room.id
         AND membership.identity_id=identity.id AND membership.removed_at IS NULL
       WHERE room.id=$1 AND jsonb_array_length(
         CASE WHEN jsonb_typeof(room.direct_participants)='array'
           THEN room.direct_participants ELSE '[]'::jsonb END
       )=2`,
      [roomId],
    );
    // A private two-member DM with one agent is already an addressed surface:
    // every human message in it is for that sole helper, including the first
    // untagged message and a reply to the human's own row. The address is the
    // Room, not a tag, and `routeHumanMessage` reads it from the participant
    // list — so this only decides whether an unreachable helper is worth a word.
    if (directAgents.rows.length === 1) {
      noticeAgentIds.add(directAgents.rows[0]!.id);
    }
    const absentCornerAgents = !typedHandles.size || source?.corner === false
      ? { rows: [] } : await ctx.database.query<{ id: string; handle: string }>(
      `SELECT identity.id,identity.handle
       FROM rooms room
       JOIN memberships workspace_membership ON workspace_membership.workspace_id=room.workspace_id
         AND workspace_membership.room_id IS NULL AND workspace_membership.removed_at IS NULL
       JOIN identities identity ON identity.id=workspace_membership.identity_id
         AND identity.kind='agent' AND identity.handle IS NOT NULL
       LEFT JOIN memberships room_membership ON room_membership.room_id=room.id
         AND room_membership.identity_id=identity.id AND room_membership.removed_at IS NULL
       WHERE room.id=$1 AND room.parent_id IS NOT NULL AND room_membership.identity_id IS NULL`,
      [roomId],
    );
    const resolvedHandles = new Set(resolvedMembers.map((member) => member.handle));
    const absentByHandle = new Map<string, string[]>();
    for (const agent of absentCornerAgents.rows) {
      const handle = agent.handle;
      const candidates = absentByHandle.get(handle) ?? [];
      candidates.push(agent.id);
      absentByHandle.set(handle, candidates);
    }
    for (const handle of typedHandles) {
      if (resolvedHandles.has(handle)) continue;
      const candidates = absentByHandle.get(handle);
      if (candidates?.length === 1) noticeAgentIds.add(candidates[0]!);
    }
    return [...noticeAgentIds];
  }
