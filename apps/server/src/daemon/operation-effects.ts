import { OwnedModelUnknownGeneration, isOwnedModelUnknownGenerationError } from '../owned-model-errors.js';
import { endAgentTurn } from '../agent-turn-end.js';
import { assertCurrentTurnOwner, commandOwnerLiveSql, registerOwnedEffectFence } from '../turn-ownership.js';
import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';
import { OwnedModelCredentials } from '../owned-model-credential.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { clearOwedMention, mentionReplyKey } from '../owed-mentions.js';
import { postRepositoryOnboarding } from '../repository-onboarding.js';
import { queueDatabaseWork } from '../database-work-queue.js';
import { CommandRefusalError } from '../commander.js';
import { vaultSaveRequest, type VaultSaveCard } from '@beeline/api-contract/daemon';
import { FIRST_PARTY_INTEGRATIONS } from '../first-party-integrations.js';
import { setCornerHold } from '../corner-holds.js';
import { authorizeCommandOutput, claimAgentCommand, lockAgentCommandQueue, StaleWakeClaimRefused, createAgentCommand, readAgentCommands, type CommandRow } from '../agent-command.js';
import { createHash } from 'node:crypto';
import { endComputerSession, getComputerSession } from '../computer-session.js';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { recordPersonMergeYes } from '../corner-merge-approval.js';
import { lockCornerLifecycle } from '../corner-lifecycle.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { ensureSystemIdentity, systemLine } from '../system-line.js';
import { appIdentity } from '@beeline/api-contract/workbench';
import { connectorIntentIndex } from '../connector-intent-index.js';
import { composioToolkitForApp } from '../composio-apps.js';
import { deleteInstitutionalMemory, getInstitutionalContext, reportInstitutionalMemoryUsed, saveInstitutionalMemory, searchInstitutionalMemory, updateInstitutionalMemory } from '../institutional-memory-shadow.js';
import { searchInstitutionalHistory } from '../institutional-history.js';
import { loadWorkspaceSkill } from '../institutional-skills.js';
import type { DaemonContext } from './context.js';
import { Input, OwnedModelClaimCapability, Output, id, seconds } from './values.js';
import { daemonLockOwnedTurnAccess, daemonOwnedModelReady, daemonModelClaimCredentials } from './owned-model.js';
import { daemonWriteResult } from './corner-messages.js';
import { daemonRepository } from './corner-reads.js';
import { daemonPostRoomMessage } from './messages.js';
import { daemonAccess } from './access.js';
import { daemonLinkSpendApproval } from './approvals.js';
import { daemonGrantRequester } from './grants.js';
import { daemonAgentWorkbench, daemonOfferContext } from './workbench.js';

export async function getInstitutionalContextOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {
if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('institutional context requires an active command');
        }
        if (!ctx.institutionalMemoryShadow.live) {
          return {
            snapshotRevision: 0,
            text: '',
            itemIds: [],
            totalBytes: 0,
            omitted: {},
          } as Output<Name>;
        }
        return (await getInstitutionalContext(
          ctx.database,
          ctx.authorizedCommand,
          ctx.memoryEmbed,
        )) as Output<Name>;
}

export async function saveInstitutionalMemoryOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('institutional memory changes require an active command');
        }
        if (!ctx.institutionalMemoryShadow.live) {
          throw new Error('institutional memory is disabled');
        }
        const command = ctx.authorizedCommand;
        if (name === 'saveInstitutionalMemory') {
          return (await saveInstitutionalMemory(
            ctx.database,
            command,
            input as Input<'saveInstitutionalMemory'>,
            ctx.afterCommit,
          )) as Output<Name>;
        }
        if (name === 'updateInstitutionalMemory') {
          return (await updateInstitutionalMemory(
            ctx.database,
            command,
            input as Input<'updateInstitutionalMemory'>,
            ctx.afterCommit,
          )) as Output<Name>;
        }
        if (name === 'deleteInstitutionalMemory') {
          return (await deleteInstitutionalMemory(
            ctx.database,
            command,
            input as Input<'deleteInstitutionalMemory'>,
          )) as Output<Name>;
        }
        return (await reportInstitutionalMemoryUsed(
          ctx.database,
          command,
          input as Input<'reportInstitutionalMemoryUsed'>,
        )) as Output<Name>;
      
}

export async function searchInstitutionalMemoryOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {
if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('institutional memory search requires an active command');
        }
        if (!ctx.institutionalMemoryShadow.live) {
          throw new Error('institutional memory is disabled');
        }
        return (await searchInstitutionalMemory(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'searchInstitutionalMemory'>,
          ctx.memoryEmbed,
        )) as Output<Name>;
}

export async function searchInstitutionalHistoryOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {
if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('institutional history search requires an active command');
        }
        if (!ctx.institutionalMemoryShadow.live) {
          throw new Error('institutional memory is disabled');
        }
        return (await searchInstitutionalHistory(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'searchInstitutionalHistory'>,
        )) as Output<Name>;
}

export async function loadWorkspaceSkillOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {
if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('workspace skill load requires an active command');
        }
        if (!ctx.institutionalMemoryShadow.live) {
          throw new Error('institutional memory is disabled');
        }
        return (await loadWorkspaceSkill(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'loadWorkspaceSkill'>,
        )) as Output<Name>;
}

export async function claimAgentCommandOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        if(!turnOwner)throw new Error('helper claim requires its machine connection owner');
        const claimed = await queueDatabaseWork(ctx.database, `turn:${scopedRoom}:${authenticatedAgentId}`, () => ctx.database.transaction(async (db) => {
          if (ownedIntent) await daemonLockOwnedTurnAccess(ctx, db, scopedRoom!, authenticatedAgentId, String(candidate.commandId));
          const row = await claimAgentCommand(db, scopedRoom!, authenticatedAgentId,
            String(candidate.commandId), typeof candidate.generationId === 'string' ? candidate.generationId : '', turnOwner, name === 'claimAgentTurn')
            .catch((error: unknown) => {
              if (isOwnedModelUnknownGenerationError(error)) throw new OwnedModelUnknownGeneration();
              // Commit stale cancellations before refusing a cached helper claim.
              if (error instanceof StaleWakeClaimRefused) return error;
              throw error;
            });
          if (row instanceof StaleWakeClaimRefused) return row;
          let modelCredential: Awaited<ReturnType<OwnedModelCredentials['issueInTransaction']>> | undefined;
          if (turnOwner && daemonOwnedModelReady(ctx) && (row.action === 'input' || row.action === 'resume') &&
              (await db.query('SELECT 1 FROM free_agents WHERE agent_id=$1', [authenticatedAgentId])).rowCount) {
            const credentials = daemonModelClaimCredentials(ctx, modelClaim, authenticatedAgentId, turnOwner);
            modelCredential = await credentials.issueInTransaction(db, { agentId: authenticatedAgentId, commandId: row.id,
              generationId: row.generation_id!, source: turnOwner });
          }
          const activity = row.reason === 'computer_activity' ? (await db.query<{
            text: string; system_event: NonNullable<import('@beeline/api-contract/daemon').AgentCommand['source']['systemEvent']>;
          }>(`SELECT text,system_event FROM messages WHERE id=$1`, [row.source_message_id])).rows[0] : undefined;
          const commands = name === 'claimAgentTurn'
            ? (await readAgentCommands(db, scopedRoom!, authenticatedAgentId, row.generation_id!)).commands
            : undefined;
          return { row, activity, modelCredential, commands };
        }));
        if (claimed instanceof StaleWakeClaimRefused) {
          claimed.log();
          throw claimed;
        }
        ctx.live.publish({ type: 'invalidate', roomId: scopedRoom!, reason: 'turn', agentId: authenticatedAgentId });
        return { ...daemonWriteResult(ctx),
          ...(claimed.commands ? { commands: claimed.commands } : {}),
          ...(claimed.modelCredential ? { modelCredential: claimed.modelCredential } : {}),
          ...(claimed.row.recovery_context ? { recoveryContext: claimed.row.recovery_context } : {}),
          ...(claimed.activity ? { activitySource: { body: claimed.activity.text, systemEvent: claimed.activity.system_event } } : {}),
        } as Output<Name>;
      
}

