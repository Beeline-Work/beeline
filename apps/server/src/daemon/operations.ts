import { setAgentWakePaused } from '../agent-wake-pause.js';
import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';
import { attachUsageAccount, helperUsageEnabled, publishUsageAccount } from '../helper-usage.js';
import { owedMentions } from '../owed-mentions.js';
import { postStarterVideoPreview } from '../starter-onboarding.js';
import { readUsageRefreshOutcome } from '@beeline/api-contract/daemon';
import { postStarterInviteOffer } from '../starter-invite.js';
import { sendOperatorSystemDm, readOperatorSystemDm } from '../operator-system-dm.js';
import { productionReleaseDispatch } from '../production-release-dispatch.js';
import { agentUsage, notifyUsageRefreshResult, postedRefreshOutcome, saveAgentUsage } from '../agent-usage.js';
import { queueDatabaseWork } from '../database-work-queue.js';
import { normalizeAgentAsk } from '../tray-approval-ask.js';
import { commandAddress, sendOrder, stopCommandedTurn, CommandRefusalError } from '../commander.js';
import { createAgentSubscription, listAgentSubscriptions, deleteAgentSubscription, listServiceSubscriptionEvents } from '../agent-subscriptions.js';
import { completeProviderWebhookAssignment } from '../provider-webhooks.js';
import { reportAgentSignIn } from '../agent-sign-in.js';
import { forgetSquireSignIn } from '../squire-machine.js';
import { readAgentCommands } from '../agent-command.js';
import { createComputerSession, refreshComputerSession } from '../computer-session.js';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { type CornerWatchKind } from '@beeline/api-contract/daemon';
import { agentWalletTool, agentSignTypedData, agentContractCall } from '../wallet.js';
import { getInstitutionalMemoryTurnStats } from '../institutional-memory-shadow.js';
import { notifyFeedbackFixed, reportAgentFeedback } from '../feedback.js';
import { deleteSkill, saveSkill } from '../institutional-skills.js';
import { archiveWorkflow, assignWorkflowRole, handoff, getWorkflowRun, cancelWorkflowRun, saveWorkflow, startWorkflow } from '../workflow-runs.js';
import type { DaemonContext } from './context.js';
import { Input, OwnedModelClaimCapability, Output, id } from './values.js';
import { getInstitutionalContextOperation, saveInstitutionalMemoryOperation, searchInstitutionalMemoryOperation, searchInstitutionalHistoryOperation, loadWorkspaceSkillOperation, claimAgentCommandOperation, releaseAgentTurnOperation, acknowledgeAgentCommandOperation, noteEmptyRoomRepositoryOperation, getRoomGitHubTokenOperation, markAgentTurnSilentOperation, postBackgroundToolCompletionOperation, endComputerSessionOperation, createLinkSpendRequestOperation, retrieveLinkSpendRequestOperation, postStarterWelcomeOperation, postRepositoryOnboardingOperation, findConnectorsOperation, postVaultSaveCardOperation, setCornerHoldOperation, orderCornerMergeOperation } from './operation-effects.js';
import { daemonAccess, daemonRoomMembers } from './access.js';
import { daemonBootstrap, daemonWorkspaceRoster, daemonInbox } from './inbox-roster.js';
import { daemonRoomMessage } from './message-reads.js';
import { daemonReport, daemonWatchCorner, daemonCornerRemote, daemonCornerPlan, daemonRenameCorner, daemonTargetProposal } from './corner-reports.js';
import { daemonRoomAuthority, daemonPermissionAuthority, daemonMissionAuthority, daemonScheduleAuthority, daemonMandate, daemonTargetAuthority } from './authority.js';
import { daemonCreateAgentSchedule, daemonSetEventSubscriptions, daemonListEventSubscriptions, daemonPostRoomEvent, daemonListAgentSchedules, daemonDeleteAgentSchedule, daemonUpdateAgentSchedule } from './schedules-events.js';
import { daemonWriteResult, daemonReach, daemonPostCornerMessage, daemonReactToRoomMessage } from './corner-messages.js';
import { daemonCorners, daemonApproveCornerMerge, daemonCloseCornerPullRequest, daemonMergeCorner, daemonCornerRestore, daemonListCornerBriefRevisions, daemonRepository, daemonTargetBranch } from './corner-reads.js';
import { daemonReviseCornerBrief, daemonCreateCorner, daemonArchiveCorner, daemonEnsureMembership } from './corner-writes.js';
import { daemonRepositoryOnboardingRequester, daemonRequestAgentGrant, daemonGrantRequester, daemonAskRoomChoice, daemonOpenRoomPoll, daemonListAgentGrants, daemonConsumeAgentGrant, daemonListAgentGrantRequests, daemonAuthorizeSquireCall } from './grants.js';
import { daemonIdentitySuccession, daemonConfiguration, daemonPresence } from './configuration.js';
import { daemonCompletion, daemonPostAgentAttachment, daemonLiveOutput, daemonRetract } from './messages.js';
import { daemonTurnReceipt, daemonActivity } from './turn-receipts.js';
import { daemonSquireApproval, daemonSquireLoginWall, daemonSquireApprovalDecision, daemonPermissionRequest, daemonPermissionExecution } from './approvals.js';
import { daemonPostMandate, daemonAgentAvatar, daemonCommands, daemonModelCatalog, daemonMachineReport } from './models.js';
import { daemonConnectorAssignments, daemonConnectorInstall, daemonConnectorStatusReport, daemonConnectorVaultReport, daemonConnectorStatusView, daemonConnectorVaultList, daemonConnectionDetail, daemonConnectionGrantRevoke, daemonConnectionUsage } from './connectors.js';
import { daemonAuthorizeResource, daemonConnectMcpServer, daemonOfferConnector } from './connector-offers.js';
import { daemonAgentWorkbench, daemonSearchMcpRegistry } from './workbench.js';
import { daemonConnectAppFrontDoor, daemonConnectService, daemonListAppTools, daemonExecuteAppTool } from './apps.js';

