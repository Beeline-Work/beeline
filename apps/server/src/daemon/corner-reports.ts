import { endAgentTurn } from '../agent-turn-end.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerObjectiveSql, writeCornerObjective } from '../corner-objective.js';
import { cornerKindSql } from '../corner-opening.js';
import { cornerRunStateSql } from '../corner-run.js';
import { setCornerReviewer } from '../corner-reviewer.js';
import { reportToCommander, CommandRefusalError } from '../commander.js';
import { authorizeCommandOutput, type CommandRow } from '../agent-command.js';
import { createHash } from 'node:crypto';
import { cornerImplementerSql } from '../corner-worker.js';
import { currentCornerBrief, resolveCornerBriefApproval, resolveCornerBriefAttachments, resolvePendingCornerBriefAttachments, validateCornerBrief } from '../corner-brief.js';
import { cornerTextRefusal, normalizeCornerText } from '@beeline/api-contract/daemon';
import { type SqlDatabase } from '../database.js';
import { writeCornerTitle } from '../corner-title.js';
import { lockCornerLifecycle } from '../corner-lifecycle.js';
import { systemLine, wakeLateCornerWatcher } from '../system-line.js';
import { mediaIdFromUrl } from '../media-ttl.js';
import { AUTHORIZED_ROOMS_CTE } from '../institutional-history.js';
import { cornerLifecycleSql, recordHelperRemoteState } from '../corner-github-cache.js';
import type { DaemonContext } from './context.js';
import { id, Input, Output } from './values.js';
import { daemonWriteResult, daemonReach } from './corner-messages.js';
import { daemonAccess, daemonIdentity } from './access.js';
import { daemonCheckReviewerAuthors } from './corner-reads.js';


  export async function daemonReport(ctx: DaemonContext, text: string, agentId: string, command = ctx.authorizedCommand!, database = ctx.database, automatic = false, status?: unknown, ask?: string, to?: unknown) {
    let reportCommand = command;
    let directRecipient: string | undefined;
    if (to !== undefined) {
      const target = typeof to === 'string' ? to.replace(/^@/, '') : '';
      const recipient = (await database.query<{ id: string }>(
        `SELECT identity.id FROM room_access member JOIN identities identity ON identity.id=member.identity_id
         WHERE member.room_id=$1 AND member.removed_at IS NULL AND (identity.id=$2 OR identity.handle=$2)`,
        [command.room_id, target],
      )).rows[0];
      if (!recipient) throw new CommandRefusalError('report to must name a current member handle or id', 400);
      const selected = (await database.query<CommandRow>(
        `SELECT directed.* FROM agent_commands directed
         LEFT JOIN messages source ON source.id=directed.source_message_id
         LEFT JOIN identities author ON author.id=source.author_id
         WHERE directed.room_id=$1 AND directed.agent_id=$2 AND (
           (directed.private_payload->>'kind'='order' AND directed.private_payload->>'authorId'=$3)
           OR (directed.private_payload IS NULL AND source.author_id=$3 AND author.kind='human'
             AND source.system_event IS NULL AND source.presentation='message'))
         ORDER BY directed.created_at DESC,directed.id DESC LIMIT 1`, [command.room_id, agentId, recipient.id],
      )).rows[0];
      // The named recipient selects its latest recorded return route.
      if (selected) reportCommand = selected;
      else directRecipient = recipient.id;
    }
    if (!automatic) {
      text = text.replace(/^(?:done|blocked|failed|needs[-_]decision):\s*/, '');
      if (!['done', 'blocked', 'failed', 'needs_decision'].includes(String(status)) || !text.trim())
        throw new CommandRefusalError('report requires status done, blocked, failed, or needs_decision and nonempty text', 400);
      text = `${String(status).replace('_', '-')}: ${text}`;
    }
    const prefix = text.match(/^(done|blocked|failed|needs[-_]decision):\s*\S/)?.[1]?.replace('_', '-');
    // Keep automatic reports' established prefix without inventing a status.
    text = text.replace(/^needs_decision:/, 'needs-decision:');
    if (prefix === 'done') {
      const corner = (await database.query<{ worker: string; merged: boolean; has_pr: boolean }>(
        `SELECT ${cornerImplementerSql('fact', 'room')} worker,
          ${cornerLifecycleSql('fact.corner_id')}->'pr'->>'number' IS NOT NULL has_pr,
          ${cornerLifecycleSql('fact.corner_id')}->'pr'->>'mergeCommitSha' IS NOT NULL merged
         FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id WHERE room.id=$1`,
        [command.room_id])).rows[0];
      if (corner?.worker === agentId && !corner.merged) {
        const brief = await currentCornerBrief(database, command.room_id);
        if (brief?.repositoryWork !== false) {
          if (!corner.has_pr) throw new CommandRefusalError(
            'done requires an opened or merged PR; post progress in the corner instead (non-PR deliverables require repositoryWork false)', 409);
        }
      }
    }

    const pending = (await database.query<{ id: string; url: string; name: string; mime_type: string; size: number }>(
      `WITH RECURSIVE chain AS (
         SELECT * FROM agent_commands WHERE id=$1
         UNION ALL SELECT parent.* FROM agent_commands parent JOIN chain child ON parent.id=child.parent_command_id
       ) SELECT attachment.id,attachment.url,attachment.name,attachment.mime_type,attachment.size::integer size
       FROM agent_pending_attachments attachment WHERE attachment.room_id=$2 AND attachment.agent_id=$3
         AND attachment.request_id IN (SELECT turn_request_id FROM chain WHERE room_id=$2 AND agent_id=$3)
       ORDER BY attachment.created_at,attachment.id`, [command.id, command.room_id, agentId],
    )).rows;
    // Explicit report already delivered this generation; final prose adds nothing
    // unless tools queued more files after that report.
    if (automatic && command.private_payload?.reportedGenerationId === command.generation_id && !pending.length)
      return daemonWriteResult(ctx);
    const attachments = [...(command.private_payload?.attachments ?? []),
      ...pending.map(row => ({ url: row.url, name: row.name, mimeType: row.mime_type, size: row.size }))]
      .filter((row, index, all) => all.findIndex(other => other.url === row.url) === index);
    // Collapse alternate URLs for the same object; content deduplication waits
    // until reportToCommander has selected the recipient.
    const seen = new Set<string>();
    const uniqueAttachments = attachments.filter(attachment => {
      const id = mediaIdFromUrl(attachment.url) ?? '';
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const result = await reportToCommander(database, command.room_id, agentId, text, reportCommand,
      createHash('sha256').update(`report:${command.id}:${command.generation_id}:${reportCommand.id}:${directRecipient ?? ""}:${text}:${ask ?? ""}:${JSON.stringify(uniqueAttachments)}`).digest('hex'), { attachments: uniqueAttachments, automatic, ask, directRecipient });
    if (result.skipped || ('delivered' in result && !result.delivered)) return result;
    for (const attachment of pending) await database.query(
      `DELETE FROM agent_pending_attachments WHERE room_id=$1 AND agent_id=$2 AND id=$3`,
      [command.room_id, agentId, attachment.id]);
    if (command.private_payload) await database.query(
      `UPDATE agent_commands SET private_payload=private_payload ||
        jsonb_build_object('reportedGenerationId',$2::text,'reportedOutcome',$3::text) WHERE id=$1`,
      [command.id, command.generation_id, prefix ?? null]);
    if (prefix && ['done','failed','blocked','needs-decision'].includes(prefix))
      await endAgentTurn(database,command,prefix==='failed'?'failed':'complete');
    return result;
  }

  export async function daemonWatchCorner(ctx: DaemonContext,
    input: Input<'watchCorner'>,
    agentId: string,
  ): Promise<Output<'watchCorner'>> {
    if (
      !Array.isArray(input.kinds) ||
      input.kinds.some((kind) => !['opened', 'merged'].includes(kind))
    )
      throw new CommandRefusalError('watch kinds must be opened or merged', 400);
    const kinds = [...new Set(input.kinds)];
    return ctx.database.transaction(async (db) => {
      const incoming = (await db.query<CommandRow>(`SELECT * FROM agent_commands
        WHERE room_id=$1 AND agent_id=$2 AND action IN ('input','resume')
          AND ($3::text IS NULL OR turn_request_id=$3)
        ORDER BY created_at DESC,id DESC LIMIT 1`, [input.roomId, agentId, input.requestId ?? null])).rows[0];
      const member = await db.query<{ parent_id: string | null }>(
        `SELECT r.parent_id FROM memberships m JOIN rooms r ON m.room_id=COALESCE(r.parent_id,r.id)
         WHERE r.id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL
           AND r.archived_at IS NULL FOR SHARE OF m,r`,
        [input.roomId, agentId],
      );
      if (!member.rowCount) throw new Error('daemon room access denied');
      if (input.cornerId === input.roomId) throw new Error('a corner cannot watch itself');
      await daemonReach(ctx, input.cornerId, agentId, db);
      const corner = await db.query<Output<'watchCorner'>['snapshot'] & { archived: boolean; landed: boolean }>(
        `SELECT c.id,c.name,${cornerRunStateSql('c.id')} "workflowState",
           (${cornerLifecycleSql('f.corner_id')}->'pr'->>'number')::int "pullRequestNumber",
           ${cornerLifecycleSql('f.corner_id')}->'pr'->>'url' "pullRequestUrl",${cornerLifecycleSql('f.corner_id')}->'pr'->>'headSha' "headSha",
           ${cornerLifecycleSql('f.corner_id')}->>'checks' checks,${cornerLifecycleSql('f.corner_id')}->'pr'->>'mergeCommitSha' "mergeCommitSha",
           c.archived_at IS NOT NULL archived,
           COALESCE(${cornerLifecycleSql('f.corner_id')}->>'outcome'='landed' OR ${cornerLifecycleSql('f.corner_id')}->'pr' ? 'mergedAt',false) landed
         FROM rooms c JOIN corner_facts f ON f.corner_id=c.id
         WHERE c.id=$1 AND c.parent_id IS NOT NULL
           FOR SHARE OF c,f`,
        [input.cornerId],
      );
      if (!corner.rowCount)
        throw new Error('watched address must be a corner');
      const { archived, landed, ...snapshot } = corner.rows[0]!;
      // A closed corner has no further events to watch. A merged one returns
      // its merge now: one wake on its merge line, unless this agent already
      // had one for that merge (from a watch or a Room `merged` subscription).
      if (archived) {
        await db.query(`DELETE FROM corner_watches WHERE watcher_room_id=$1 AND agent_id=$2 AND corner_id=$3`, [input.roomId, agentId, input.cornerId]);
        if (!landed) return { kinds: [], state: 'closed', snapshot };
        const woken = kinds.includes('merged')
          ? await wakeLateCornerWatcher(db, input.roomId, agentId, input.cornerId, incoming)
          : false;
        return { kinds: [], state: 'merged', woken, snapshot };
      }
      if (!kinds.length)
        await db.query(
          `DELETE FROM corner_watches WHERE watcher_room_id=$1 AND agent_id=$2 AND corner_id=$3`,
          [input.roomId, agentId, input.cornerId],
        );
      else
        await db.query(
          `INSERT INTO corner_watches(watcher_room_id,agent_id,corner_id,kinds,incoming_command_id) VALUES($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT(watcher_room_id,agent_id,corner_id) DO UPDATE SET kinds=EXCLUDED.kinds,incoming_command_id=EXCLUDED.incoming_command_id,updated_at=now()`,
          [input.roomId, agentId, input.cornerId, JSON.stringify(kinds), incoming?.id ?? null],
        );
      return { kinds, state: 'active', snapshot };
    });
  }

  export async function daemonCornerRemote(ctx: DaemonContext, input: Input<'postCornerRemoteState'>, agentId: string) {
    await daemonAccess(ctx, input.cornerId, agentId);
    // A helper heartbeat never ends a corner: only close and merge archive it.
    // A `gone` remote branch is recorded as an unknown remote state.
    const lifecycle = {
      lifecycle: input.state === 'gone' ? 'unknown' : input.state,
      checks: input.checks,
      ...(input.pullRequest ? { pr: input.pullRequest } : {}),
    };
    await recordHelperRemoteState(ctx.database, input.cornerId, lifecycle);
    return daemonWriteResult(ctx);
  }

  /** Retired plan checklist: older helpers may still post one; only a missing objective is kept. */
  export async function daemonCornerPlan(ctx: DaemonContext, input: Input<'postCornerPlan'>, agentId: string) {
    await daemonAccess(ctx, input.cornerId, agentId);
    // The retired plan checklist is not stored; only a missing objective is filled.
    if (input.objective) await ctx.database.transaction(async db => {
      await lockCornerLifecycle(db, input.cornerId);
      await writeCornerObjective(db, input.cornerId, input.objective!, true);
    });
    return daemonWriteResult(ctx);
  }

  /** Closed-corner evidence follows the same audience checks as message reads.
   * Keep approval-message scope separate from attachment reuse. */
  export async function daemonBriefAttachmentRooms(ctx: DaemonContext,
    db: SqlDatabase,
    sourceRoomIds: readonly string[],
    cornerId: string,
    agentId: string,
    command: CommandRow,
  ): Promise<string[]> {
    const authority = (await db.query<{ workspace_id: string; requester_identity_id: string }>(
      `SELECT output.workspace_id,root.author_id requester_identity_id
       FROM rooms output JOIN messages root ON root.id=$2 AND root.deleted_at IS NULL
       JOIN rooms root_room ON root_room.id=root.room_id AND root_room.workspace_id=output.workspace_id
       WHERE output.id=$1`, [cornerId, command.root_source_message_id],
    )).rows[0];
    if (!authority) return [...sourceRoomIds];
    const archived = await db.query<{ id: string }>(
      `WITH ${AUTHORIZED_ROOMS_CTE}
       SELECT source.id FROM rooms source JOIN authorized_rooms authorized ON authorized.id=source.id
       WHERE source.parent_id IS NOT NULL AND source.archived_at IS NOT NULL`,
      [cornerId, authority.requester_identity_id, authority.workspace_id, agentId],
    );
    return [...new Set([...sourceRoomIds, ...archived.rows.map((room) => room.id)])];
  }

  /** Retitles the corner this agent is working in, through the same write a person's rename uses. */
  export async function daemonRenameCorner(ctx: DaemonContext, input: Input<'renameCorner'>, agentId: string) {
    const refusal = input.name === undefined && input.reviewer !== undefined ? null : cornerTextRefusal('name', input.name);
    if (refusal) throw new Error(refusal);
    let name = input.name;
    const objective = input.objective === undefined ? undefined : normalizeCornerText(input.objective);
    if (input.objective !== undefined) {
      const objectiveRefusal = cornerTextRefusal('objective', input.objective);
      if (objectiveRefusal) throw new Error(objectiveRefusal);
    }
    if (input.brief) validateCornerBrief(input.brief);
    await daemonReach(ctx, input.cornerId, agentId);
    await ctx.database.transaction(async (db) => {
      await lockCornerLifecycle(db, input.cornerId);
      const corner = (
        await db.query<{ parent_id: string | null; archived_at: Date | null; kind: string; objective: string; name: string }>(
          `SELECT room.name,room.parent_id,room.archived_at,${cornerKindSql('room.id')} kind,${cornerObjectiveSql('room')} objective
           FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id
           WHERE room.id=$1 FOR UPDATE OF room`,
          [input.cornerId],
        )
      ).rows[0];
      if (!corner?.parent_id) throw new Error('corner not found');
      if (corner.archived_at) throw new Error('corner is archived');
      name ??= corner.name;
      if (input.reviewer !== undefined) await setCornerReviewer(db, input.cornerId, input.reviewer, agentId,
        (id, reviewer) => daemonCheckReviewerAuthors(ctx, db, id, reviewer));
      const current = corner.kind === 'human'
        ? await currentCornerBrief(db, input.cornerId)
        : null;
      if (corner.kind === 'human' && !current && (!objective || !input.brief))
        throw new Error('naming a human-opened corner requires its objective and first brief');
      if (objective !== undefined || input.brief) {
        if (corner.kind !== 'human' && input.brief)
          throw new Error('corner brief already exists; revise the current brief instead');
        const command = await authorizeCommandOutput(
          db, input.roomId ?? input.cornerId, agentId, input.requestId, input.generationId,
        );
        if (current || corner.kind !== 'human') {
          if (current && input.brief && (current.spec !== input.brief.spec.trim() ||
              current.repositoryWork !== input.brief.repositoryWork ||
              current.approval?.sourceMessageId !== input.brief.approval?.sourceMessageId))
            throw new Error('corner brief already exists; revise the current brief instead');
          // The objective is navigation only, not authority; keep the brief and review fences.
          if (objective !== undefined) await writeCornerObjective(db, input.cornerId, objective);
        } else {
          const sourceRoomIds = [corner.parent_id, input.cornerId, input.roomId ?? input.cornerId];
          const brief = input.brief!;
          const explicitAttachments = await resolveCornerBriefAttachments(
            db, brief.attachments?.length
              ? await daemonBriefAttachmentRooms(ctx, db, sourceRoomIds, input.cornerId, agentId, command)
              : sourceRoomIds, brief,
          );
          const attachments = [
            ...explicitAttachments,
            ...(await resolvePendingCornerBriefAttachments(db, {
              roomId: input.cornerId,
              agentId,
              requestId: input.requestId ?? '',
              generationId: input.generationId,
              excluding: explicitAttachments.map((attachment) => attachment.objectId),
            })),
          ];
          if (attachments.length > 16) throw new Error('corner brief has too many attachments');
          const authority = await resolveCornerBriefApproval(
            db, sourceRoomIds, brief, attachments, command.private_payload ? command.id : command.root_source_message_id,
          );
          await db.query(
            `INSERT INTO corner_brief_revisions(
               corner_id,revision,spec,approval_basis,revision_hash,change,author_id,
               source_room_id,source_message_id,attachments,objective
             ) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [input.cornerId, brief.spec.trim(), JSON.stringify(authority.approvalBasis),
              authority.revisionHash, brief.change ?? null, agentId, authority.sourceRoomId,
              brief.approval?.sourceMessageId, JSON.stringify(attachments), objective ?? corner.objective],
          );
        }
      }
      if (input.name !== undefined) await writeCornerTitle(db, input.cornerId, input.name);
    });
    return { cornerId: input.cornerId, name: name! };
  }

  export async function daemonTargetProposal(ctx: DaemonContext, input: Input<'postTargetBranchProposal'>, agentId: string) {
    await daemonAccess(ctx, input.roomId, agentId);
    if (input.purpose !== undefined && (typeof input.purpose !== 'string' || !input.purpose.trim() || input.purpose.trim().length > 240))
      throw new Error('target branch purpose must be 1–240 characters');
    const messageId = id();
    const agent = await daemonIdentity(ctx, agentId);
    await systemLine(ctx.database, {
      id: messageId,
      roomId: input.roomId,
      subject: { kind: 'agent', id: agentId, name: agent.name },
      verb: systemMessage("daemon-service.proposed-a-target-branch"),
      object: input.to,
      consequence: systemMessage("daemon-service.instead-of", input.from),
      presentation: 'card',
      requestId: input.requestId,
      cardType: 'target-branch',
      card: {
        ...(input.purpose ? { purpose: input.purpose.trim().slice(0, 240) } : {}),
        proposalId: messageId,
        from: input.from,
        to: input.to,
        repository: input.repository,
        agent,
      },
    });
    return { id: messageId, createdAt: Math.floor(Date.now() / 1000) };
  }