export async function releaseAgentTurnOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        if (!turnOwner) throw new Error('turn release requires its machine connection owner');
        const released = await ctx.database.transaction(async db => {
          await assertCurrentTurnOwner(db, authenticatedAgentId, turnOwner);
          await lockAgentCommandQueue(db, scopedRoom!, authenticatedAgentId);
          await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,
            lease_expires_at=NULL,claimed_at=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL
            WHERE room_id=$1 AND agent_id=$2 AND state='claimed' AND generation_id=$3
              AND action IN ('input','resume') AND turn_owner_connection_id=$4 AND turn_owner_epoch=$5`,
            [scopedRoom,authenticatedAgentId,candidate.generationId,turnOwner.connectionId,turnOwner.epoch]);
          return readAgentCommands(db, scopedRoom!, authenticatedAgentId);
        });
        ctx.live.publish({type:'invalidate',roomId:scopedRoom!,reason:'turn',agentId:authenticatedAgentId});
        return {...daemonWriteResult(ctx), commands: released.commands} as Output<Name>;
      
}

export async function acknowledgeAgentCommandOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const acknowledged = await ctx.database.transaction(async db => {
          if (ownedIntent) await daemonLockOwnedTurnAccess(ctx, db, scopedRoom!, authenticatedAgentId, String(candidate.commandId));
          if (turnOwner) await assertCurrentTurnOwner(db, authenticatedAgentId, turnOwner);
          if (turnOwner) {
            const previous = await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1 AND room_id=$2
              AND agent_id=$3 AND generation_id=$4 AND action IN ('stop','restart') AND state='complete'
              AND turn_owner_connection_id=$5 AND turn_owner_epoch=$6 FOR UPDATE`,
              [candidate.commandId, scopedRoom, authenticatedAgentId, candidate.generationId, turnOwner.connectionId, turnOwner.epoch]);
            if (previous.rowCount) return previous;
          }
          const written = await db.query<CommandRow>(
          `SELECT (ended).* FROM (SELECT beeline_end_agent_turn(id,generation_id,'complete') ended FROM agent_commands WHERE id=$1 AND room_id=$2 AND agent_id=$3 AND generation_id=$4 AND (state='complete' OR (state='claimed' AND ${commandOwnerLiveSql(undefined)}))
          AND action IN ('stop','restart') AND ((turn_owner_connection_id IS NULL AND $5::text IS NULL) OR
            (turn_owner_connection_id=$5::text AND turn_owner_epoch=$6::bigint))) ended_commands`,
          [candidate.commandId, scopedRoom, authenticatedAgentId, candidate.generationId,
            turnOwner?.connectionId ?? null, turnOwner?.epoch ?? null]);
          if (written.rows[0]?.action==='restart') await db.query(`UPDATE agent_commands
            SET restart_confirmed_at=COALESCE(restart_confirmed_at,clock_timestamp()) WHERE id=$1`,[written.rows[0].id]);
          if (written.rows[0]) await registerOwnedEffectFence(db, written.rows[0]);
          return written;
        });
        if (!acknowledged.rowCount) throw new Error('command acknowledgement conflict');
        return daemonWriteResult(ctx) as Output<Name>;
      
}

export async function noteEmptyRoomRepositoryOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const roomId = (input as Input<'noteEmptyRoomRepository'>).roomId;
        const repository = await daemonRepository(ctx, roomId, authenticatedAgentId);
        if (repository.resolution !== 'repository')
          throw new Error('Room is not repository-backed');
        await ensureSystemIdentity(ctx.database);
        const line = await systemLine(ctx.database, {
          id: createHash('sha256').update(`room-empty-repository:v1:${roomId}`).digest('hex'),
          roomId,
          authorId: SYSTEM_IDENTITY_ID,
          subject: { kind: 'system', name: systemMessage("daemon-service.this-repository") },
          verb: systemMessage("daemon-service.has-no-commits-yet-push-a-first-commit-and-i-ll-pick-it-up"),
        });
        return { id: line.id, createdAt: seconds(new Date()) } as Output<Name>;
      
}

