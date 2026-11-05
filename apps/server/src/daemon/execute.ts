import { endAgentTurn } from '../agent-turn-end.js';
import { recordAgentTurnFailure } from '../agent-turn-failure.js';
import { parkOwnedModelTerminal, OwnedModelOwnerEndRefusal } from '../owned-model-parking.js';
import { assertCurrentTurnOwner } from '../turn-ownership.js';
import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';
import { cleanVoiceReply } from '../voice-reply.js';
import { queueDatabaseWork } from '../database-work-queue.js';
import { hasOrderContinuation, CommandRefusalError } from '../commander.js';
import { authorizeCommandOutput, supersededReview, routeAgentResult, type CommandRow } from '../agent-command.js';
import { randomBytes } from 'node:crypto';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { lockCornerLifecycle } from '../corner-lifecycle.js';
import { LiveHub, type LiveEvent } from '../live.js';
import { typedMentionHandles } from '../message-mentions.js';
import { precomputeInstitutionalQueryEmbedding } from '../institutional-memory-shadow.js';
import type { AfterCommit } from '../institutional-memory-embeddings.js';
import type { DaemonContext } from './context.js';
import { Input, OwnedModelClaimCapability, Output, CORNER_REACH_OPERATIONS, AccessDeniedError, CORNER_CLEANUP_OPERATIONS, id, seconds } from './values.js';
import { daemonAccess, daemonReviewSourceAccess } from './access.js';
import { daemonReach, daemonWriteResult } from './corner-messages.js';
import { daemonPostRoomMessage, daemonPersistTurnTrace } from './messages.js';
import { daemonReconcileZeroCheckWorkerCompletion } from './corner-completion.js';
import { DaemonService } from '../daemon-service.js';
import { daemonLockOwnedTurnAccess } from './owned-model.js';
import { daemonReport } from './corner-reports.js';
import { daemonAuthorizeScopedGrant } from './grants.js';
import { daemonExecuteOperation } from './operations.js';



  export async function daemonExecute<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, 
    name: Name,
    input: Input<Name>,
    authenticatedAgentId: string,
    turnOwner?: HelperTurnOwnershipSource,
    modelClaim?: OwnedModelClaimCapability,
  ): Promise<Output<Name>> {
    if (turnOwner && name !== 'claimAgentCommand' && name !== 'claimAgentTurn' && name !== 'postAgentTurnReceipt' && name !== 'acknowledgeAgentCommand' && name !== 'releaseAgentTurn' && name !== 'getAgentCommands')
      throw new Error('Turn ownership operation unavailable');
    if(name==='readCommandActivation')throw new Error('Activation context requires the negotiated machine socket');
    const turnWrites = new Set([
      'postVaultSaveCard',
      'postAgentAvatar',
      'postRoomMessage',
      'postCornerMessage',
      'postAgentAttachment',
      'postAgentDraft',
      'postAgentThought',
      'retractAgentLiveOutput',
      'postAgentTurnReceipt',
      'markAgentTurnSilent',
      'postAgentActivity',
      'postSquireApproval',
      'postComputerSession',
      'postSquireLoginWall',
      'createLinkSpendRequest',
      'retrieveLinkSpendRequest',
      'order',
      'stopAgentTurn',
      'report',
      'createCorner',
      'reviseCornerBrief',
      'postRoomEvent',
      'requestAgentGrant',
      'createAgentSubscription',
      'deleteAgentSubscription',
      'setAgentWakePaused',
      'authorizeSquireCall',
      'authorizeResourceCall',
      'authorizeRepositoryCall',
      'authorizeHostCall',
      'getWalletToolState',
      'getWalletToolBalance',
      'getWalletToolChains',
      'getWalletToolHistory',
      'getWalletToolQuote',
      'walletPay',
      'walletSwap',
      'walletContractCall',
      'walletSignTypedData',

      'listTurnAgentGrants',
      'offerConnector',
      'connectMcpServer',
      'connectApp',
      'connect',
      'listAppTools',
      'executeAppTool',
      'postRepositoryOnboarding',
      'postRoomInvite',
      'postStarterWelcome',
      'postStarterVideoPreview',
      'askRoomChoice',
      'openRoomPoll',
      'renameCorner',
      'getInstitutionalContext',
      'saveInstitutionalMemory',
      'updateInstitutionalMemory',
      'deleteInstitutionalMemory',
      'reportInstitutionalMemoryUsed',
      'searchInstitutionalMemory',
      'searchInstitutionalHistory',
      'getRoomMessage',
      'loadWorkspaceSkill',
      'saveSkill',
      'deleteSkill',
      'saveWorkflow',
      'startWorkflow',
      'cancelWorkflowRun',
      'handoff',
      'archiveWorkflow',
      'assignWorkflowRole',
      'reportFeedback',
      'notifyFeedbackFixed',
      'sendOperatorSystemDm',
      'readOperatorSystemDm',
    ]);
    input = { ...input };
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.agentId === 'string' && candidate.agentId !== authenticatedAgentId)
      throw new Error('daemon token does not own requested agent');
    // Command writes authorize their source before the operation checks its
    // target. Lifecycle and read operations authorize the addressed corner,
    // independently of any source context the helper also supplies.
    const scopedRoom =
      CORNER_REACH_OPERATIONS.has(name) && typeof candidate.cornerId === 'string'
        ? candidate.cornerId
        : typeof candidate.roomId === 'string'
          ? candidate.roomId
          : typeof candidate.cornerId === 'string'
            ? candidate.cornerId
            : undefined;
    const addressedRoom = !turnWrites.has(name) && typeof candidate.cornerId === 'string'
      ? candidate.cornerId : scopedRoom;
    const walletCall = [
      'getWalletToolState',
      'getWalletToolBalance',
      'getWalletToolChains',
      'getWalletToolHistory',
      'getWalletToolQuote',
      'walletPay',
      'walletSwap',
      'walletContractCall',
      'walletSignTypedData',
    ].includes(name);
    if (walletCall && !scopedRoom) throw new Error('wallet access requires an active Room command');
    let cornerReviewer = false;
    let isCorner = false;
    let privateCommand = false;
    let voiceAgentName: string | null | undefined;
    if (addressedRoom && name !== 'ensureAgentMembership' && !ctx.commandTransaction)
      ({ cornerReviewer, isCorner, privateCommand, voiceAgentName } = await daemonAccess(ctx, addressedRoom, authenticatedAgentId, candidate.requestId ?? candidate.turnId).catch(
        (error: unknown) => {
          if (error instanceof AccessDeniedError &&
              (name === 'getRoomConversation' || name === 'getRoomMessage'))
            return daemonReviewSourceAccess(ctx, addressedRoom, authenticatedAgentId).then(() => ({
              cornerReviewer: false, isCorner: false, privateCommand: false, voiceAgentName: null,
            })).catch((sourceError: unknown) => {
              if (sourceError instanceof AccessDeniedError)
                return daemonReach(ctx, addressedRoom, authenticatedAgentId).then(() => ({
                  cornerReviewer: false, isCorner: true, privateCommand: false, voiceAgentName: null,
                }));
              throw sourceError;
            });
          // Reachable corner operations also admit a parent Room member.
          if (error instanceof AccessDeniedError &&
              (CORNER_REACH_OPERATIONS.has(name) || CORNER_CLEANUP_OPERATIONS.has(name)))
            return daemonReach(ctx, addressedRoom, authenticatedAgentId).then(() => ({
              cornerReviewer: false,
              isCorner: true,
              privateCommand: false,
              voiceAgentName: null,
            }));
          throw error;
        },
      ));
    let ownedIntent = Boolean(turnOwner || ctx.authorizedCommand?.turn_owner_connection_id);
    if (!ctx.commandTransaction && scopedRoom && typeof candidate.generationId === 'string' &&
        typeof (candidate.requestId ?? candidate.turnId) === 'string') {
      ownedIntent ||= Boolean((await ctx.database.query(`SELECT 1 FROM agent_commands command
        JOIN agent_command_generation_owners binding ON binding.command_id=command.id
          AND binding.generation_id=$4 AND binding.connection_id IS NOT NULL
        WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3 LIMIT 1`,
        [scopedRoom, authenticatedAgentId, candidate.requestId ?? candidate.turnId, candidate.generationId])).rowCount);
    }
    // An owned claim must not remove existing tools. Operations without a
    // dedicated adapter keep their established provider/permission path while
    // retaining the command's generation and final commit fences below.
    // Provider reads happen before the command transaction. Reports may be
    // delivered in the commander's Room, so refresh their origin corners too.
    if (!ctx.commandTransaction && scopedRoom && ctx.github) {
      if (!ownedIntent && ['getAgentCommands', 'claimAgentCommand'].includes(name)) {
        const origins = await ctx.database.query<{ corner_id: string }>(
          `SELECT DISTINCT COALESCE(review_context->>'cornerId',room_id::text) corner_id
           FROM agent_commands WHERE room_id=$1 AND agent_id=$2
             AND review_context IS NOT NULL AND state IN ('pending','claimed')`,
          [scopedRoom, authenticatedAgentId]);
        for (const origin of origins.rows) await ctx.github.refreshCornerReviewHead?.(origin.corner_id);
      } else if (isCorner && !cornerReviewer && name === 'report' && candidate.status === 'done') {
        await ctx.github.resolveUnregisteredCornerPullRequest(scopedRoom, authenticatedAgentId);
      } else if (isCorner && (['order', 'report', 'postCornerMessage'].includes(name) ||
        name === 'postRoomMessage' && candidate.relay === undefined)) {
        await ctx.github.refreshCornerReviewHead?.(scopedRoom);
      }
    }
    if (voiceAgentName && typeof candidate.text === 'string')
      candidate.text = cleanVoiceReply(candidate.text, voiceAgentName);
    if (name === 'postRoomMessage' && candidate.relay !== undefined)
      throw new CommandRefusalError('relay cards are retired; use order and report', 410);

    if (
      !ctx.commandTransaction &&
      !ownedIntent &&
      scopedRoom &&
      name === 'postRoomMessage' &&
      candidate.relay === undefined &&
      typedMentionHandles(String(candidate.text ?? '')).size === 0 &&
      typeof candidate.replyToMessageId !== 'string' &&
      // A reply naming nobody normally has nothing to route, which is the whole
      // reason for this shorter write: one autocommit statement that commits
      // and publishes on its own. A corner reviewer's reply is the exception —
      // it hands the branch back — and that handoff must not be a second write
      // AFTER the commit. Losing it there is permanent: the verdict is durable,
      // its command output authority is spent, and no retry can re-create the
      // turn, which is exactly the stall this handback exists to remove. So the
      // reviewer takes the transactional path below, where the verdict and the
      // handoff commit together or not at all.
      !cornerReviewer &&
      !privateCommand &&
      // A same-turn post needs the transactional path: insert the ordinary
      // reply, then demote repeated prose before any reader can observe it.
      !(await ctx.database.query(
        `SELECT 1 FROM messages WHERE room_id=$1 AND author_id=$2 AND request_id=$3
           AND presentation='message' AND deleted_at IS NULL
           AND legacy_event->>'turnGenerationId'=$4 LIMIT 1`,
        [scopedRoom, authenticatedAgentId, candidate.requestId, candidate.generationId],
      )).rowCount
    ) {
      const output = await queueDatabaseWork(ctx.database, `turn:${scopedRoom}:${authenticatedAgentId}`, () => daemonPostRoomMessage(ctx, 
        input as Input<'postRoomMessage'>,
        authenticatedAgentId,
        true,
      ));
      if (isCorner)
        await daemonReconcileZeroCheckWorkerCompletion(ctx, scopedRoom!, authenticatedAgentId);
      return output as Output<Name>;
    }
    if (
      !ctx.commandTransaction && scopedRoom && turnWrites.has(name) &&
      (name !== 'getRoomMessage' || candidate.requestId !== undefined)
    ) {
      const writeStartedAt = Date.now();
      const events: LiveEvent[] = [];
      const buffered = new LiveHub();
      buffered.publish = (event) => {
        events.push(event);
      };
      const memoryEmbed = !ctx.institutionalMemoryShadow.live
        ? undefined
        : name === 'getInstitutionalContext'
          ? await precomputeInstitutionalQueryEmbedding(ctx.database, {
              kind: 'context',
              roomId: scopedRoom,
              agentId: authenticatedAgentId,
              requestId: String(candidate.requestId ?? candidate.turnId ?? ''),
            })
          : name === 'searchInstitutionalMemory'
            ? await precomputeInstitutionalQueryEmbedding(ctx.database, {
                kind: 'search',
                query: typeof candidate.query === 'string' ? candidate.query : '',
              })
            : undefined;
      const committedTasks: Parameters<AfterCommit>[0][] = [];
      let appToolExecution: DaemonService['deferredAppTool'];
      const output = await queueDatabaseWork(ctx.database, `turn:${scopedRoom}:${authenticatedAgentId}`, () => ctx.database.transaction(async (db) => {
        const needsLifecycle = name === 'createCorner' || name === 'reviseCornerBrief' ||
          (isCorner && name === 'postAgentTurnReceipt' && candidate.status === 'failed');
        // Closing/account-removal and owner-loss writers already take lifecycle
        // before authority/command rows. Only owned paths that actually need
        // lifecycle take it first; ordinary activity retains independent lanes.
        if (ownedIntent && needsLifecycle) await lockCornerLifecycle(db, scopedRoom);
        if (ownedIntent) await daemonLockOwnedTurnAccess(ctx, db, scopedRoom, authenticatedAgentId);
        if (turnOwner) await assertCurrentTurnOwner(db, authenticatedAgentId, turnOwner);
        // Result publication keeps lifecycle and command locks in the same order as cancellation.
        if (!ownedIntent && needsLifecycle)
          await lockCornerLifecycle(db, scopedRoom);
        const requestId = candidate.requestId ?? candidate.turnId;
        if (name === 'postAgentTurnReceipt' && candidate.modelOwnerEnd !== undefined &&
            (candidate.status !== 'failed' || candidate.heartbeat !== undefined)) throw new OwnedModelOwnerEndRefusal();
        if (name === 'postAgentTurnReceipt' && !candidate.diagnosticsOnly && ['failed', 'complete'].includes(String(candidate.status))) {
          await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
            `turn:${scopedRoom}:${String(requestId)}:${authenticatedAgentId}`,
          ]);
          // Preserve causal provider evidence before the single terminal write.
          if (await parkOwnedModelTerminal(db, input as Input<'postAgentTurnReceipt'>, authenticatedAgentId, turnOwner)) {
            const ended = (await db.query<CommandRow>(`SELECT * FROM agent_commands
              WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND generation_id=$4 FOR UPDATE`,
              [scopedRoom,authenticatedAgentId,requestId,candidate.generationId])).rows[0];
            if (ended && await endAgentTurn(db,ended,'failed','The model result could not be confirmed.'))
              await recordAgentTurnFailure(db,ended,'The model result could not be confirmed.');
            return daemonWriteResult(ctx) as Output<Name>;
          }

        }
        // A stopped generation may upload diagnostics only. It cannot publish,
        // renew its lease, or change the requester's terminal cancellation.
        if (name === 'postAgentTurnReceipt' && candidate.status === 'cancelled' && candidate.trace) {
          const stopped = await db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND request_id=$2
            AND agent_id=$3 AND status='cancelled' AND generation_id=$4`,
            [scopedRoom, requestId, authenticatedAgentId, candidate.generationId]);
          if (stopped.rowCount) {
            await daemonPersistTurnTrace(ctx, db, input as Input<'postAgentTurnReceipt'>, authenticatedAgentId);
            return daemonWriteResult(ctx) as Output<Name>;
          }
        }
        const allowCompleted =
          (name === 'postRoomMessage' && candidate.relay === undefined) ||
          name === 'retractAgentLiveOutput' ||
          (name === 'postAgentTurnReceipt' && ['complete','failed'].includes(String(candidate.status)));
        const command = await authorizeCommandOutput(
          db, scopedRoom, authenticatedAgentId, requestId, candidate.generationId, allowCompleted,
          !['getRoomConversation', 'getRoomMessage', 'getRoomAuthority'].includes(name),
        );
        if (name === 'postAgentTurnReceipt' && command.turn_owner_connection_id) {
          if (!turnOwner || turnOwner.connectionId !== command.turn_owner_connection_id ||
              turnOwner.epoch !== Number(command.turn_owner_epoch))
            throw new Error('Turn receipt requires its negotiated machine owner');
          if (candidate.heartbeat) throw new Error('Owned turns do not accept freshness receipts');
        }
        if (['postRoomMessage', 'postCornerMessage', 'order', 'report'].includes(name) && command.review_context?.purpose !== 'repair' && await supersededReview(db, command)) {
          await endAgentTurn(db, command, 'cancelled', 'superseded_review');
          return { ...daemonWriteResult(ctx), id: command.id, skipped: true } as Output<Name>;
        }
        // Helpers cannot impose an order outcome on an informational wake.
        // The stored command and its delivered receipt own that obligation.
        if (name === 'postAgentTurnReceipt' && candidate.status === 'failed' &&
          String(candidate.reason ?? '').startsWith('unreported_order:') &&
          (command.private_payload?.kind !== 'order' ||
            command.private_payload.reportedGenerationId === command.generation_id ||
            await hasOrderContinuation(db, command))) {
          candidate.status = 'complete';
          delete candidate.reason;
          delete candidate.reasonKind;
        }
        // Silence is a server-owned terminal outcome, including private return
        // routes. Older helpers may still submit final text after the tool.
        if (name === 'postRoomMessage' && (await db.query(
          `SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3
             AND completion_kind='no-reply'`,
          [scopedRoom, authenticatedAgentId, requestId],
        )).rowCount)
          return daemonWriteResult(ctx) as Output<Name>;
        // A corner is the ordered work's own address: its viewers watch the
        // turn's live work and progress there. Urgent terminal prose still
        // reports privately; done uses the explicit guarded report tool.
        if (command.private_payload && ((name === 'postRoomMessage' && (/^(blocked|failed|needs-decision):\s*\S/.test(String(candidate.text ?? '')) || !(await db.query(
          `SELECT 1 FROM corner_facts WHERE corner_id=$1`, [scopedRoom])).rowCount)) || ([
          'postAgentDraft', 'postAgentThought', 'postAgentActivity',
        ].includes(name) && !(await db.query(
          `SELECT 1 FROM corner_facts WHERE corner_id=$1`, [scopedRoom])).rowCount))) {
          // Final prose keeps the private return route without inventing a status.
          if (name === 'postRoomMessage') {
            const text = String(candidate.text ?? '').trim();
            if (text) {
              const report = await daemonReport(ctx, text, authenticatedAgentId, command, db, true);
              if ('delivered' in report && report.delivered === false)
                throw new CommandRefusalError('Report was not delivered; restore commander membership at the recorded return address, then report again.', 409);
            } else throw new CommandRefusalError('An assignment outcome requires nonempty report text.', 400);
            await endAgentTurn(db, command, 'complete');
          }
          return daemonWriteResult(ctx) as Output<Name>;
        }
        if (command.state === 'complete') {
          if (name === 'postRoomMessage' && command.result_message_id) {
            const saved = (
              await db.query<{ id: string; created_at: Date; text: string }>(
                `SELECT id,created_at,text FROM messages WHERE id=$1`,
                [command.result_message_id],
              )
            ).rows[0]!;
            if (saved.text !== candidate.text) throw new Error('command result conflict');
            return {
              id: saved.id,
              createdAt: seconds(saved.created_at),
            } as Output<Name>;
          }
          if (name==='postRoomMessage' && command.private_payload?.reportedGenerationId===command.generation_id)
            return {...daemonWriteResult(ctx),id:command.id} as Output<Name>;
          if (name !== 'retractAgentLiveOutput' && name !== 'postAgentTurnReceipt')
            throw new Error('command already completed');
          // A durable reply completes the command before its terminal receipt.
          // That receipt still owns usage and the institutional review enqueue.
          if (name !== 'postAgentTurnReceipt')
            return daemonWriteResult(ctx) as Output<Name>;
        }
        const scoped = new DaemonService(
          db,
          buffered,
          ctx.roomGitHubToken,
          ctx.mediaMaximumBytes,
          true,
          command,
          ctx.livePaintDiagnostics,
          ctx.liveDiagnosticServerInstance,
          ctx.prChecksStatus,
          undefined,
          ctx.institutionalMemoryShadow,
          ctx.mcpRegistry,
          ctx.registryMcpOAuth,
          ctx.composio,
          ctx.feedback,
          ctx.objects,
          ctx.linkWallet,
          ctx.refreshMergeability,
          ctx.landCorner, ctx.closePullRequest, ctx.readPullRequest, ctx.subscriptionReceiverUrl, ctx.github,
        );
        scoped.starterOnboarding = ctx.starterOnboarding;
        scoped.memoryEmbed = memoryEmbed;
        scoped.afterCommit = (task) => {
          committedTasks.push(task);
        };
        let result: Output<Name> = await scoped.execute(name, input, authenticatedAgentId, turnOwner);
        appToolExecution = scoped.deferredAppTool;
        if (name === 'requestAgentGrant') {
          await db.query(
            `UPDATE agent_grants SET command_id=$2 WHERE id=$1 AND command_id IS NULL`,
            [(result as { grantId: string }).grantId, command.id],
          );
        }
        if (
          [
            'authorizeSquireCall',
            'authorizeResourceCall',
            ...[
              'getWalletToolState',
              'getWalletToolBalance',
              'getWalletToolChains',
              'getWalletToolHistory',
              'getWalletToolQuote',
              'walletPay',
              'walletSwap',
              'walletContractCall',
              'walletSignTypedData',
            ],
          ].includes(name) &&
          ['pending', 'permission-required'].includes(
            (result as { status?: string }).status ?? '',
          ) &&
          (result as { grantId?: string }).grantId
        ) {
          await db.query(
            `UPDATE agent_grants SET command_id=$2 WHERE id=$1 AND command_id IS NULL`,
            [(result as { grantId: string }).grantId, command.id],
          );
        }
        if (name === 'offerConnector' || name === 'postSquireLoginWall') {
          // The accept's (or the reconnect's own) hidden `connector-offer-decided`
          // line resumes THIS command's turn, the way a grant decision resumes
          // its ask. A `postSquireLoginWall` call that produced no card (an
          // `awaiting_human` wall, or no connected connector) has no offerId.
          const offerId = (result as { offerId?: string }).offerId;
          if (offerId)
            await db.query(
              `UPDATE connector_offers SET command_id=$2 WHERE id::text=$1 AND command_id IS NULL`,
              [offerId, command.id],
            );
        }
        if (name === 'postRoomMessage' && candidate.relay === undefined) {
          // routeAgentResult reads the reply's own text for the agents it hands
          // work to, so there is nothing to pre-check here.
          const message = result as unknown as { id: string };
          await routeAgentResult(db, command, message.id);
        }
        return result;
      }));
      for (const task of committedTasks) {
        try {
          await task(ctx.database);
        } catch (error) {
          console.error('[daemon] post-commit task failed', error);
        }
      }
      for (const event of events) {
        if (event.type !== 'invalidate' || !event.committedRow) {
          ctx.live.publish(event);
          continue;
        }
        const emittedAt = Date.now();
        ctx.live.publish({
          ...event,
          trace: {
            id: randomBytes(16).toString('hex'),
            databaseAt: event.committedRow.row.created_at.getTime(),
            emittedAt,
            startedAt: event.committedRow.startedAt ?? writeStartedAt,
          },
        });
      }
      if (name === 'postRoomMessage' && candidate.relay === undefined && isCorner) {
        await daemonReconcileZeroCheckWorkerCompletion(ctx, 
          scopedRoom!,
          authenticatedAgentId,
        );
      }
      // Upload reservation and turn authority commit before bytes leave for YouTube.
      if (appToolExecution) return await appToolExecution(ctx.database) as Output<Name>;
      return output;
    }
    if (walletCall && ctx.commandTransaction) {
      const permission = await daemonAuthorizeScopedGrant(ctx, 
        input as Input<'authorizeSquireCall'>,
        authenticatedAgentId,
        'mcp',
        'wallet',
      );
      if (!permission.allowed)
        return { status: 'permission-required', grantId: permission.grantId } as Output<Name>;
    }
    return daemonExecuteOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);

  }
