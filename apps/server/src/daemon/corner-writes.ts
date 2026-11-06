import { ensureRoomMembership } from '../membership-join.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerObjectiveSql, readCornerObjective } from '../corner-objective.js';
import { deleteCornerBranchBestEffort } from '../corner-branch-cleanup.js';
import { cornerOpeningSql, cornerKindSql, cornerOpenedFromSql, cornerRequestSql } from '../corner-opening.js';
import { cornerOwnerSql } from '../corner-worker.js';
import { setCornerReviewer } from '../corner-reviewer.js';
import { ExpectedRefusalError } from '../command-refusal.js';
import { assertCornerCommandTarget, CommandRefusalError } from '../commander.js';
import { setCornerHold } from '../corner-holds.js';
import { authorizeCommandOutput } from '../agent-command.js';
import { randomUUID } from 'node:crypto';
import { cornerImplementerSql } from '../corner-worker.js';
import { cornerBriefRevisionHash, currentCornerBrief, resolveCornerBriefApproval, resolveCornerBriefAttachments, resolvePendingCornerBriefAttachments, validateCornerBrief } from '../corner-brief.js';
import { cornerTextRefusal, normalizeCornerText, type CornerWatchKind } from '@beeline/api-contract/daemon';
import { type SqlDatabase } from '../database.js';
import { closeCornerPullRequestBestEffort, closeCornerState, lockCornerArchivalAuthority } from '../corner-close.js';
import { advanceCorner, createCornerFacts, lockCornerLifecycle } from '../corner-lifecycle.js';
import { systemLine } from '../system-line.js';
import type { DaemonContext } from './context.js';
import { Input, id } from './values.js';
import { daemonAccess, daemonIdentity } from './access.js';
import { daemonBriefAttachmentRooms } from './corner-reports.js';
import { daemonCheckReviewerAuthors } from './corner-reads.js';
import { daemonReach, daemonWriteResult } from './corner-messages.js';



  export async function daemonCreateCorner(ctx: DaemonContext, input: Input<'createCorner'>, agentId: string) {
    // Validate even an idempotent opening retry; prior creation is not consent.
    if (input.hold === true) await resolveCornerBriefApproval(ctx.database, [],
      { spec: 'Merge hold', approval: { sourceMessageId: input.sourceMessageId ?? '' } }, [],
      undefined, undefined, undefined, { agentId });
    // Objectives are normalized paragraphs; names must already be continuous.
    const refusal =
      cornerTextRefusal('name', input.name) ?? cornerTextRefusal('objective', input.objective);
    if (refusal) throw new Error(refusal);
    const objective = normalizeCornerText(input.objective ?? '');
    const name = input.name ?? '';
    if (input.brief) validateCornerBrief(input.brief);
    const idempotencyKey = input.idempotencyKey ?? input.requestId;
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new Error('invalid corner idempotency key');
    }
    await daemonAccess(ctx, input.roomId, agentId);
    // A turn inside a corner opens its new corner beside it, in the parent
    // Room: corners do not nest. `commandRoomId` is where the turn's command
    // lives; `roomId` is the Room the new corner belongs to.
    const commandRoomId = input.roomId;
    const host = (
      await ctx.database.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM rooms WHERE id=$1`,
        [commandRoomId],
      )
    ).rows[0];
    const targetRoomId = input.targetRoomId ?? host?.parent_id ?? commandRoomId;
    if (host?.parent_id && targetRoomId !== host.parent_id && targetRoomId !== commandRoomId) {
      const opened = await ctx.database.query(
        `WITH RECURSIVE descendants AS (
           SELECT child.id corner_id FROM rooms child WHERE ${cornerOpenedFromSql('child.id')}=$1
           UNION SELECT child.id FROM rooms child JOIN descendants parent
             ON ${cornerOpenedFromSql('child.id')}=parent.corner_id
         ) SELECT 1 FROM descendants WHERE corner_id::text=$2 AND corner_id<>$1 LIMIT 1`,
        [commandRoomId, targetRoomId],
      );
      if (!opened.rowCount)
        throw new CommandRefusalError('Corners must open work in their parent Room. Report to your commander instead.', 403);
    }
    const target = (await ctx.database.query<{ parent_id: string | null }>(`SELECT parent_id FROM rooms WHERE id=$1`, [targetRoomId])).rows[0];
    const roomId = target?.parent_id ?? targetRoomId;
    if (roomId !== commandRoomId) await daemonAccess(ctx, roomId, agentId);
    const parent = (
      await ctx.database.query<{
        workspace_id: string;
        repository_key: string | null;
        repository_resolution: string;
      }>(`SELECT workspace_id,repository_key,repository_resolution FROM rooms WHERE id=$1`, [
        roomId,
      ])
    ).rows[0]!;
    // A corner is repository work exactly when its parent Room has a
    // repository (or the caller names one). A corner in a Room without one
    // works in a scratch workspace and never opens a pull request.
    const repositoryWork =
      Boolean(input.repository) ||
      parent.repository_resolution === 'repository' ||
      Boolean(parent.repository_key);
    if (repositoryWork && !input.brief)
      throw new Error('a brief is required for repository corners');
    let cornerId: string = randomUUID();
    const opener = await daemonIdentity(ctx, agentId);
    await ctx.database.transaction(async (db) => {
      await lockCornerLifecycle(db, cornerId);
      // Opening a corner is idempotent for one confirmed tool call while that
      // corner remains active. Locking the parent closes the read/insert race:
      // a concurrent retry waits, sees the winner, and returns its id without
      // creating another Room, command, or open card.
      await db.query(`SELECT id FROM rooms WHERE id=$1 FOR UPDATE`, [roomId]);
      const existing = (
        await db.query<{
          corner_id: string;
          name: string;
          objective: string;
          owner_agent_id: string;
          reviewer_handle: string | null;
          created_by: string;
          request_id: string;
          repository_key: string | null;
          repository_target_branch: string;
          brief_revision: number | null;
          brief_revision_hash: string | null;
          brief_change: string | null;
          brief_attachments: import('@beeline/api-contract/daemon').CornerBriefAttachment[] | null;
        }>(
          `SELECT child.id::text corner_id,child.name,${cornerObjectiveSql('child')} objective,${cornerOwnerSql('child.id')} owner_agent_id,child.created_by,
                  ${cornerRequestSql('child.id')} request_id,child.repository_key,child.repository_target_branch,
                  (SELECT handle FROM identities WHERE id=fact.reviewer_agent_id) reviewer_handle,
                  initial.revision brief_revision,
                  initial.revision_hash brief_revision_hash,initial.change brief_change,
                  initial.attachments brief_attachments
           FROM rooms child
           JOIN corner_facts fact ON fact.corner_id=child.id
           LEFT JOIN LATERAL (${cornerOpeningSql('child.id')}) opening ON true
           LEFT JOIN corner_brief_revisions initial
             ON initial.corner_id=child.id AND initial.revision=1
           WHERE child.parent_id=$1
             AND COALESCE(opening.private_payload->>'openKey',opening.turn_request_id)=$2
             AND child.archived_at IS NULL
           ORDER BY child.created_at,child.id
           LIMIT 1`,
          [roomId, idempotencyKey],
        )
      ).rows[0];
      let implementerAgentId = agentId;
      if (existing && input.implementer !== undefined) {
        const named = (await db.query<{ id: string }>(
          `SELECT id FROM identities WHERE handle=$1 AND kind='agent'`, [input.implementer],
        )).rows[0];
        implementerAgentId = named?.id ?? '';
      }
      if (existing) {
        const sameAttachments =
          (input.brief?.attachments?.length ?? 0) <= (existing.brief_attachments?.length ?? 0) &&
          (input.brief?.attachments ?? []).every((item, index) => {
            const saved = existing.brief_attachments?.[index];
            return (
              saved?.objectId === item.objectId.toLowerCase() &&
              saved.purpose === item.purpose.trim() &&
              saved.required === item.required
            );
          });
        const sameBrief = input.brief
          ? existing.brief_revision_hash ===
              cornerBriefRevisionHash(input.brief, existing.brief_attachments ?? []) &&
            existing.brief_change === (input.brief.change ?? null) &&
            sameAttachments
          : existing.brief_revision === null;
        if (
          existing.owner_agent_id !== implementerAgentId ||
          existing.created_by !== agentId ||
          existing.reviewer_handle !== (input.reviewer ?? null) ||
          existing.request_id !== input.requestId ||
          existing.name !== name ||
          existing.objective !== objective ||
          existing.repository_key !== (input.repository ?? null) ||
          existing.repository_target_branch !== (input.targetBranch ?? 'main') ||
          !sameBrief
        ) {
          const mismatches = [
            existing.owner_agent_id !== implementerAgentId && 'implementer',
            existing.created_by !== agentId && 'opener',
            existing.request_id !== input.requestId && 'request',
            existing.name !== name && 'name',
            existing.objective !== objective && 'objective',
            existing.repository_key !== (input.repository ?? null) && 'repository',
            existing.repository_target_branch !== (input.targetBranch ?? 'main') && 'target branch',
            !sameBrief && 'brief',
          ].filter(Boolean);
          throw new Error(
            `corner assignment conflict: idempotency key was already used for a different assignment (${mismatches.join(', ')})`,
          );
        }
        cornerId = existing.corner_id;
        return;
      }
      if (input.implementer !== undefined) {
        const implementer = (
          await db.query<{ id: string; kind: string }>(
            `SELECT identity.id,identity.kind FROM memberships member
             JOIN identities identity ON identity.id=member.identity_id
             WHERE member.room_id=$1 AND member.removed_at IS NULL AND identity.handle=$2
             FOR SHARE OF member,identity`,
            [roomId, input.implementer],
          )
        ).rows[0];
        if (!implementer) throw new ExpectedRefusalError('implementer must be a current member of the parent Room');
        if (implementer.kind !== 'agent') throw new Error('implementer must be an agent');
        implementerAgentId = implementer.id;
      }
      const parentCommand = await authorizeCommandOutput(
        db,
        commandRoomId,
        agentId,
        input.requestId,
        input.generationId,
      );
      const commissionedBy = (
        await db.query<{ author_id: string }>(
          `SELECT message.author_id FROM messages message
           JOIN identities requester ON requester.id=message.author_id AND requester.kind='human'
           WHERE message.id=$1`,
          [parentCommand.root_source_message_id],
        )
      ).rows[0]?.author_id;
      await db.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,repository_key,repository_target_branch) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          cornerId,
          parent.workspace_id,
          roomId,
          agentId,
          name,
          input.repository ?? null,
          input.targetBranch ?? 'main',
        ],
      );
      await createCornerFacts(db, cornerId);
      if (input.hold === true) {
        await setCornerHold(db, { cornerId, sourceMessageId: input.sourceMessageId }, commissionedBy ?? agentId, agentId);
      }
      if (input.brief) {
        const sourceRoomIds = [...new Set([roomId, commandRoomId])];
        const explicitAttachments = await resolveCornerBriefAttachments(
          db,
          input.brief.attachments?.length
            ? await daemonBriefAttachmentRooms(ctx, db, sourceRoomIds, cornerId, agentId, parentCommand)
            : sourceRoomIds,
          input.brief,
          { roomId: commandRoomId, agentId, requestId: input.requestId, generationId: input.generationId },
        );
        const attachments = [
          ...explicitAttachments,
          ...(await resolvePendingCornerBriefAttachments(db, {
            roomId: commandRoomId,
            agentId,
            requestId: input.requestId,
            generationId: input.generationId,
            excluding: explicitAttachments.map((attachment) => attachment.objectId),
          })),
        ];
        if (attachments.length > 16) throw new Error('corner brief has too many attachments');
        const authority = await resolveCornerBriefApproval(
          db,
          sourceRoomIds,
          input.brief,
          attachments,
          parentCommand.private_payload ? parentCommand.id : parentCommand.root_source_message_id,
          undefined,
          { agentId, roomId },
        );
        await db.query(
          `INSERT INTO corner_brief_revisions(
             corner_id,revision,spec,approval_basis,revision_hash,change,author_id,
             source_room_id,source_message_id,attachments,objective
           ) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            cornerId,
            input.brief.spec.trim(),
            JSON.stringify(authority.approvalBasis),
            authority.revisionHash,
            input.brief.change ?? null,
            agentId,
            authority.sourceRoomId,
            input.brief.approval?.sourceMessageId,
            JSON.stringify(attachments),
            objective,
          ],
        );
      }
      await advanceCorner(db, cornerId, {
        kind: 'open',
        command: {
        roomId: cornerId,
        agentId: implementerAgentId,
        sourceMessageId: null,
        privatePayload: { objective, text: input.brief?.spec ?? objective, authorId: agentId, fromRoomId: commandRoomId, kind: 'order', openKey: idempotencyKey },
        reason: 'corner_objective',
        parent: parentCommand,
        retainDepth: true,
        turnRequestId: input.requestId,
      },
      });
      // After the opening order: the reviewer must be independent of the agent it assigns.
      if (input.reviewer !== undefined) await setCornerReviewer(db, cornerId, input.reviewer, agentId,
        (id, reviewer) => daemonCheckReviewerAuthors(ctx, db, id, reviewer));
      // Opening watches lifecycle events where the commander opened the corner.
      await db.query(
          `INSERT INTO corner_watches(watcher_room_id,agent_id,corner_id,kinds,incoming_command_id) VALUES($1,$2,$3,'["opened","merged"]'::jsonb,$4)
           ON CONFLICT(watcher_room_id,agent_id,corner_id) DO NOTHING`,
          [commandRoomId, agentId, cornerId, parentCommand.id],
        );
      // Only a real message in the command's transcript is a call site. Private
      // orders/reports have no message row; automatic wakes must not borrow a root.
      const source = (
        await db.query<{ id: string }>(
          `SELECT id FROM messages WHERE id=$1 AND room_id=$2
             AND presentation='message' AND system_event IS NULL AND deleted_at IS NULL`,
          [parentCommand.source_message_id, commandRoomId],
        )
      ).rows[0];
      // Only the message that requested the corner gets an opening line.
      const destinations = source ? [{ roomId: commandRoomId, sourceMessageId: source.id }] : [];
      for (const destination of destinations) {
        await systemLine(db, {
          roomId: destination.roomId,
          subject: { kind: 'agent', id: agentId, name: opener.name },
          verb: systemMessage("daemon-service.opened-a-corner"),
          kind: destination.roomId === roomId ? 'corner-opened' : undefined,
          object: { text: name, id: cornerId },
          presentation: 'card',
          cardType: 'daemon-fact',
          card: { type: 'corner-open', cornerId, name,
            objective: destination.roomId === roomId ? name : objective,
            ...(destination.sourceMessageId ? { sourceMessageId: destination.sourceMessageId } : {}) },
          afterMessageId: destination.sourceMessageId,
        });
      }


    });
    const watch = (
      await ctx.database.query<{ kinds: CornerWatchKind[] }>(
        `SELECT kinds FROM corner_watches WHERE watcher_room_id=$1 AND agent_id=$2 AND corner_id=$3`,
        [commandRoomId, agentId, cornerId],
      )
    ).rows[0];
    const warnings = input.brief ? validateCornerBrief(input.brief, repositoryWork) : [];
    return { cornerId, ...(warnings.length ? { warnings } : {}), ...(watch ? { watch: { roomId: commandRoomId, kinds: watch.kinds } } : {}) };
  }

  export async function daemonReviseCornerBrief(ctx: DaemonContext, input: Input<'reviseCornerBrief'>, agentId: string) {
    let draft = input.brief;
    if (!draft.change?.trim())
      throw new CommandRefusalError('corner brief revision requires a change description', 400);
    const brief = await ctx.database.transaction(async (db) => {
      await lockCornerLifecycle(db, input.cornerId);
      const corner = (
        await db.query<{
          parent_id: string;
          repository_backed: boolean;
          owner_agent_id: string | null;
          implementer_agent_id: string | null;
          kind: string;
          created_by: string;
        }>(
          `SELECT room.parent_id,${cornerOwnerSql('room.id')} owner_agent_id,${cornerImplementerSql('fact', 'room')} implementer_agent_id,
             ${cornerKindSql('room.id')} kind,room.created_by,EXISTS(SELECT 1 FROM rooms parent WHERE parent.id=room.parent_id
               AND (parent.repository_resolution='repository' OR parent.repository_key IS NOT NULL)) repository_backed FROM rooms room
         JOIN corner_facts fact ON fact.corner_id=room.id
         WHERE room.id=$1 AND room.archived_at IS NULL FOR UPDATE OF room`,
          [input.cornerId],
        )
      ).rows[0];
      // The commander approves directly; other reachable agents need a cited approval.
      if (!corner?.parent_id) throw new CommandRefusalError('corner brief revision denied', 403);
      await daemonReach(ctx, input.cornerId, agentId, db).catch(() => {
        throw new CommandRefusalError('corner brief revision denied', 403);
      });
      // Read projections of commander-direct approvals have no message citation.
      // Only normalize that projection against the locked, server-owned approval.
      if (draft.approval && (draft.approval.sourceMessageId === '' ||
          draft.approval.sourceMessageId === undefined)) {
        const stored = (await db.query<{ approval_basis: { kind?: string; approvedBy?: string } }>(
          `SELECT approval_basis FROM corner_brief_revisions
           WHERE corner_id=$1 ORDER BY revision DESC LIMIT 1`, [input.cornerId],
        )).rows[0]?.approval_basis;
        if (corner.created_by !== agentId || stored?.kind !== 'commander-direct' ||
            stored.approvedBy !== agentId)
          throw new CommandRefusalError('brief.approval.sourceMessageId is required; cite the approving human message or active private commander order ID', 403);
        draft = { ...draft, approval: undefined };
      }
      validateCornerBrief(draft);
      const commandRoomId = input.roomId ?? input.cornerId;
      const command = await authorizeCommandOutput(
        db, commandRoomId, agentId, input.requestId, input.generationId,
      );
      await assertCornerCommandTarget(db, command.room_id, input.cornerId);
      const current = await currentCornerBrief(db, input.cornerId);
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new CommandRefusalError('corner brief revision changed; read the current assignment', 409);
      const opening = (
        await db.query<{ source_room_id: string }>(
          `SELECT first.source_room_id FROM (
             SELECT source_room_id FROM corner_brief_revisions
             WHERE corner_id=$1 ORDER BY revision ASC LIMIT 1
           ) first JOIN memberships member ON member.room_id=first.source_room_id
           WHERE member.identity_id=$2 AND member.removed_at IS NULL`,
          [input.cornerId, agentId],
        )
      ).rows[0];
      const sourceRoomIds = [corner.parent_id, input.cornerId, commandRoomId];
      if (opening && !sourceRoomIds.includes(opening.source_room_id))
        sourceRoomIds.push(opening.source_room_id);
      const explicitAttachments = await resolveCornerBriefAttachments(
        db,
        draft.attachments?.length
          ? await daemonBriefAttachmentRooms(ctx, db, sourceRoomIds, input.cornerId, agentId, command)
          : sourceRoomIds,
        draft,
        { roomId: commandRoomId, agentId, requestId: input.requestId, generationId: input.generationId },
      );
      const attachments = [
        ...explicitAttachments,
        ...(await resolvePendingCornerBriefAttachments(db, {
          roomId: input.cornerId,
          agentId,
          requestId: input.requestId,
          generationId: input.generationId,
          excluding: explicitAttachments.map((attachment) => attachment.objectId),
        })),
      ];
      if (attachments.length > 16) throw new CommandRefusalError('corner brief has too many attachments', 400);
      const authority = await resolveCornerBriefApproval(
        db,
        sourceRoomIds,
        draft,
        attachments,
        command.private_payload ? command.id : command.root_source_message_id,
        { cornerId: input.cornerId, agentId, command },
      );
      if (input.reviewer !== undefined) await setCornerReviewer(db, input.cornerId, input.reviewer, agentId,
        (id, reviewer) => daemonCheckReviewerAuthors(ctx, db, id, reviewer));
      const revision = input.expectedRevision + 1;
      await db.query(
        `INSERT INTO corner_brief_revisions(
           corner_id,revision,spec,approval_basis,revision_hash,change,author_id,
           source_room_id,source_message_id,attachments,objective
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          input.cornerId,
          revision,
          draft.spec.trim(),
          JSON.stringify(authority.approvalBasis),
          authority.revisionHash,
          draft.change?.trim() ?? null,
          agentId,
          authority.sourceRoomId,
          draft.approval?.sourceMessageId,
          JSON.stringify(attachments),
          await readCornerObjective(db, input.cornerId),
        ],
      );
      // The revision and worker wake commit together. A green reviewer will
      // read the latest revision at verdict time, so its old verdict cannot pass.
      const note = await systemLine(db, {
        roomId: input.cornerId,
        subject: { kind: 'agent', id: agentId, name: (await daemonIdentity(ctx, agentId)).name },
        verb: systemMessage("daemon-service.revised-the-corner-brief"),
        object: { text: systemMessage("daemon-service.revision", revision), id: input.cornerId },
      });
      const outcome = await advanceCorner(db, input.cornerId, {
        kind: 'brief-revised',
        revision,
        sourceMessageId: note.id,
        command,
      });
      const warnings = validateCornerBrief(draft, corner.repository_backed);
      return { ...(await currentCornerBrief(db, input.cornerId))!, ...(warnings.length ? { warnings } : {}), wake: outcome.wake ?? {
        queued: false, reason: 'No lifecycle wake queued',
      } };
    });
    return brief!;
  }

  export async function daemonArchiveCorner(ctx: DaemonContext, input: Input<'archiveCorner'>, agentId: string) {
    const { cornerId } = input;
    const authorize = async (database: SqlDatabase) => {
      await lockCornerLifecycle(database, cornerId);
      await lockCornerArchivalAuthority(database);
      // Closing is lifecycle cleanup, not command output. A completed turn or
      // an unrelated source place cannot revoke current parent Room access.
      await daemonReach(ctx, cornerId, agentId, database);
      if ((await database.query(
        `SELECT 1 FROM corner_facts WHERE corner_id=$1 AND locked`, [cornerId],
      )).rowCount) {
        throw new CommandRefusalError('This corner is locked. A person must unlock it before agents can close it.', 409);
      }
    };
    await ctx.database.transaction(authorize);
    await closeCornerPullRequestBestEffort(ctx.database, cornerId, ctx.closePullRequest);
    const closed = await ctx.database.transaction(async database => {
      await authorize(database);
      return closeCornerState(database, cornerId);
    });
    if (closed.archived) await deleteCornerBranchBestEffort(cornerId, ctx.github ? id => ctx.github!.deleteCornerBranch(id) : undefined);
    return daemonWriteResult(ctx);
  }

  export async function daemonEnsureMembership(ctx: DaemonContext, input: Input<'ensureAgentMembership'>, agentId: string) {
    const room = (
      await ctx.database.query<{ workspace_id: string; parent_id: string | null }>(
        `SELECT workspace_id,parent_id FROM rooms WHERE id=$1`,
        [input.roomId],
      )
    ).rows[0];
    if (!room) throw new Error('room not found');
    if (room.parent_id) {
      await daemonAccess(ctx, input.roomId, agentId);
      return daemonWriteResult(ctx);
    }
    const workspaceMember = await ctx.database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [room.workspace_id, agentId],
    );
    if (!workspaceMember.rowCount) throw new Error('daemon workspace access denied');
    await ensureRoomMembership(ctx.database, [room.workspace_id, input.roomId, agentId]);
    return daemonWriteResult(ctx);
  }