export async function getRoomGitHubTokenOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        if (!ctx.roomGitHubToken) throw new Error('GitHub room token service unavailable');
        const roomId = (input as Input<'getRoomGitHubToken'>).roomId;
        try {
          return (await ctx.roomGitHubToken(roomId)) as Output<Name>;
        } catch (error) {
          // The exact missing-installation result is a Room configuration
          // fact. An upstream 404 alone does not establish that fact.
          if (
            error instanceof Error &&
            error.message === 'GitHub repository installation not found'
          ) {
            await ensureSystemIdentity(ctx.database);
            await systemLine(ctx.database, {
              id: createHash('sha256')
                .update(`room-github-installation-unavailable:v1:${roomId}`)
                .digest('hex'),
              roomId,
              authorId: SYSTEM_IDENTITY_ID,
              subject: { kind: 'system', name: systemMessage("daemon-service.install-or-grant-the-beeline-github-app") },
              verb: systemMessage("daemon-service.to-access-this-repository"),
            });
            throw new CommandRefusalError('Room repository access needs the Beeline GitHub App', 409);
          }
          throw error;
        }
      
}

export async function markAgentTurnSilentOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const declinedMessage = name === 'markAgentTurnSilent' ? (input as Input<'markAgentTurnSilent'>).messageId : undefined;
        if (name === 'markAgentTurnSilent') {
          const command = ctx.authorizedCommand;
          if (!command) throw new CommandRefusalError('silence requires an active turn', 409);
          if (declinedMessage && !await mentionReplyKey(ctx.database, authenticatedAgentId, command.room_id, declinedMessage))
            throw new CommandRefusalError('messageId must be a tagged message in this Room', 400);
          if (!declinedMessage && !['report', 'order', 'watched_corner', 'corner_check', 'corner_review_needed',
            'corner_review_dispatch', 'corner_merge_conflict', 'computer_activity',
            'schedule', 'subscribed_event', 'system', 'agent_tag', 'corner_objective',
            'corner_land', 'corner_merge_refused', 'corner_merge_unconfirmed',
            'corner_background_tool', 'corner_brief_revision'].includes(command.reason))
            throw new CommandRefusalError('no_reply_needed requires a nonhuman wake. Call post({text: <your reply>}), then end the turn.', 400);
          if (!(await ctx.database.query(`SELECT 1 FROM agent_pending_attachments
            WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND generation_id=$4 LIMIT 1`,
            [command.room_id, authenticatedAgentId, command.turn_request_id, command.generation_id])).rowCount) {
            await ctx.database.query(`UPDATE agent_turns SET completion_kind='no-reply'
              WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,
              [command.room_id, authenticatedAgentId, command.turn_request_id]);
            await endAgentTurn(ctx.database, command, 'complete');
            if (declinedMessage) await clearOwedMention(ctx.database, authenticatedAgentId, command.room_id, declinedMessage);
            return daemonWriteResult(ctx) as Output<Name>;
          }
          // Drain promised files through the same ordinary reply path before
          // recording silence; the reply writer never receives System prose.
          input = { roomId: command.room_id, requestId: command.turn_request_id!,
            generationId: command.generation_id!, text: '' } as Input<Name>;
        }
        const output = await daemonPostRoomMessage(ctx, 
          input as Input<'postRoomMessage'>,
          authenticatedAgentId,
        );
        if (name === 'markAgentTurnSilent') {
          const command = ctx.authorizedCommand!;
          await ctx.database.query(`UPDATE agent_turns SET completion_kind='no-reply'
            WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,
            [command.room_id, authenticatedAgentId, command.turn_request_id]);
          if (declinedMessage) await clearOwedMention(ctx.database, authenticatedAgentId, command.room_id, declinedMessage);
          return daemonWriteResult(ctx) as Output<Name>;
        }
        return output as Output<Name>;
      
}

export async function postBackgroundToolCompletionOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const completion = input as Input<'postBackgroundToolCompletion'>;
        if (!completion.toolCallId || completion.toolCallId.length > 512 ||
            !['completed', 'failed'].includes(completion.status))
          throw new Error('invalid background tool completion');
        await daemonAccess(ctx, completion.roomId, authenticatedAgentId);
        return await ctx.database.transaction(async (db) => {
          if (ownedIntent) await daemonLockOwnedTurnAccess(ctx, db, completion.roomId, authenticatedAgentId);
          const origin = await authorizeCommandOutput(db, completion.roomId, authenticatedAgentId,
            completion.requestId, completion.generationId, true);
          // Older helpers may detach the terminal MCP call before its result
          // arrives. Its result cannot add work to a turn already ended silently.
          // Preserve every other background job and every later generation.
          if (/^(?:(?:mcp__)?beeline[-_]agent__|mcp\.beeline-agent\.)?no_reply_needed$/.test(completion.title) &&
              (await db.query(`SELECT 1 FROM agent_turns
                WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND generation_id=$4
                  AND completion_kind='no-reply'`,
              [completion.roomId, authenticatedAgentId, completion.requestId, completion.generationId])).rowCount)
            return daemonWriteResult(ctx);
          const commandId = createHash('sha256').update(JSON.stringify([
            'background-tool', origin.id, completion.generationId, completion.toolCallId,
          ])).digest('hex');
          await createAgentCommand(db, {
            id: commandId, roomId: completion.roomId, agentId: authenticatedAgentId,
            sourceMessageId: null, parent: origin, retainDepth: true,
            reason: 'corner_background_tool',
            privatePayload: {
              kind: 'lifecycle', authorId: SYSTEM_IDENTITY_ID, fromRoomId: completion.roomId,
              text: `Your background tool ${completion.title.slice(0, 500)} (${completion.toolCallId}) ${completion.status}. Continue the work from its result.`,
            },
          });
          return daemonWriteResult(ctx);
        }) as Output<Name>;
      
}

export async function endComputerSessionOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const ending = input as Input<'endComputerSession'>;
        const session = (await ctx.database.query<{ id: string }>(
          `SELECT id FROM computer_sessions WHERE room_id=$1 AND agent_id=$2 AND source_session_id=$3 AND status='live'`,
          [ending.roomId, authenticatedAgentId, ending.sessionId],
        )).rows;
        for (const found of session) {
          const row = await getComputerSession(ctx.database, found.id);
          if (row) await endComputerSession(ctx.database, ctx.live, row);
        }
        return daemonWriteResult(ctx) as Output<Name>;
      
}

export async function createLinkSpendRequestOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        if (!ctx.linkWallet) throw new Error('Link is not configured');
        const request = input as Input<'createLinkSpendRequest'>;
        const owner = (await ctx.database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`, [authenticatedAgentId])).rows[0];
        if (!owner) throw new Error('agent owner not found');
        const created = await ctx.linkWallet.create(owner.owner_id, authenticatedAgentId,
          request.roomId, request);
        if (created.approval_url) await daemonLinkSpendApproval(ctx, request, authenticatedAgentId,
          owner.owner_id, created.id, created.approval_url);
        return { id: created.id, status: created.status,
          ...(created.approval_url ? { approvalUrl: created.approval_url } : {}) } as Output<Name>;
      
}

export async function retrieveLinkSpendRequestOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        if (!ctx.linkWallet) throw new Error('Link is not configured');
        const request = input as Input<'retrieveLinkSpendRequest'>;
        const owner = (await ctx.database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`, [authenticatedAgentId])).rows[0];
        if (!owner) throw new Error('agent owner not found');
        const result = await ctx.linkWallet.retrieve(owner.owner_id, authenticatedAgentId, request.id);
        return { id: result.id, status: result.status,
          ...(result.approval_url ? { approvalUrl: result.approval_url } : {}),
          ...(result.status_details?.requires_action?.next_action ? { nextAction: {
            resolution: result.status_details.requires_action.next_action.resolution,
            displayMessage: result.status_details.requires_action.next_action.display_message,
            actionUrl: result.status_details.requires_action.next_action.action_url } } : {}),
          ...(result.card ? { card: { number: result.card.number, cvc: result.card.cvc,
            expMonth: result.card.exp_month, expYear: result.card.exp_year,
            billingAddress: result.card.billing_address ? {
              name: result.card.billing_address.name,
              postalCode: result.card.billing_address.postal_code,
              line1: result.card.billing_address.line1, city: result.card.billing_address.city,
              state: result.card.billing_address.state,
              country: result.card.billing_address.country } : undefined,
            validUntil: result.card.valid_until } } : {}),
          ...(result.shared_payment_token ? { sharedPaymentToken: {
            id: result.shared_payment_token.id,
            validUntil: result.shared_payment_token.valid_until } } : {}) } as Output<Name>;
      
}