export async function daemonExecuteOperation<Name extends keyof DaemonOperationMap>(ctx: DaemonContext, name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner: HelperTurnOwnershipSource | undefined, modelClaim: OwnedModelClaimCapability | undefined, candidate: Record<string, unknown>, scopedRoom: string | undefined, ownedIntent: boolean): Promise<Output<Name>> {
    switch (name) {
      case 'getInstitutionalContext':
        return getInstitutionalContextOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'saveInstitutionalMemory':
      case 'updateInstitutionalMemory':
      case 'deleteInstitutionalMemory':
      case 'reportInstitutionalMemoryUsed':
        return saveInstitutionalMemoryOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'searchInstitutionalMemory':
        return searchInstitutionalMemoryOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'searchInstitutionalHistory':
        return searchInstitutionalHistoryOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'getInstitutionalMemoryTurnStats':
        if (!ctx.institutionalMemoryShadow.live) {
          return { searchCalls: 0, searchMisses: 0 } as Output<Name>;
        }
        return (await getInstitutionalMemoryTurnStats(
          ctx.database,
          authenticatedAgentId,
          input as Input<'getInstitutionalMemoryTurnStats'>,
        )) as Output<Name>;
      case 'loadWorkspaceSkill':
        return loadWorkspaceSkillOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'saveSkill':
        if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('skill save requires an active command');
        }
        return (await saveSkill(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'saveSkill'>,
          undefined,
          ctx.afterCommit,
        )) as Output<Name>;
      case 'deleteSkill':
        if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('skill delete requires an active command');
        }
        return (await deleteSkill(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'deleteSkill'>,
        )) as Output<Name>;
      case 'saveWorkflow':
        if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('workflow save requires an active command');
        }
        return (await saveWorkflow(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'saveWorkflow'>,
          ctx.afterCommit,
        )) as Output<Name>;
      case 'startWorkflow':
        if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('workflow start requires an active command');
        }
        return (await startWorkflow(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'startWorkflow'>,
        )) as Output<Name>;
      case 'getWorkflowRun': {
        const read = input as Input<'getWorkflowRun'>;
        await daemonAccess(ctx, read.roomId, authenticatedAgentId);
        return (await getWorkflowRun(ctx.database, read.roomId, read.runId)) as Output<Name>;
      }
      case 'cancelWorkflowRun':
        if (!ctx.commandTransaction || !ctx.authorizedCommand)
          throw new Error('workflow cancellation requires an active command');
        return (await cancelWorkflowRun(ctx.database, ctx.authorizedCommand, input as Input<'cancelWorkflowRun'>)) as Output<Name>;
      case 'handoff':
        if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('workflow handoff requires an active command');
        }
        return (await handoff(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'handoff'>,
        )) as Output<Name>;
      case 'archiveWorkflow':
        if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('workflow archive requires an active command');
        }
        return (await archiveWorkflow(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'archiveWorkflow'>,
        )) as Output<Name>;
      case 'assignWorkflowRole':
        if (!ctx.commandTransaction || !ctx.authorizedCommand) {
          throw new Error('workflow role assignment requires an active command');
        }
        return (await assignWorkflowRole(
          ctx.database,
          ctx.authorizedCommand,
          input as Input<'assignWorkflowRole'>,
        )) as Output<Name>;
      case 'getAgentCommands':
        return (await queueDatabaseWork(ctx.database, `turn:${scopedRoom}:${authenticatedAgentId}`, () => readAgentCommands(
          ctx.database,
          scopedRoom!,
          authenticatedAgentId,
        ))) as Output<Name>;
      case 'claimAgentCommand':
      case 'claimAgentTurn':
        return claimAgentCommandOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'releaseAgentTurn':
        return releaseAgentTurnOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'acknowledgeAgentCommand':
        return acknowledgeAgentCommandOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'getDaemonBootstrap':
        return (await daemonBootstrap(ctx, authenticatedAgentId)) as Output<Name>;
      case 'getWorkspaceRoster':
        return (await daemonWorkspaceRoster(ctx,
          input as Input<'getWorkspaceRoster'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getOwedMentions':
        return { owedMentions: await owedMentions(ctx.database, authenticatedAgentId) } as Output<Name>;
      case 'getRoomInbox':
      case 'getRoomConversation':
      case 'getCornerCloseRequests':
        return (await daemonInbox(ctx,
          name,
          input as Input<'getRoomConversation'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getRoomMessage':
        return (await daemonRoomMessage(ctx,
          input as Input<'getRoomMessage'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'order':
        return await sendOrder(ctx.database, ctx.authorizedCommand!, authenticatedAgentId,
          String(candidate.address), String(candidate.text),
          candidate.agent === undefined ? undefined : String(candidate.agent)) as Output<Name>;
      case 'stopAgentTurn':
        return await stopCommandedTurn(ctx.database, ctx.authorizedCommand!, authenticatedAgentId,
          String(candidate.address),
          candidate.agent === undefined ? undefined : String(candidate.agent)) as Output<Name>;
      case 'report': {
        const ask = candidate.ask === undefined
          ? undefined : normalizeAgentAsk(candidate.ask);
        return await daemonReport(ctx, typeof candidate.text === 'string' ? candidate.text : '', authenticatedAgentId, ctx.authorizedCommand!, ctx.database, false, candidate.status, ask, candidate.to) as Output<Name>;
      }
      case 'read': {
        const target = await commandAddress(ctx.database, String(candidate.address), authenticatedAgentId, true);
        return await daemonInbox(ctx, 'getRoomConversation', { roomId: target.id, limit: candidate.limit as number | undefined }, authenticatedAgentId) as Output<Name>;
      }
      case 'getRoomAuthority':
        return (await daemonRoomAuthority(ctx,
          input as Input<'getRoomAuthority'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getPermissionAuthority':
        return (await daemonPermissionAuthority(ctx,
          input as Input<'getPermissionAuthority'>,
        )) as Output<Name>;
      case 'getMissionAuthority':
        return (await daemonMissionAuthority(ctx)) as Output<Name>;
      case 'getWorkScheduleAuthority':
        return (await daemonScheduleAuthority(ctx,
          input as Input<'getWorkScheduleAuthority'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'createAgentSchedule':
        return (await daemonCreateAgentSchedule(ctx,
          input as Input<'createAgentSchedule'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'createAgentSubscription':
        return await createAgentSubscription(ctx.database, authenticatedAgentId,
          input as Input<'createAgentSubscription'>,
          ctx.subscriptionReceiverUrl
            ? { ...(ctx.composio ? { composio: ctx.composio } : {}),
              receiverUrl: ctx.subscriptionReceiverUrl } : undefined) as Output<Name>;
      case 'listServiceSubscriptionEvents':
        return ctx.subscriptionReceiverUrl
          ? await listServiceSubscriptionEvents(ctx.database,
            (input as Input<'listServiceSubscriptionEvents'>).roomId, authenticatedAgentId,
            Boolean(ctx.composio)) as Output<Name>
          : { events: [] } as Output<Name>;
      case 'listAgentSubscriptions':
        return await listAgentSubscriptions(ctx.database,
          (input as Input<'listAgentSubscriptions'>).roomId, authenticatedAgentId) as Output<Name>;
      case 'setAgentWakePaused': {
        await setAgentWakePaused(ctx.database, authenticatedAgentId, input as Input<'setAgentWakePaused'>);
        return daemonWriteResult(ctx) as Output<Name>;
      }
      case 'deleteAgentSubscription': {
        const i = input as Input<'deleteAgentSubscription'>;
        await deleteAgentSubscription(ctx.database, i.roomId, authenticatedAgentId, i.subscriptionId, ctx.composio);
        return daemonWriteResult(ctx) as Output<Name>;
      }
      case 'setEventSubscriptions':
        return (await daemonSetEventSubscriptions(ctx,
          input as Input<'setEventSubscriptions'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'watchCorner':
        return (await daemonWatchCorner(ctx,
          input as Input<'watchCorner'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'listEventSubscriptions':
        return (await daemonListEventSubscriptions(ctx,
          input as Input<'listEventSubscriptions'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postRoomEvent':
        return (await daemonPostRoomEvent(ctx,
          input as Input<'postRoomEvent'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'listAgentWatches':
        return { watches: (await ctx.database.query<{ address: string; kinds: readonly CornerWatchKind[] }>(
          `SELECT corner_id address,kinds FROM corner_watches WHERE watcher_room_id=$1 AND agent_id=$2 ORDER BY corner_id`,
          [(input as Input<'listAgentWatches'>).roomId, authenticatedAgentId])).rows } as Output<Name>;
      case 'listAgentSchedules':
        return (await daemonListAgentSchedules(ctx,
          input as Input<'listAgentSchedules'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'deleteAgentSchedule':
        return (await daemonDeleteAgentSchedule(ctx,
          input as Input<'deleteAgentSchedule'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'updateAgentSchedule':
        return (await daemonUpdateAgentSchedule(ctx,
          input as Input<'updateAgentSchedule'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getAgentToolMandate':
        return (await daemonMandate(ctx,
          input as Input<'getAgentToolMandate'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getTargetAgentAuthority':
        return (await daemonTargetAuthority(ctx,
          input as Input<'getTargetAgentAuthority'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'listRoomCorners':
      case 'listUntrackedCorners':
        return (await daemonCorners(ctx,
          (input as Input<'listRoomCorners'>).roomId,
          authenticatedAgentId,
          (input as Input<'listRoomCorners'>).activeOnly === true,
        )) as Output<Name>;
      case 'listRooms': {
        const rooms = await ctx.database.query<{ roomId: string; name: string; parentRoomId: string | null; directMessage: boolean }>(
          `SELECT room.id "roomId",room.name,room.parent_id "parentRoomId",room.direct_participants IS NOT NULL "directMessage"
           FROM rooms room JOIN memberships member ON member.room_id=room.id
           WHERE member.identity_id=$1 AND member.removed_at IS NULL AND room.archived_at IS NULL
           ORDER BY room.name,room.id`, [authenticatedAgentId]);
        return { rooms: rooms.rows.map(({ parentRoomId, ...room }) => ({ ...room, ...(parentRoomId ? { parentRoomId } : {}) })) } as Output<Name>;
      }
      case 'listReachableCorners':
        return (await daemonCorners(ctx,
          (input as Input<'listReachableCorners'>).roomId,
          authenticatedAgentId,
          (input as Input<'listReachableCorners'>).activeOnly ?? false,
          true,
        )) as Output<Name>;
      case 'listRoomMembers':
        return (await daemonRoomMembers(ctx,
          (input as Input<'listRoomMembers'>).roomId,
        )) as Output<Name>;
      case 'readCornerPullRequest': {
        const { cornerId } = input as Input<'readCornerPullRequest'>;
        await daemonReach(ctx, cornerId, authenticatedAgentId);
        if (!ctx.readPullRequest)
          return { status: 'blocked', blocker: 'GitHub is not configured on this server' } as Output<Name>;
        return (await ctx.readPullRequest(cornerId)) as Output<Name>;
      }
      case 'postCornerMessage':
        return (await daemonPostCornerMessage(ctx,
          input as Input<'postCornerMessage'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getPrChecksStatus':
        if (!ctx.prChecksStatus) throw new Error('GitHub PR checks service unavailable');
        return (await ctx.prChecksStatus(input as Input<'getPrChecksStatus'>)) as Output<Name>;
      case 'approveCornerMerge':
        return (await daemonApproveCornerMerge(ctx,
          input as Input<'approveCornerMerge'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'closeCornerPullRequest':
        return (await daemonCloseCornerPullRequest(ctx,
          input as Input<'closeCornerPullRequest'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'mergeCorner':
        return (await daemonMergeCorner(ctx,
          input as Input<'mergeCorner'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getCornerRestoreState':
        return (await daemonCornerRestore(ctx,
          (input as Input<'getCornerRestoreState'>).cornerId,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'listCornerBriefRevisions':
        return (await daemonListCornerBriefRevisions(ctx,
          input as Input<'listCornerBriefRevisions'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'reviseCornerBrief':
        return (await daemonReviseCornerBrief(ctx,
          input as Input<'reviseCornerBrief'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getRoomRepositoryState': {
        const owner = await daemonRepositoryOnboardingRequester(ctx, authenticatedAgentId, scopedRoom, candidate);
        return { ...(await daemonRepository(ctx,
          (input as Input<'getRoomRepositoryState'>).roomId,
          authenticatedAgentId,
        )), ...(owner ? { repositoryOnboarding: true } : {}) } as Output<Name>;
      }
      case 'noteEmptyRoomRepository':
        return noteEmptyRoomRepositoryOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'dispatchRoomWorkflow': {
        if (!ctx.github) throw new Error('GitHub workflow service unavailable');
        const release = input as Input<'dispatchRoomWorkflow'>;
        return await productionReleaseDispatch(ctx.database, authenticatedAgentId, release,
          inputs => ctx.github!.dispatchProductionRelease(release.roomId, inputs)) as Output<Name>;
      }
      case 'getRoomGitHubToken':
        return getRoomGitHubTokenOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'getRoomTargetBranch':
        return (await daemonTargetBranch(ctx,
          (input as Input<'getRoomTargetBranch'>).roomId,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getIdentitySuccession':
        return (await daemonIdentitySuccession(ctx,
          (input as Input<'getIdentitySuccession'>).identityId,
        )) as Output<Name>;
      case 'getAgentConfiguration':
        return (await daemonConfiguration(ctx,
          authenticatedAgentId,
          (input as Input<'getAgentConfiguration'>).roomId,
          candidate,
        )) as Output<Name>;
      case 'getAgentPresence':
        return (await daemonPresence(ctx,
          input as Input<'getAgentPresence'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getRequestCompletion':
        return (await daemonCompletion(ctx,
          input as Input<'getRequestCompletion'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'markAgentTurnSilent':
      case 'postRoomMessage':
        return markAgentTurnSilentOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'reactToRoomMessage':
        return (await daemonReactToRoomMessage(ctx,
          input as Input<'reactToRoomMessage'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentAttachment':
        return (await daemonPostAgentAttachment(ctx,
          input as Input<'postAgentAttachment'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentDraft':
        return (await daemonLiveOutput(ctx,
          'draft',
          input as Input<'postAgentDraft'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentThought':
        return (await daemonLiveOutput(ctx,
          'thought',
          input as Input<'postAgentThought'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'retractAgentLiveOutput':
        return (await daemonRetract(ctx,
          input as Input<'retractAgentLiveOutput'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentTurnReceipt':
        return (await daemonTurnReceipt(ctx,
          input as Input<'postAgentTurnReceipt'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postBackgroundToolCompletion':
        return postBackgroundToolCompletionOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'postAgentActivity':
        return (await daemonActivity(ctx,
          input as Input<'postAgentActivity'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postSquireApproval':
        return (await daemonSquireApproval(ctx,
          input as Input<'postSquireApproval'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postComputerSession': {
        const share = input as Input<'postComputerSession'>;
        return (await createComputerSession(ctx.database, ctx.live, {
          roomId: share.roomId,
          agentId: authenticatedAgentId,
          sessionId: share.sessionId,
          upstreamUrl: share.upstreamUrl,
          title: share.title,
          expiresAt: share.expiresAt,
        })) as Output<Name>;
      }
      case 'endComputerSession':
        return endComputerSessionOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'refreshComputerSession':
        return (await refreshComputerSession(ctx.database, {
          ...input as Input<'refreshComputerSession'>, agentId: authenticatedAgentId,
        })) as Output<Name>;
      case 'postSquireLoginWall':
        return (await daemonSquireLoginWall(ctx,
          input as Input<'postSquireLoginWall'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postSquireApprovalDecision':
        return (await daemonSquireApprovalDecision(ctx,
          input as Input<'postSquireApprovalDecision'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postPermissionRequest':
        return (await daemonPermissionRequest(ctx,
          input as Input<'postPermissionRequest'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postPermissionExecution':
        return (await daemonPermissionExecution(ctx,
          input as Input<'postPermissionExecution'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentToolMandate':
        return (await daemonPostMandate(ctx,
          input as Input<'postAgentToolMandate'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getAgentAvatar': {
        const row = (
          await ctx.database.query<{ drawing: unknown; soul: unknown }>(
            `SELECT portrait.drawing,agent.soul FROM agents agent
           LEFT JOIN agent_avatars portrait ON portrait.agent_id=agent.agent_id WHERE agent.agent_id=$1`,
            [authenticatedAgentId],
          )
        ).rows[0];
        return { drawing: row?.drawing ?? null, soul: row?.soul ?? null } as Output<Name>;
      }
      case 'postAgentAvatar':
        return (await daemonAgentAvatar(ctx,
          input as Input<'postAgentAvatar'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getAgentUsage':
        return ((await agentUsage(ctx.database, authenticatedAgentId)) ?? null) as Output<Name>;
      case 'publishAgentUsageAccount': {
        if(!helperUsageEnabled())throw new Error('usage_account_unavailable');
        const published=await publishUsageAccount(ctx.database,authenticatedAgentId,input as Input<'publishAgentUsageAccount'>);
        return {...daemonWriteResult(ctx),...published} as Output<Name>;
      }
      case 'attachAgentUsageAccount': {
        if(!helperUsageEnabled())throw new Error('usage_account_unavailable');
        await attachUsageAccount(ctx.database,authenticatedAgentId,input as Input<'attachAgentUsageAccount'>);
        return daemonWriteResult(ctx) as Output<Name>;
      }
      case 'postAgentUsage': {
        const { usage,usageSource } = input as Input<'postAgentUsage'>;
        const accepted=await saveAgentUsage(ctx.database, authenticatedAgentId, usage,usageSource);
        if(!accepted)return daemonWriteResult(ctx) as Output<Name>;
        const outcome = postedRefreshOutcome(usage);
        if (outcome) await notifyUsageRefreshResult(ctx.database, authenticatedAgentId, outcome);
        return daemonWriteResult(ctx) as Output<Name>;
      }
      case 'answerUsageRefresh': {
        const answer = input as Input<'answerUsageRefresh'>;
        const outcome = readUsageRefreshOutcome(answer.outcome);
        if (!outcome || typeof answer.requestId !== 'string') throw new Error('invalid usage refresh answer');
        await notifyUsageRefreshResult(ctx.database, authenticatedAgentId, outcome, answer.requestId);
        return undefined as Output<Name>;
      }
      case 'postAgentCommands':
        return (await daemonCommands(ctx,
          input as Input<'postAgentCommands'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentModelCatalog':
        return (await daemonModelCatalog(ctx,
          input as Input<'postAgentModelCatalog'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentMachineReport':
        return (await daemonMachineReport(ctx,
          input as Input<'postAgentMachineReport'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getConnectorAssignments':
        return (await daemonConnectorAssignments(ctx, authenticatedAgentId)) as Output<Name>;
      case 'completeProviderWebhookAssignment':
        await completeProviderWebhookAssignment(ctx.database, authenticatedAgentId,
          input as Input<'completeProviderWebhookAssignment'>);
        return daemonWriteResult(ctx) as Output<Name>;
      case 'reportAgentSignIn':
        await reportAgentSignIn(
          ctx.database,
          authenticatedAgentId,
          input as Input<'reportAgentSignIn'>,
        );
        return undefined as Output<Name>;
      case 'getGoogleOAuthGrant':
      case 'getRoomGoogleGrant':
        return { status: 'pending' } as Output<Name>;
      case 'createLinkSpendRequest':
        return createLinkSpendRequestOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'retrieveLinkSpendRequest':
        return retrieveLinkSpendRequestOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'beginRegistryMcpOAuth': {
        if (!ctx.registryMcpOAuth) throw new Error('Registry MCP OAuth is unavailable');
        return (await ctx.registryMcpOAuth.begin(
          (input as Input<'beginRegistryMcpOAuth'>).connectorId,
          authenticatedAgentId,
        )) as Output<Name>;
      }
      case 'claimRegistryMcpOAuthCode': {
        if (!ctx.registryMcpOAuth) throw new Error('Registry MCP OAuth is unavailable');
        const request = input as Input<'claimRegistryMcpOAuthCode'>;
        return (await ctx.registryMcpOAuth.claim(
          request.connectorId,
          request.state,
          authenticatedAgentId,
        )) as Output<Name>;
      }
      case 'installConnector':
        return (await daemonConnectorInstall(ctx,
          input as Input<'installConnector'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postConnectorStatus':
        return (await daemonConnectorStatusReport(ctx,
          input as Input<'postConnectorStatus'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'forgetSquireSignIn': {
        const { url, siteUrl } = input as Input<'forgetSquireSignIn'>;
        // An OAuth redirect lands on the identity provider; the app is the site the session was sent to.
        for (const target of [url, siteUrl])
          if (typeof target === 'string') await forgetSquireSignIn(ctx.database, authenticatedAgentId, { url: target });
        return daemonWriteResult(ctx) as Output<Name>;
      }
      case 'postConnectorVault':
        return (await daemonConnectorVaultReport(ctx,
          input as Input<'postConnectorVault'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getConnectorStatus':
        return (await daemonConnectorStatusView(ctx,
          authenticatedAgentId,
          (input as Input<'getConnectorStatus'>).connectorId,
        )) as Output<Name>;
      case 'getConnectorVaultList':
        return (await daemonConnectorVaultList(ctx, authenticatedAgentId)) as Output<Name>;
      case 'getConnectionDetail':
        return (await daemonConnectionDetail(ctx,
          input as Input<'getConnectionDetail'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'revokeConnectionGrants':
        return (await daemonConnectionGrantRevoke(ctx,
          input as Input<'revokeConnectionGrants'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postConnectionUsage':
        return (await daemonConnectionUsage(ctx,
          input as Input<'postConnectionUsage'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postCornerRemoteState':
        return (await daemonCornerRemote(ctx,
          input as Input<'postCornerRemoteState'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postCornerPlan':
        return (await daemonCornerPlan(ctx,
          input as Input<'postCornerPlan'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'renameCorner':
        return (await daemonRenameCorner(ctx,
          input as Input<'renameCorner'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postTargetBranchProposal':
        return (await daemonTargetProposal(ctx,
          input as Input<'postTargetBranchProposal'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'requestAgentGrant':
        return (await daemonRequestAgentGrant(ctx,
          input as Input<'requestAgentGrant'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postStarterVideoPreview': {
        const request = input as Input<'postStarterVideoPreview'>;
        await daemonAccess(ctx, request.roomId, authenticatedAgentId);
        const result = await postStarterVideoPreview(ctx.database, ctx.objects, { ...request, agentId: authenticatedAgentId });
        ctx.live.publish({ type: 'invalidate', roomId: request.roomId, reason: 'message' });
        return result as Output<Name>;
      }
      case 'postStarterWelcome':
        return postStarterWelcomeOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'postRoomInvite': {
        const request = input as Input<'postRoomInvite'>;
        await daemonAccess(ctx, request.roomId, authenticatedAgentId);
        const requester = await daemonGrantRequester(ctx);
        const personId = requester.kind === 'human' ? requester.id : (await ctx.database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`, [authenticatedAgentId])).rows[0]?.owner_id;
        if (!personId) throw new Error('Invite requester unavailable');
        const result = await ctx.database.transaction(db => postStarterInviteOffer(db, request.roomId, authenticatedAgentId, personId, 'https://usebeeline.app'));
        ctx.live.publish({ type: 'invalidate', roomId: request.roomId, reason: 'message' });
        return result as Output<Name>;
      }
      case 'postRepositoryOnboarding':
        return postRepositoryOnboardingOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'askRoomChoice':
        return (await daemonAskRoomChoice(ctx,
          input as Input<'askRoomChoice'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'openRoomPoll':
        return (await daemonOpenRoomPoll(ctx,
          input as Input<'openRoomPoll'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'listAgentGrants':
        return (await daemonListAgentGrants(ctx,
          authenticatedAgentId,
          (input as Input<'listAgentGrants'>).roomId,
        )) as Output<Name>;
      case 'consumeAgentGrant':
        return (await daemonConsumeAgentGrant(ctx,
          input as Input<'consumeAgentGrant'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'listAgentGrantRequests':
        return (await daemonListAgentGrantRequests(ctx,
          authenticatedAgentId,
          (input as Input<'listAgentGrantRequests'>).roomId,
        )) as Output<Name>;
      case 'listTurnAgentGrants': {
        const requester = await daemonGrantRequester(ctx);
        const roomId = (input as Input<'listTurnAgentGrants'>).roomId;
        const listed = await daemonListAgentGrants(ctx, authenticatedAgentId, roomId);
        return {
          grants: listed.grants.filter(
            (grant) => grant.kind === 'command' ||
              (grant.roomId === roomId && grant.requestedBy === requester.id),
          ),
        } as Output<Name>;
      }
      case 'authorizeResourceCall':
        return (await daemonAuthorizeResource(ctx,
          input as Input<'authorizeResourceCall'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'authorizeRepositoryCall':
      case 'authorizeHostCall':
        // Old helpers still ask before admitting a corner turn. Turn authority
        // is checked above; corner entry itself needs no grant or card.
        return { allowed: true } as Output<Name>;
      case 'authorizeSquireCall':
        return (await daemonAuthorizeSquireCall(ctx,
          input as Input<'authorizeSquireCall'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'readAgentWorkbench':
        return (await daemonAgentWorkbench(ctx,
          input as Input<'readAgentWorkbench'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'searchMcpRegistry':
        return (await daemonSearchMcpRegistry(ctx, input as Input<'searchMcpRegistry'>)) as Output<Name>;
      case 'findConnectors':
        return findConnectorsOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'connectMcpServer':
        return (await daemonConnectMcpServer(ctx,
          input as Input<'connectMcpServer'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'connectApp':
        return (await daemonConnectAppFrontDoor(ctx,
          input as Input<'connectApp'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'connect':
        return (await daemonConnectService(ctx, input as Input<'connect'>, authenticatedAgentId)) as Output<Name>;
      case 'listAppTools':
        return (await daemonListAppTools(ctx, input as Input<'listAppTools'>,
          authenticatedAgentId)) as Output<Name>;
      case 'executeAppTool':
        return (await daemonExecuteAppTool(ctx, input as Input<'executeAppTool'>,
          authenticatedAgentId)) as Output<Name>;
      case 'postVaultSaveCard':
        return postVaultSaveCardOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'offerConnector':
        return (await daemonOfferConnector(ctx,
          input as Input<'offerConnector'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'setCornerHold':
        return setCornerHoldOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'orderCornerMerge':
        return orderCornerMergeOperation(ctx, name, input, authenticatedAgentId, turnOwner, modelClaim, candidate, scopedRoom, ownedIntent);
      case 'createCorner':
        return (await daemonCreateCorner(ctx,
          input as Input<'createCorner'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'archiveCorner':
        return (await daemonArchiveCorner(ctx,
          input as Input<'archiveCorner'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'ensureAgentMembership':
        return (await daemonEnsureMembership(ctx,
          input as Input<'ensureAgentMembership'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getWalletToolState':
        return (await agentWalletTool(
          ctx.database,
          'state',
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getWalletToolBalance':
        return (await agentWalletTool(
          ctx.database,
          'balance',
          authenticatedAgentId,
          input as Input<'getWalletToolBalance'>,
        )) as Output<Name>;
      case 'getWalletToolChains':
        return (await agentWalletTool(
          ctx.database,
          'chains',
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getWalletToolHistory':
        return (await agentWalletTool(
          ctx.database,
          'history',
          authenticatedAgentId,
          input as Input<'getWalletToolHistory'>,
        )) as Output<Name>;
      case 'getWalletToolQuote':
        return (await agentWalletTool(
          ctx.database,
          'quote',
          authenticatedAgentId,
          input as Input<'getWalletToolQuote'>,
        )) as Output<Name>;
      case 'walletPay':
        return (await agentWalletTool(
          ctx.database,
          'pay',
          authenticatedAgentId,
          input as Input<'walletPay'>,
        )) as Output<Name>;
      case 'walletSignTypedData':
        return (await agentSignTypedData(
          ctx.database,
          authenticatedAgentId,
          input as Input<'walletSignTypedData'>,
        )) as Output<Name>;
      case 'walletSwap':
        return (await agentWalletTool(
          ctx.database,
          'swap',
          authenticatedAgentId,
          input as Input<'walletSwap'>,
        )) as Output<Name>;
      case 'walletContractCall':
        return (await agentContractCall(
          ctx.database,
          authenticatedAgentId,
          input as Input<'walletContractCall'>,
        )) as Output<Name>;
      // The feedback loop (`feedback.ts`). Any agent may report from its own
      // turn; only a configured System sender's agent may close the loop.
      case 'reportFeedback':
        if (!ctx.commandTransaction || !ctx.authorizedCommand)
          throw new Error('feedback reports require an active command');
        return (await reportAgentFeedback(
          ctx.database,
          ctx.authorizedCommand,
          authenticatedAgentId,
          input as Input<'reportFeedback'>,
        )) as Output<Name>;
      case 'sendOperatorSystemDm':
        return (await sendOperatorSystemDm(ctx.database, ctx.feedback.config, ctx.authorizedCommand,
          authenticatedAgentId, input as Input<'sendOperatorSystemDm'>)) as Output<Name>;
      case 'readOperatorSystemDm':
        return (await readOperatorSystemDm(ctx.database, ctx.feedback.config, ctx.authorizedCommand,
          authenticatedAgentId, (input as Input<'readOperatorSystemDm'>).sendId)) as Output<Name>;
      case 'notifyFeedbackFixed':
        return (await notifyFeedbackFixed(
          ctx.database,
          ctx.feedback,
          ctx.authorizedCommand,
          authenticatedAgentId,
          input as Input<'notifyFeedbackFixed'>,
        )) as Output<Name>;
      default:
        throw new CommandRefusalError(`unsupported daemon operation: ${String(name)}; use order and report`, 410);
    }
}
