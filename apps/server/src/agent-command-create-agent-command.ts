import { dropQueuedOrdersForStop } from './agent-command-queue.js';
import { lockAgentCommandQueue } from './agent-command-queue.js';
import { endAgentTurn } from './agent-turn-end.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { commandOwnerLiveSql } from './turn-ownership.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { recordMcpMention, recordMcpMemberWebhook } from './rooms-mcp-members.js';
import { AGENT_SIGN_IN_SERVICE_LABELS, agentSignInUsesKey, isAgentSignInHarness } from '@beeline/api-contract/daemon';
import { createHash } from 'node:crypto';
import { parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import type { SqlDatabase } from './database.js';
import { hasSystemReportMention, taggedIdentityIdsSql, typedMentionHandles } from './message-mentions.js';
import { systemLine } from './system-line.js';
import { AgentCommandInput, CommandRow, createAgentCommand } from './agent-command.js';



export const TAGGED_AGENT_LIFECYCLE_COMMANDS = [
  'restart',
  'status',
  'stop',
  'retry',
  'debug',
  'help',
  'login',
] as const;

export type TaggedAgentLifecycleCommand = (typeof TAGGED_AGENT_LIFECYCLE_COMMANDS)[number];


export function parseTaggedAgentLifecycleCommand(
  text: string,
  handle: string | null,
): TaggedAgentLifecycleCommand | undefined {
  if (!handle) return undefined;
  const match = text
    .trim()
    .match(/^@([^\s]+)\s+(?:\/(restart|login)|(restart|status|stop|retry|debug|help|login))$/i);
  if (!match || match[1]!.toLocaleLowerCase() !== handle.toLocaleLowerCase()) return undefined;
  return (match[2] ?? match[3])!.toLocaleLowerCase() as TaggedAgentLifecycleCommand;
}


/** The one sign-in card an `@agent /login` message writes. */
export function agentSignInCardId(sourceMessageId: string, agentId: string): string {
  return createHash('sha256').update(`agent-sign-in:${sourceMessageId}:${agentId}`).digest('hex');
}


/** True for the exact text of an `@agent /login` / `@agent /login` message. */
export function isTaggedLoginText(text: string): boolean {
  return /^@[^\s]+\s+\/?login$/i.test(text.trim());
}


export type LifecycleTarget = {
  agent_id: string;
  owner_id: string;
  harness: string | null;
  handle: string | null;
  name: string;
  lifecycle_id: string | null;
  release_version: string | null;
  source_sha: string | null;
  presence_status: string | null;
  presence_updated_at: Date | null;
  presence_held: boolean | null;
};


export function lifecycleSubject(target: LifecycleTarget) {
  return {
    kind: 'agent' as const,
    id: target.agent_id,
    name: target.handle ? systemMessage("agent-command.agent-mention", target.handle) : target.name,
  };
}


export async function routeTaggedLifecycleCommand(
  db: SqlDatabase,
  source: { room_id: string; author_id: string; text: string; tagged_ids: string[] },
  sourceId: string,
): Promise<boolean> {
    db = new CornerAccessDatabase(db);
  if (
    source.tagged_ids.length !== 1 ||
    !/^@[^\s]+\s+(?:\/(?:restart|login)|restart|status|stop|retry|debug|help|login)$/i.test(
      source.text.trim(),
    )
  )
    return false;
  const target = (
    await db.query<LifecycleTarget>(
      `SELECT agent.agent_id,agent.owner_id,agent.harness,identity.handle,identity.name,
         presence.body->>'lifecycleId' lifecycle_id,
         presence.body->>'releaseVersion' release_version,
         presence.body->>'sourceSha' source_sha,
         presence.body->>'status' presence_status,presence.updated_at presence_updated_at,
         presence.body->>'held'='true' presence_held
       FROM agents agent
       JOIN identities identity ON identity.id=agent.agent_id
       JOIN memberships target_member ON target_member.room_id=$2
         AND target_member.identity_id=agent.agent_id AND target_member.removed_at IS NULL
       JOIN memberships sender ON sender.room_id=$2
         AND sender.identity_id=$3 AND sender.removed_at IS NULL
       LEFT JOIN LATERAL (
         SELECT body,updated_at FROM live_outputs
         WHERE agent_id=agent.agent_id AND kind='presence'
         ORDER BY updated_at DESC LIMIT 1
       ) presence ON true
       WHERE agent.agent_id=$1
         AND NOT EXISTS(SELECT 1 FROM rooms_mcp_members WHERE member_id=agent.agent_id)
       FOR SHARE OF agent,sender`,
      [source.tagged_ids[0], source.room_id, source.author_id],
    )
  ).rows[0];
  if (!target) return false;
  const action = parseTaggedAgentLifecycleCommand(source.text, target.handle);
  if (!action) return false;

  // Restart, stop, retry and debug are open to anyone in the Room: they only
  // interrupt the agent and debug reports this Room's turn alone. A Room, corner
  // or DM role never changes that, and neither does the agent's access policy,
  // which decides only who may give it work. Sign-in stays with the agent's owner.
  const ownsAgent = target.owner_id === source.author_id;
  const loginHarness = isAgentSignInHarness(target.harness) ? target.harness : undefined;
  const deniedVerb =
    action !== 'login'
      ? systemMessage("agent-command.did-not", action)
      : !loginHarness
        ? systemMessage("agent-command.did-not-sign-in")
        : agentSignInUsesKey(loginHarness)
          ? systemMessage("agent-command.did-not-take-a-new-key")
          : systemMessage("agent-command.did-not-sign-in-to", AGENT_SIGN_IN_SERVICE_LABELS[loginHarness]);
  const deny = async (consequence: string) => {
    await systemLine(db, {
      id: createHash('sha256')
        .update(`agent-lifecycle:${sourceId}:${target.agent_id}:denied`)
        .digest('hex'),
      roomId: source.room_id,
      authorId: target.agent_id,
      subject: lifecycleSubject(target),
      verb: deniedVerb,
      consequence,
      afterMessageId: sourceId,
    });
  };
  if (action === 'login') {
    // Claude Code's own `/login`, at the call site, for every harness: the
    // card carries what the machine answers (a link, a device code, or a key
    // field) once `beginAgentSignInCards` asks after this transaction commits.
    // A code or key is pasted into the card, never sent as a message.
    if (!ownsAgent) {
      await deny(systemMessage("agent-command.only-its-owner-may-sign-it-in"));
      return true;
    }
    const harness = loginHarness;
    if (!harness) {
      await deny(systemMessage("agent-command.sign-in-from-beeline-is-not-available-for-its-harness"));
      return true;
    }
    await systemLine(db, {
      id: agentSignInCardId(sourceId, target.agent_id),
      roomId: source.room_id,
      authorId: target.agent_id,
      subject: lifecycleSubject(target),
      verb: agentSignInUsesKey(harness)
        ? systemMessage("agent-command.asked-for-a-new-key")
        : systemMessage("agent-command.started-a-sign-in", AGENT_SIGN_IN_SERVICE_LABELS[harness]),
      consequence: systemMessage("agent-command.its-owner-finishes-it-in-this-card"),
      afterMessageId: sourceId,
      presentation: 'card',
      cardType: 'agent-sign-in',
      card: {
        agentId: target.agent_id,
        ownerId: target.owner_id,
        harness,
        status: 'starting',
        sourceMessageId: sourceId,
      },
    });
    return true;
  }

  const active = (
    await db.query<{
      request_id: string;
      command_id: string;
      root_source_message_id: string;
      requested_by: string;
    }>(
      `SELECT turn.request_id,command.id command_id,command.root_source_message_id,
         root.author_id requested_by
       FROM agent_turns turn
       JOIN agent_commands command ON command.room_id=turn.room_id
         AND command.agent_id=turn.agent_id AND command.turn_request_id=turn.request_id
         AND command.action IN ('input','resume')
       JOIN messages root ON root.id=command.root_source_message_id
       WHERE turn.room_id=$1 AND turn.agent_id=$2 AND turn.status='working'
         AND command.state='claimed' AND ${commandOwnerLiveSql('command')}
         AND command.generation_id=turn.generation_id
         AND turn.generation_id NOT LIKE 'pending:%'
       ORDER BY turn.created_at DESC,command.created_at DESC LIMIT 1`,
      [source.room_id, target.agent_id],
    )
  ).rows[0];
  const line = async (verb: string, consequence?: string) =>
    systemLine(db, {
      id: createHash('sha256')
        .update(`agent-lifecycle:${sourceId}:${target.agent_id}:${action}`)
        .digest('hex'),
      roomId: source.room_id,
      authorId: target.agent_id,
      subject: lifecycleSubject(target),
      verb,
      ...(consequence ? { consequence } : {}),
      afterMessageId: sourceId,
    });

  if (action === 'help') {
    await line(
      systemMessage("agent-command.supports-lifecycle-commands"),
      systemMessage("agent-command.restart-status-stop-retry-debug-help-login"),
    );
    return true;
  }
  const online =
    target.presence_status === 'online' &&
    (target.presence_held === true ||
      (Boolean(target.presence_updated_at) &&
        Date.now() - target.presence_updated_at!.getTime() < 90_000));
  if (action === 'status') {
    await line(
      online ? systemMessage("agent-command.is-online") : systemMessage("agent-command.is-offline"),
      active ? systemMessage("agent-command.one-turn-is-running") : systemMessage("agent-command.no-turn-is-running"),
    );
    return true;
  }
  if (action === 'debug') {
    const details = [
      systemMessage("agent-command.lifecycle", target.lifecycle_id ?? systemMessage("agent-command.unknown")),
      systemMessage("agent-command.release", target.release_version ?? systemMessage("agent-command.unknown")),
      systemMessage("agent-command.source", target.source_sha?.slice(0, 12) ?? systemMessage("agent-command.unknown")),
      active ? systemMessage("agent-command.turn", active.request_id) : systemMessage("agent-command.no-active-turn"),
    ];
    await line(systemMessage("agent-command.reported-diagnostics"), details.join(systemMessage("agent-command.separator")));
    return true;
  }
  if (action === 'stop') {
    if (!active) {
      await line(systemMessage("agent-command.has-nothing-to-stop"));
      return true;
    }
    await lockAgentCommandQueue(db, source.room_id, target.agent_id);
    const parent = (
      await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1 FOR UPDATE`, [
        active.command_id,
      ])
    ).rows[0]!;
    await createAgentCommand(db, {
      roomId: source.room_id,
      agentId: target.agent_id,
      sourceMessageId: sourceId,
      turnRequestId: active.request_id,
      action: 'stop',
      reason: 'tagged_lifecycle_stop',
      parent,
      retainDepth: true,
    });
    if (!await endAgentTurn(db, parent, 'cancelled', 'stop')) throw new Error('running turn not found');
    const dropped = await dropQueuedOrdersForStop(db, parent);
    await db.query(
      `SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(agent_commands.id,agent_commands.generation_id,'cancelled',NULL,NULL) ended FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3
         AND action IN ('input','resume') AND state IN ('pending','claimed')) terminal`,
      [source.room_id, target.agent_id, active.request_id],
    );
    await line(systemMessage("agent-command.stopped-its-running-turn"), dropped ? systemMessage("agent-command.queued-dropped", dropped, dropped === 1 ? systemMessage("agent-command.order") : systemMessage("agent-command.orders")) : undefined);
    return true;
  }
  if (action === 'retry') {
    const failed = (
      await db.query<CommandRow>(
        `SELECT command.* FROM agent_commands command
         JOIN agent_turns turn ON turn.room_id=command.room_id
           AND turn.agent_id=command.agent_id AND turn.request_id=command.turn_request_id
         WHERE command.room_id=$1 AND command.agent_id=$2
           AND command.action IN ('input','resume') AND turn.status='failed'
         ORDER BY turn.created_at DESC,command.created_at DESC LIMIT 1 FOR UPDATE OF command`,
        [source.room_id, target.agent_id],
      )
    ).rows[0];
    if (!failed) {
      await line(systemMessage("agent-command.has-no-failed-turn-to-retry"));
      return true;
    }
    await createAgentCommand(db, {
      roomId: source.room_id,
      agentId: target.agent_id,
      sourceMessageId: sourceId,
      turnRequestId: failed.turn_request_id,
      action: 'resume',
      reason: 'tagged_lifecycle_retry',
      parent: failed,
      retainDepth: true,
    });
    await line(systemMessage("agent-command.queued-a-retry-for-its-last-failed-turn"));
    return true;
  }

  const restart = await createAgentCommand(db, {
    roomId: source.room_id,
    agentId: target.agent_id,
    sourceMessageId: sourceId,
    action: 'restart',
    reason: 'tagged_lifecycle_restart',
  });
  if (!restart) {
    await line(systemMessage("agent-command.already-has-a-restart-in-progress"));
    return true;
  }
  await db.query(`UPDATE agent_commands SET lifecycle_before=$2 WHERE id=$1`, [restart.id,target.lifecycle_id]);
  await line(
    systemMessage("agent-command.queued-a-restart"),
    active ? systemMessage("agent-command.running-turn-will-drain-first") : systemMessage("agent-command.helper-will-reconnect-to-confirm"),
  );
  return true;
}


/** The sole agent in a top-level Room with exactly one current human member. */
export function soloRoomAgentSql(room: string, author: string): string {
  return `(SELECT CASE WHEN count(*) FILTER (WHERE solo_identity.kind='agent')=1
      THEN min(member.identity_id) FILTER (WHERE solo_identity.kind='agent')
      ELSE min(member.identity_id) FILTER (WHERE starter.starter_role='beebee') END
    FROM memberships member JOIN identities solo_identity ON solo_identity.id=member.identity_id
    LEFT JOIN free_agents starter ON starter.agent_id=member.identity_id AND starter.owner_id=${author}
      AND starter.removed_at IS NULL
    WHERE member.room_id=${room}.id AND member.removed_at IS NULL
      AND ${room}.parent_id IS NULL AND ${room}.direct_participants IS NULL
    HAVING count(*) FILTER (WHERE solo_identity.kind='human')=1
       AND (count(*) FILTER (WHERE solo_identity.kind='agent')=1 OR
         (count(*) FILTER (WHERE solo_identity.kind='agent')=2
          AND count(*) FILTER (WHERE starter.starter_role IN ('beebee','luna'))=2
          AND count(*) FILTER (WHERE starter.starter_role='beebee')=1))
       AND bool_or(member.identity_id=${author}))`;
}


export async function routeHumanMessage(db: SqlDatabase, sourceId: string): Promise<boolean> {
    db = new CornerAccessDatabase(db);
  // Who this message tags is read in the SAME statement that reads the message.
  // Routing is on the write path of every human message in every Room, so the
  // tags cost no round trip of their own.
  const source = (
    await db.query<{
      room_id: string;
      author_id: string;
      text: string;
      direct_participants: string[] | null;
      parent_id: string | null;
      tagged_ids: string[];
      solo_agent_id: string | null;
    }>(
      `SELECT m.room_id,m.author_id,m.text,r.direct_participants,r.parent_id,
   ${taggedIdentityIdsSql('m')} tagged_ids,
   ${soloRoomAgentSql('r', 'm.author_id')} solo_agent_id
 FROM messages m JOIN identities i ON i.id=m.author_id AND i.kind='human'
 JOIN rooms r ON r.id=m.room_id
 WHERE m.id=$1 AND m.presentation='message' AND m.system_event IS NULL`,
      [sourceId],
    )
  ).rows[0];
  if (!source) return false;
  if (await routeTaggedLifecycleCommand(db, source, sourceId)) return true;
  // A sole human and agent in a top-level Room use the same target/command
  // path as direct conversations. Count current members in the source read,
  // without adding a database round trip; explicit addresses keep routing.
  const avatarJob = /^(?:@[^\s]+\s+)?\/draw-avatar(?:\s|$)/i.test(source.text.trim());
  // A report to `@system` (feedback.ts) addresses System, which is nobody:
  // in a DM it wakes only an agent the message also tags by name.
  const targets = new Set([
    ...source.tagged_ids,
    ...(source.solo_agent_id && typedMentionHandles(source.text).size === 0
      ? [source.solo_agent_id] : []),
    ...(hasSystemReportMention(source.text) ? [] : (source.direct_participants ?? [])),
  ]);
  targets.delete(source.author_id);
  for (const target of targets) {
    const agent = (
      await db.query<{ owner_id: string; access_policy: unknown; mcp_callback_url: string | null; mcp_member: boolean }>(
        `SELECT a.owner_id,a.access_policy,COALESCE(member.callback_url,client.callback_url) mcp_callback_url,
     member.member_id IS NOT NULL mcp_member FROM agents a
   LEFT JOIN rooms_mcp_members member ON member.member_id=a.agent_id
   LEFT JOIN rooms_mcp_clients client ON client.id=member.client_id
   JOIN memberships m ON m.identity_id=$2 AND m.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=$3) AND m.removed_at IS NULL
   WHERE a.agent_id=$1 FOR ${avatarJob ? 'UPDATE' : 'SHARE'} OF a,m`,
        [target, source.author_id, source.room_id],
      )
    ).rows[0];
    if (
      !agent ||
      !senderMayAddressAgent(
        parseAgentAccessPolicy(agent.access_policy),
        source.author_id,
        agent.owner_id,
      )
    )
      continue;
    if (agent.mcp_member) {
      await recordMcpMention(db, target, source.room_id, sourceId);
      if (agent.mcp_callback_url)
        await recordMcpMemberWebhook(db, target, agent.mcp_callback_url, source.room_id, sourceId, source.text);
      continue;
    }
    if (avatarJob) {
      if (agent.owner_id !== source.author_id)
        throw new Error('only the agent owner may generate its avatar (access denied)');
      const active = await db.query(
        `SELECT 1 FROM agent_commands WHERE agent_id=$1 AND avatar_job AND state IN ('pending','claimed')`,
        [target],
      );
      if (active.rowCount) throw new Error('avatar generation already active (conflict)');
    }
    await createAgentCommand(db, {
      roomId: source.room_id,
      agentId: target,
      avatarJob,
      sourceMessageId: sourceId,
      reason: source.direct_participants ? 'direct_message' : 'human_tag',
    });
  }
  return false;
}