export async function postStarterWelcomeOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const request = input as Input<'postStarterWelcome'>;
        await daemonAccess(ctx, request.roomId, authenticatedAgentId);
        const requester = await daemonGrantRequester(ctx);
        const personId = requester.kind === 'human' ? requester.id : (await ctx.database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`, [authenticatedAgentId])).rows[0]?.owner_id;
        if (!personId) throw new Error('Onboarding requester unavailable');
        if (!ctx.starterOnboarding) throw new Error('Onboarding service unavailable');
        await ctx.starterOnboarding.queueRerun(ctx.database, request.roomId, personId, authenticatedAgentId);
        const service = ctx.starterOnboarding;
        ctx.afterCommit?.(() => {
          void service.prepare(request.roomId).then(() => service.open(request.roomId, personId))
            .catch(error => console.error('[onboarding] rerun failed', error));
        });
        const result = { status: 'started' as const };
        ctx.live.publish({ type: 'invalidate', roomId: request.roomId, reason: 'message' });
        return result as Output<Name>;
      
}

export async function postRepositoryOnboardingOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const request = input as Input<'postRepositoryOnboarding'>;
        await daemonAccess(ctx, request.roomId, authenticatedAgentId);
        const requester = await daemonGrantRequester(ctx);
        const owner = requester.kind === 'human' ? requester.id : (await ctx.database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`, [authenticatedAgentId])).rows[0]?.owner_id;
        if (!owner) throw new Error('repository onboarding unavailable');
        if (!['repository', 'starters'].includes(request.kind)) throw new Error('invalid repository card kind');
        if (request.kind === 'repository') await ctx.github?.refresh(owner);
        const card = await ctx.database.transaction(database => postRepositoryOnboarding(database, ctx.github, {
          roomId: request.roomId, agentId: authenticatedAgentId, requesterId: owner, kind: request.kind,
        }));
        ctx.live.publish({ type: 'invalidate', roomId: request.roomId, reason: 'message', agentId: authenticatedAgentId });
        return card as Output<Name>;
      
}

export async function findConnectorsOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const request = input as Input<'findConnectors'>;
        const query = typeof request.query === 'string' ? request.query.trim() : '';
        if (!query || query.length > 200) throw new Error('query is required and must be at most 200 characters');
        const view = await daemonAgentWorkbench(ctx, request, authenticatedAgentId);
        const index = connectorIntentIndex(ctx.mcpRegistry, ctx.composio);
        await index.refresh();
        const status = new Map<string, import('@beeline/api-contract/daemon').ConnectorSearchMatch['status']>();
        for (const entry of view.catalog) status.set(entry.connectorType,
          entry.paired?.status === 'connected' ? 'connected' : entry.paired?.status === 'error' ? 'broken' : 'not-connected');
        status.set('trusty-squire', view.machine.squire?.status === 'connected' ? 'connected'
          : view.machine.squire?.status === 'error' ? 'broken' : 'not-connected');
        for (const app of view.apps ?? []) {
          const value = app.status === 'connected' ? 'connected' : app.status === 'error' ? 'broken' : 'not-connected';
          status.set(app.appKey, value);
          status.set(composioToolkitForApp(app.appKey), value);
        }
        const personal = view.connections.flatMap(connection => {
          const key = connection.service && appIdentity(connection.service)?.key;
          if (!key) return [];
          if (!['wallet', 'tailscale', 'trusty-squire', ...FIRST_PARTY_INTEGRATIONS.map(entry => entry.key)].includes(key))
            status.set(key, connection.state === 'active' ? 'connected' : 'broken');
          return [{ key, service: connection.service!, name: connection.label, source: 'squire' as const,
            aliases: [connection.service!], intents: ['twilio', 'plivo', 'telnyx'].includes(key)
              ? ['send texts', 'text messages', 'sms'] : [] }];
        });
        for (const entry of view.firstPartyIntegrations ?? []) status.set(entry.key, entry.status);
        return index.search(query, status, personal) as Output<Name>;
      
}

