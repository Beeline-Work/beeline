import { HOST_EMULATOR_TARGET } from '@beeline/api-contract/agent-grants';
import { resourceRequester } from '../resource-requester.js';
import { cornerReviewerSql } from '../corner-reviewer.js';
import { normalizeAgentAsk } from '../tray-approval-ask.js';
import { authorizeCommandOutput } from '../agent-command.js';
import { randomUUID } from 'node:crypto';
import { cornerImplementerSql } from '../corner-worker.js';
import { AGENT_GRANT_REASON_MAX_LENGTH, AGENT_GRANT_TARGET_MAX_LENGTH, commandRuleEscalations, isRequestableAgentGrantKind, isSharedAssetCategory, isCommandGrantScript, parseCommandGrantTarget, type AgentGrantEscalation, type AgentGrantKind, type CommandGrantRule, type CommandGrantScript } from '@beeline/api-contract/agent-grants';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { restateSystemLine, ensureSystemDirectMessageRoom, systemLine } from '../system-line.js';
import { postRoomChoice } from '../room-choice.js';
import { workflowRunRequester } from '../workflow-runs.js';
import type { DaemonContext } from './context.js';
import { Input, validateGrantScript, id, seconds, grantCardPhrase } from './values.js';
import { daemonApprovalSource } from './approvals.js';
import { daemonWriteResult } from './corner-messages.js';



  /**
   * request_grant records owner-machine access without a card. Wallet access
   * retains its requester/yolo rule. Credential files and unread scripts still
   * require a person. Budget and repository asks are retired.
   */
  export async function daemonRequestAgentGrant(ctx: DaemonContext, input: Input<'requestAgentGrant'>, agentId: string, requireOwnerApproval = false) {
    if (typeof input.purpose !== 'string' || !input.purpose.trim() || input.purpose.trim().length > 240)
      throw new Error('grant purpose is required: explain what you want to do and why in 1–240 characters');
    for (const field of ['touches', 'capabilities'] as const) {
      if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field]!.trim() || input[field]!.trim().length > 240))
        throw new Error(`grant ${field} must be 1–240 characters`);
    }
    if (!isRequestableAgentGrantKind(input.kind)) throw new Error('grant kind is invalid');
    if (typeof input.target !== 'string' || !input.target.trim())
      throw new Error('grant target is required');
    if (input.target.length > AGENT_GRANT_TARGET_MAX_LENGTH)
      throw new Error('grant target is invalid: too long');
    if (typeof input.reason !== 'string' || !input.reason.trim())
      throw new Error('grant reason is required');
    if (input.reason.length > AGENT_GRANT_REASON_MAX_LENGTH)
      throw new Error('grant reason is invalid: too long');
    if (
      input.ttlSeconds !== undefined &&
      (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0)
    )
      throw new Error('grant ttlSeconds is invalid');
    const kind: AgentGrantKind = input.kind;
    const target = kind === 'command' ? input.target : input.target.trim();
    if (kind === 'shared_asset' && !isSharedAssetCategory(target))
      throw new Error('shared asset category is invalid');
    if (kind === 'shared_asset' && (input.ttlSeconds !== undefined || input.script !== undefined))
      throw new Error('shared asset isolation must be standing');
    const squireRoute = kind === 'mcp' && target === 'squire';
    let rule: CommandGrantRule | undefined;
    if (kind === 'command') {
      try {
        rule = parseCommandGrantTarget(target);
      } catch (error) {
        throw new Error(
          `command target is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // C94: yolo is the scope gate and it is enough — except for the two hard
    // stops, which stand in a Room and in a corner whether yolo is on or not.
    const script = rule ? validateGrantScript(rule, input.script) : undefined;
    const escalations: AgentGrantEscalation[] = rule ? commandRuleEscalations(rule, script) : [];
    const reason = input.reason.trim();
    if (kind === 'shared_asset') {
      const existing = await ctx.database.query<{ status: string }>(
        `SELECT status FROM agent_grants WHERE agent_id=$1 AND kind='shared_asset'
         AND target=$2 AND status IN ('pending','approved') LIMIT 1`,
        [agentId, target],
      );
      if (existing.rowCount)
        throw new Error(`shared asset isolation conflict: ${target} is already ${existing.rows[0]!.status}`);
    }
    const context = (
      await ctx.database.query<{
        workspace_id: string;
        parent_id: string | null;
        owner_id: string;
        yolo_mode: boolean;
        machine_name: string | null;
        agent_name: string;
        agent_handle: string | null;
        agent_avatar: string | null;
        owner_name: string;
        owner_handle: string | null;
        owner_avatar: string | null;
      }>(
        `SELECT room.workspace_id,room.parent_id,a.owner_id,a.machine_name,
                CASE WHEN workspace.visibility='public' THEN false ELSE a.yolo_mode END yolo_mode,
                agent.name agent_name,agent.handle agent_handle,agent.avatar agent_avatar,
                owner.name owner_name,owner.handle owner_handle,owner.avatar owner_avatar
         FROM rooms room
         JOIN workspaces workspace ON workspace.id=room.workspace_id
         JOIN agents a ON a.agent_id=$2
         JOIN identities agent ON agent.id=a.agent_id
         JOIN identities owner ON owner.id=a.owner_id
         WHERE room.id=$1`,
        [input.roomId, agentId],
      )
    ).rows[0];
    if (!context) throw new Error('agent not found');
    const source = await daemonApprovalSource(ctx, 'grant-request');
    const requesterRow = await daemonGrantRequester(ctx);
    const connectionInstall = kind === 'mcp' && target.startsWith('connection-install:');
    const appOwner = (target.startsWith('app:') || connectionInstall) && input.appId
      ? (await ctx.database.query<{ id: string; name: string; handle: string | null;
          avatar: string | null; display_name: string }>(
          `SELECT person.id,person.name,person.handle,person.avatar,app.display_name
           FROM workspace_apps app JOIN identities person ON person.id=app.owner_identity_id
           WHERE app.id=$1::uuid AND app.app_key=$2 AND app.state='active'
             AND ($3::boolean OR app.transport='composio')`,
          [input.appId, target.slice(connectionInstall ? 'connection-install:'.length : 4), connectionInstall],
        )).rows[0]
      : undefined;
    if (target.startsWith('app:') && !appOwner)
      throw new Error('Connected app grant requires an active app');
    if (connectionInstall && input.appId && !appOwner)
      throw new Error('Connection grant requires the matching active app');
    const resourceOwnerId = appOwner?.id ?? context.owner_id;
    const owner = appOwner ? {
      pubkey: appOwner.id, kind: 'human' as const, name: appOwner.name,
      ...(appOwner.handle ? { handle: appOwner.handle } : {}),
      ...(appOwner.avatar ? { avatar: appOwner.avatar } : {}),
    } : {
      pubkey: context.owner_id,
      kind: 'human' as const,
      name: context.owner_name,
      ...(context.owner_handle ? { handle: context.owner_handle } : {}),
      ...(context.owner_avatar ? { avatar: context.owner_avatar } : {}),
    };
    const agent = {
      pubkey: agentId,
      kind: 'agent' as const,
      name: context.agent_name,
      ...(context.agent_handle ? { handle: context.agent_handle } : {}),
      ...(context.agent_avatar ? { avatar: context.agent_avatar } : {}),
    };
    const requester = {
      pubkey: requesterRow.id,
      kind: requesterRow.kind,
      name: requesterRow.name,
      ...(requesterRow.handle ? { handle: requesterRow.handle } : {}),
      ...(requesterRow.avatar ? { avatar: requesterRow.avatar } : {}),
    };
    const grantId = randomUUID();
    // These grants describe resources on the executing agent's owner machine.
    // The person who started the turn is provenance, not the resource owner.
    // Wallet consent and the two command hard stops keep their existing gates.
    const auto =
      !requireOwnerApproval &&
      kind !== 'shared_asset' &&
      !(kind === 'host' && target === HOST_EMULATOR_TARGET) &&
      escalations.length === 0 &&
      (kind === 'mcp' && (target.startsWith('app:') || connectionInstall)
        ? context.owner_id === resourceOwnerId
        : kind === 'mcp' && target === 'wallet'
        ? context.yolo_mode && requesterRow.id === context.owner_id
        : true);
    const status = auto ? 'approved' : 'pending';
    const result = await ctx.database.transaction(async (database) => {
      // A retry replaces only an undecided ask for this exact command and
      // target. Preserve its status and approval history; supersession is not
      // approval or revocation. The outer command transaction serializes asks.
      const superseded = !auto && kind === 'command' && ctx.authorizedCommand
        ? await database.query<{ id: string }>(
          `UPDATE agent_grants SET superseded_at=now()
           WHERE command_id=$1 AND agent_id=$2 AND room_id=$3 AND requested_by=$4
             AND kind='command' AND target=$5 AND status='pending' AND superseded_at IS NULL
           RETURNING id`,
          [ctx.authorizedCommand.id, agentId, input.roomId, requester.pubkey, target],
        ) : { rows: [] };
      const inserted = await database.query<{ created_at: Date; expires_at: Date | null }>(
        `INSERT INTO agent_grants(
           id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,
           decided_at,expires_at,auto,script,app_id,purpose,touches,capabilities
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
           CASE WHEN $10::boolean THEN now() END,
           CASE WHEN $11::integer IS NULL THEN NULL ELSE now()+make_interval(secs=>$11::integer) END,
           $10,$12::jsonb,$13::uuid,$14,$15,$16)
         RETURNING created_at,expires_at`,
        [
          grantId,
          agentId,
          context.workspace_id,
          kind,
          target,
          reason,
          requester.pubkey,
          input.roomId,
          status,
          auto,
          input.ttlSeconds ?? null,
          script ? JSON.stringify(script) : null,
          appOwner ? input.appId : null,
          input.purpose.trim(),
          input.touches?.trim() ?? null,
          input.capabilities?.trim() ?? null,
        ],
      );
      const row = inserted.rows[0]!;
      const grantView = {
        grantId,
        kind,
        target,
        ...(connectionInstall && appOwner ? { appName: appOwner.display_name } : {}),
        reason,
        purpose: input.purpose.trim(),
        ...(input.touches ? { touches: input.touches.trim() } : {}),
        ...(input.capabilities ? { capabilities: input.capabilities.trim() } : {}),
        ...(context.machine_name ? { machine: context.machine_name } : {}),
        status,
        requestedBy: requester,
        roomId: input.roomId,
        createdAt: seconds(row.created_at),
        ...(row.expires_at ? { expiresAt: seconds(row.expires_at) } : {}),
        auto,
        ...(script ? { script } : {}),
      };
      const member = await database.query(
        `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
         AND identity_id=$2 AND removed_at IS NULL`,
        [context.workspace_id, resourceOwnerId],
      );
      if (!member.rowCount) throw new Error('resource owner access denied');
      const resourceRoomId = kind === 'shared_asset'
        ? input.roomId
        : await ensureSystemDirectMessageRoom(database, context.workspace_id, resourceOwnerId);
      if (auto) {
        return { messageId: undefined, cardRoomId: resourceRoomId };
      }
      const dmRoomId = resourceRoomId;
      const supersededIds = superseded.rows.map(row => row.id);
      let replacementCards: { id: string; card: { grants: (typeof grantView)[] } }[] = [];
      if (supersededIds.length) {
        const cards = await database.query<{ id: string; card: { grants: (typeof grantView)[] } }>(
          `SELECT id,card FROM messages WHERE room_id=$1 AND card_type='grant-request'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(card->'grants') entry
             WHERE entry->>'grantId'=ANY($2::text[]))
           ORDER BY created_at DESC,id DESC FOR UPDATE`, [dmRoomId, supersededIds],
        );
        replacementCards = cards.rows;
      }
      const open = replacementCards.length || kind === 'shared_asset' ? undefined : (
        await database.query<{ id: string; card: { grants: (typeof grantView)[] } }>(
          `SELECT id,card FROM messages WHERE room_id=$1 AND card_type='grant-request'
           AND card->'agent'->>'pubkey'=$2 AND card->>'sourceRoomId'=$3
           AND card->'requester'->>'pubkey'=$4 AND created_at>now()-interval '2 minutes'
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(card->'grants') entry
             JOIN agent_grants g ON g.id=(entry->>'grantId')::uuid WHERE g.status<>'pending')
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(card->'grants') entry
             WHERE entry->>'kind'='shared_asset')
           ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
          [dmRoomId, agentId, input.roomId, requester.pubkey],
        )
      ).rows[0];
      const cardsToUpdate = replacementCards.length ? replacementCards : open ? [open] : [];
      for (const open of cardsToUpdate) {
        const grants = [...open.card.grants.filter(entry => !supersededIds.includes(entry.grantId)), grantView];
        await restateSystemLine(database, open.id, grantCardPhrase(requester, agent, grants), {
          agent,
          owner,
          requester,
          grants,
          ...source,
        });
      }
      if (cardsToUpdate.length) return { messageId: cardsToUpdate[0]!.id, cardRoomId: dmRoomId };
      const messageId = id();
      await systemLine(database, {
        id: messageId,
        roomId: dmRoomId,
        authorId: squireRoute ? SYSTEM_IDENTITY_ID : agentId,
        ...grantCardPhrase(requester, agent, [grantView]),
        presentation: 'card',
        cardType: 'grant-request',
        card: {
          agent,
          owner,
          requester,
          grants: [grantView],
          ...source,
        },
      });
      // A manager sees the Room card only if they are a member of this Room.
      // Mirror it to each other authorized person's @system DM, preserving
      // Room membership as the read boundary while giving every decider a card.
      const additionalCardRoomIds: string[] = [];
      if (kind === 'shared_asset') {
        const absentDeciders = await database.query<{ identity_id: string }>(
          `SELECT member.identity_id FROM memberships member
           WHERE member.workspace_id=$1 AND member.room_id IS NULL
             AND member.removed_at IS NULL
             AND (member.role IN ('owner','admin') OR member.identity_id=$2)
             AND NOT EXISTS (SELECT 1 FROM memberships room_member
               WHERE room_member.room_id=$3 AND room_member.identity_id=member.identity_id
                 AND room_member.removed_at IS NULL)`,
          [context.workspace_id, context.owner_id, input.roomId],
        );
        for (const decider of absentDeciders.rows) {
          const cardRoomId = await ensureSystemDirectMessageRoom(database, context.workspace_id, decider.identity_id);
          additionalCardRoomIds.push(cardRoomId);
          await systemLine(database, {
            roomId: cardRoomId,
            authorId: agentId,
            ...grantCardPhrase(requester, agent, [grantView]),
            presentation: 'card',
            cardType: 'grant-request',
            card: { agent, owner, requester, grants: [grantView], ...source },
          });
        }
      }
      return { messageId, cardRoomId: dmRoomId, additionalCardRoomIds };
    });
    ctx.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'grant', agentId });
    if (result.cardRoomId)
      ctx.live.publish({ type: 'invalidate', roomId: result.cardRoomId, reason: 'grant' });
    if ('additionalCardRoomIds' in result && result.additionalCardRoomIds)
      for (const roomId of result.additionalCardRoomIds)
        ctx.live.publish({ type: 'invalidate', roomId, reason: 'grant' });
    return {
      grantId,
      status,
      auto,
      ...(result.messageId ? { messageId: result.messageId } : {}),
      ...(!auto
        ? {
            approval: {
              destination: squireRoute
                ? ('trusty-squire-dm' as const)
                : kind === 'shared_asset'
                  ? ('room' as const)
                : kind === 'mcp' && target === 'wallet'
                  ? ('wallet-dm' as const)
                  : ('system-dm' as const),
              authority: kind === 'shared_asset'
                ? ('workspace-manager-or-agent-owner' as const)
                : ('resource-owner' as const),
            },
          }
        : {}),
      ...(escalations.length ? { escalations } : {}),
    };
  }


  export async function daemonAskRoomChoice(ctx: DaemonContext, input: Input<'askRoomChoice'>, agentId: string) {
    const posted = await daemonWriteRoomChoice(ctx, {
      roomId: input.roomId,
      agentId,
      mode: 'question',
      ask: input.ask === undefined ? undefined : normalizeAgentAsk(input.ask),
      prompt: input.prompt,
      constraint: input.constraint,
      options: input.options,
      ttlSeconds: input.ttlSeconds,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    ctx.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'choice', agentId });
    return posted;
  }


  export async function daemonOpenRoomPoll(ctx: DaemonContext, input: Input<'openRoomPoll'>, agentId: string) {
    const posted = await daemonWriteRoomChoice(ctx, {
      roomId: input.roomId,
      agentId,
      mode: 'poll',
      prompt: input.prompt,
      constraint: input.constraint,
      options: input.options,
      ttlSeconds: input.ttlSeconds,
    });
    ctx.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'choice', agentId });
    return posted;
  }


  export async function daemonWriteRoomChoice(ctx: DaemonContext,
    input: Parameters<typeof postRoomChoice>[1],
  ): Promise<Awaited<ReturnType<typeof postRoomChoice>>> {
    if (ctx.commandTransaction) return postRoomChoice(ctx.database, input);
    return ctx.database.transaction((database) => postRoomChoice(database, input));
  }


  /** Every live rule for this agent: approved or once, unexpired, not revoked. */
  export async function daemonListAgentGrants(ctx: DaemonContext, agentId: string, roomId?: string) {
    const rows = await ctx.database.query<{
      id: string;
      workspace_id: string;
      room_id: string;
      kind: AgentGrantKind;
      target: string;
      status: 'approved' | 'once';
      requested_by: string;
      requester_name: string | null;
      expires_at: Date | null;
      script: CommandGrantScript | null;
    }>(
      `SELECT g.id,g.workspace_id,g.room_id,g.kind,g.target,g.status,g.requested_by,
              requester.name requester_name,g.expires_at,g.script
       FROM agent_grants g LEFT JOIN identities requester ON requester.id=g.requested_by
       WHERE g.agent_id=$1 AND g.status IN ('approved','once')
         AND (g.expires_at IS NULL OR g.expires_at>now())
         AND (NOT g.auto OR (g.kind<>'mcp' OR g.target<>'wallet') OR EXISTS (
           SELECT 1 FROM agents a JOIN workspaces w ON w.id=g.workspace_id
           WHERE a.agent_id=g.agent_id AND a.yolo_mode AND w.visibility<>'public'
             AND (g.kind='repository' OR g.requested_by=a.owner_id)
         ))
         AND (g.kind IN ('repository','shared_asset') OR g.auto OR g.decided_by=(
           SELECT owner_id FROM agents WHERE agent_id=g.agent_id
         ) OR (g.app_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM workspace_apps app WHERE app.id=g.app_id
             AND app.state='active' AND g.decided_by=app.owner_identity_id
         )))
         AND NOT (g.kind='host' AND g.target=$3 AND (g.auto OR g.decided_by IS NULL))
         AND ($2::uuid IS NULL OR g.workspace_id=(SELECT workspace_id FROM rooms WHERE id=$2))
       ORDER BY g.created_at DESC,g.id`,
      [agentId, roomId ?? null, HOST_EMULATOR_TARGET],
    );
    return {
      grants: rows.rows.map((row) => ({
        grantId: row.id,
        workspaceId: row.workspace_id,
        roomId: row.room_id,
        kind: row.kind,
        target: row.target,
        status: row.status,
        requestedBy: row.requested_by,
        ...(row.requester_name ? { requestedByName: row.requester_name } : {}),
        ...(row.expires_at ? { expiresAt: seconds(row.expires_at) } : {}),
        ...(isCommandGrantScript(row.script) ? { script: row.script } : {}),
      })),
    };
  }

  /** A 'once' grant is spent by its first run: it stops matching immediately. */
  export async function daemonConsumeAgentGrant(ctx: DaemonContext, input: Input<'consumeAgentGrant'>, agentId: string) {
    if (typeof input.grantId !== 'string' || !input.grantId) throw new Error('grantId is required');
    const spent = await ctx.database.query(
      `UPDATE agent_grants SET expires_at=now()
       WHERE id::text=$1 AND agent_id=$2 AND status='once' AND (expires_at IS NULL OR expires_at>now())`,
      [input.grantId, agentId],
    );
    if (!spent.rowCount) throw new Error('once grant not found');
    return daemonWriteResult(ctx);
  }


  /**
   * The inspect surface behind the agent's `list_grants` tool: every grant this
   * agent raised, pending included, plus its reviewed corner's implementer
   * grants. Superseded requests remain in history, not the actionable list.
   * This never authorizes
   * anything — the run gate keeps its approved-only view.
   */
  export async function daemonListAgentGrantRequests(ctx: DaemonContext, agentId: string, roomId?: string) {
    const rows = await ctx.database.query<{
      id: string;
      agent_id: string;
      workspace_id: string;
      room_id: string;
      kind: AgentGrantKind;
      target: string;
      reason: string;
      status: 'pending' | 'approved' | 'once' | 'denied' | 'revoked';
      auto: boolean;
      requested_by: string;
      requester_name: string | null;
      created_at: Date;
      expires_at: Date | null;
    }>(
      `SELECT g.agent_id,g.id,g.workspace_id,g.room_id,g.kind,g.target,g.reason,g.status,g.auto,
              g.requested_by,requester.name requester_name,g.created_at,g.expires_at
       FROM agent_grants g LEFT JOIN identities requester ON requester.id=g.requested_by
       WHERE (g.agent_id=$1 OR EXISTS (
         SELECT 1 FROM rooms corner JOIN rooms parent ON parent.id=corner.parent_id
         JOIN corner_facts fact ON fact.corner_id=corner.id
         WHERE corner.id=$2 AND g.room_id=corner.id
           AND g.agent_id=${cornerImplementerSql('fact', 'corner')}
           AND ${cornerReviewerSql()}=$1
       )) AND g.superseded_at IS NULL
         AND ((g.status IN ('pending','approved','once') AND (g.expires_at IS NULL OR g.expires_at>now()))
           OR (g.kind='host' AND g.target=$3 AND g.status IN ('denied','revoked')))
         AND ($2::uuid IS NULL OR g.workspace_id=(SELECT workspace_id FROM rooms WHERE id=$2))
       ORDER BY g.created_at DESC,g.id`,
      [agentId, roomId ?? null, HOST_EMULATOR_TARGET],
    );
    return {
      grants: rows.rows.map((row) => ({
        grantId: row.id,
        ...(row.agent_id !== agentId ? { agentId: row.agent_id } : {}),
        workspaceId: row.workspace_id,
        roomId: row.room_id,
        kind: row.kind,
        target: row.target,
        reason: row.reason,
        status: row.status,
        auto: row.auto,
        requestedBy: row.requested_by,
        ...(row.requester_name ? { requestedByName: row.requester_name } : {}),
        createdAt: seconds(row.created_at),
        ...(row.expires_at ? { expiresAt: seconds(row.expires_at) } : {}),
      })),
    };
  }


  export async function daemonRepositoryOnboardingRequester(ctx: DaemonContext, agentId: string, roomId?: string, context?: Record<string, unknown>) {
    const command = ctx.authorizedCommand ?? (roomId && typeof context?.requestId === 'string'
      ? await authorizeCommandOutput(ctx.database, roomId, agentId, context.requestId, context.generationId, false, false)
      : undefined);
    if (command) {
      // Optional setup guidance cannot require personal-resource authority.
      // Verified agent orders answer to the issuing root agent's owner;
      // missing roots never borrow the executing agent's owner.
      const requester = await daemonFindGrantRequester(ctx, command);
      if (!requester) return undefined;
      if (requester.kind === 'human') return requester.id;
    }
    return (await ctx.database.query<{ owner_id: string }>(
      `SELECT owner_id FROM agents WHERE agent_id=$1`, [agentId])).rows[0]?.owner_id;
  }


  /** Root command provenance is the authority even after delegation and resumes. */
  export async function daemonGrantRequester(ctx: DaemonContext, command = ctx.authorizedCommand) {
    const requester = await daemonFindGrantRequester(ctx, command);
    if (!requester) throw new Error('resource requester not found: missing message or unverified command-only root');
    return requester;
  }


  /** Missing provenance omits optional setup; effect gates use grantRequester. */
  export async function daemonFindGrantRequester(ctx: DaemonContext, command = ctx.authorizedCommand) {
    if (!command) throw new Error('resource access requires an active command');
    const requester = (await resourceRequester(ctx.database, command, { includeDeletedMessage: true }))?.requester;
    if (!requester) return undefined;
    // A saved workflow run's turns answer to the run's person, not the wake
    // card's author: a handoff card is written by the agent handing off, and a
    // lease failover card by the system. `workflowRunRequester` returns the
    // person who answered the run's latest gate, else the person it started
    // from, and keeps an agent requester for an agent- or schedule-only run.
    // Each resource gate applies its own owner policy to that provenance.
    // `undefined` means the turn is not a run wake.
    const workflow = await workflowRunRequester(ctx.database, {
      roomId: command.room_id,
      agentId: command.agent_id,
      rootSourceMessageId: command.root_source_message_id,
    });
    if (workflow && workflow.id !== requester.id) {
      const resolved = (
        await ctx.database.query<{
          id: string;
          kind: 'human' | 'agent';
          name: string;
          handle: string | null;
          avatar: string | null;
        }>(
          `SELECT id,kind,name,handle,avatar FROM identities WHERE id=$1`,
          [workflow.id],
        )
      ).rows[0];
      if (resolved) return resolved;
    }
    return requester;
  }


  export async function daemonAuthorizeSquireCall(ctx: DaemonContext, input: Input<'authorizeSquireCall'>, agentId: string) {
    return daemonAuthorizeScopedGrant(ctx, input, agentId, 'mcp', 'squire');
  }


  /** An agent may use its own owner's resources; wallet retains its separate consent gate. */
  export async function daemonAuthorizeScopedGrant(ctx: DaemonContext,
    input: Input<'authorizeSquireCall'> & { readonly consume?: boolean },
    agentId: string,
    kind: 'mcp',
    target: string,
  ) {
    if (
      typeof target !== 'string' ||
      !target.trim() ||
      target.length > AGENT_GRANT_TARGET_MAX_LENGTH
    )
      throw new Error('grant target is invalid');
    target = target.trim();
    const requester = await daemonGrantRequester(ctx);
    const context = (
      await ctx.database.query<{
        owner_id: string;
        yolo_mode: boolean;
        owner_present: boolean;
      }>(
        `SELECT a.owner_id,
       EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=w.id
         AND m.room_id IS NULL AND m.identity_id=a.owner_id AND m.removed_at IS NULL) owner_present,
       (a.yolo_mode AND w.visibility<>'public') yolo_mode
       FROM agents a JOIN identities owner ON owner.id=a.owner_id
       JOIN rooms r ON r.id=$1 JOIN workspaces w ON w.id=r.workspace_id
       WHERE a.agent_id=$2`,
        [input.roomId, agentId],
      )
    ).rows[0];
    if (!context) throw new Error('agent not found');
    if (!context.owner_present) throw new Error('resource owner access denied');
    if (target !== 'wallet') return { allowed: true };
    if (context.yolo_mode && requester.id === context.owner_id) return { allowed: true };
    const listed = await daemonListAgentGrants(ctx, agentId, input.roomId);
    const scopedGrants = listed.grants.filter((g) => g.roomId === input.roomId);
    const grant = scopedGrants.find(
      (g) =>
        g.kind === kind &&
        g.target === target &&
        g.roomId === input.roomId &&
        g.requestedBy === requester.id,
    );
    if (grant) {
      if (grant.status === 'once' && input.consume !== false)
        await daemonConsumeAgentGrant(ctx, { grantId: grant.grantId }, agentId);
      return { allowed: true, grantId: grant.grantId };
    }
    const pending = (
      await ctx.database.query<{ id: string }>(
        `SELECT id FROM agent_grants WHERE agent_id=$1 AND room_id=$2 AND kind=$3 AND target=$4
       AND requested_by=$5 AND status='pending' AND (expires_at IS NULL OR expires_at>now())
       ORDER BY created_at DESC,id DESC LIMIT 1`,
        [agentId, input.roomId, kind, target, requester.id],
      )
    ).rows[0];
    if (pending) return { allowed: false, grantId: pending.id, status: 'pending' as const };
    const asked = await daemonRequestAgentGrant(ctx,
      {
        ...input,
        kind,
        target,
        reason: 'use this resource',
        purpose: `Use ${target} to complete the requested task`,
      },
      agentId,
    );
    return {
      allowed: false,
      grantId: asked.grantId,
      status: asked.status,
      ...(asked.messageId ? { messageId: asked.messageId } : {}),
    };
  }