export async function postVaultSaveCardOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const cardInput = input as Input<'postVaultSaveCard'>;
        const metadata = vaultSaveRequest(cardInput);
        const context = await daemonOfferContext(ctx, cardInput.roomId, authenticatedAgentId);
        const card: VaultSaveCard = { ...metadata, agentId: authenticatedAgentId,
          ownerId: context.owner.pubkey, ownerName: context.owner.name, status: 'pending' };
        const line = await systemLine(ctx.database, { roomId: cardInput.roomId,
          subject: { kind: 'agent', id: authenticatedAgentId, name: context.agent.name },
          verb: systemMessage("daemon-service.wants-a-vault-entry"), object: systemMessage("daemon-service.vault-entry-title", metadata.service, metadata.label),
          consequence: metadata.purpose, presentation: 'card', cardType: 'vault-save',
          card: { ...card, originCommandId: ctx.authorizedCommand!.id } as unknown as Record<string, unknown> });
        return { id: line.id, createdAt: seconds(new Date()) } as Output<Name>;
      
}

export async function setCornerHoldOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const hold = input as Input<'setCornerHold'>;
        await daemonAccess(ctx, hold.cornerId, authenticatedAgentId);
        const result = await ctx.database.transaction(async (db) => {
          await lockCornerLifecycle(db, hold.cornerId);
          const command = await authorizeCommandOutput(
            db, hold.roomId, authenticatedAgentId, hold.requestId, hold.generationId,
          );
          const actor = (await db.query<{ author_id: string }>(
            `SELECT message.author_id FROM messages message
             JOIN identities person ON person.id=message.author_id AND person.kind='human'
             WHERE message.id=$1`,
            [command.root_source_message_id],
          )).rows[0];
          if (!actor && hold.releaseHoldId !== undefined) throw new Error('hold requires a human requester');
          return setCornerHold(db, hold, actor?.author_id ?? authenticatedAgentId, authenticatedAgentId);
        });
        const reconcile = async () => { await ctx.github?.reconcileQueuedCorners(hold.cornerId); };
        if (ctx.afterCommit) ctx.afterCommit(reconcile);
        else await reconcile();
        return result as Output<Name>;
      
}

export async function orderCornerMergeOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {

        const order = input as Input<'orderCornerMerge'>;
        await daemonAccess(ctx, order.cornerId, authenticatedAgentId);
        const actorId = await ctx.database.transaction(async (db) => {
          const command = await authorizeCommandOutput(
            db, order.roomId, authenticatedAgentId, order.requestId, order.generationId,
          );
          const actor = (await db.query<{ author_id: string }>(
            `SELECT message.author_id FROM messages message
             JOIN identities person ON person.id=message.author_id AND person.kind='human'
             WHERE message.id=$1`,
            [command.root_source_message_id],
          )).rows[0];
          if (!actor) throw new Error('merge order requires a human requester');
          return actor.author_id;
        });
        const yes = await recordPersonMergeYes(ctx.database, order.cornerId, actorId);
        // Recording consent is a separate action from landing. The caller uses
        // merge_corner for the single agent-facing landing action.
        return { roomId: yes.roomId, headSha: yes.headSha } as Output<Name>;
      
}

