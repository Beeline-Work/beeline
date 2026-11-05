import { prepareMentionReplyInput } from '../owed-mentions.js';
import { setMcpMemberWebhook, McpToolError } from '../rooms-mcp-members.js';
import { disconnectMcp } from '../rooms-mcp-connections.js';
import { CommandRefusalError } from '../command-refusal.js';
import { requestUsageRefresh } from '../agent-usage.js';
import { FIRST_PARTY_INTEGRATIONS } from '../first-party-integrations.js';
import { squireWorkStatus } from '../squire-machine.js';
import { webhookToken, requireWebhookAdmin, requireScheduledWorkManager, requireScheduledWorkReader } from '../subscription-webhooks.js';
import { listRoomSubscriptions, deleteRoomSubscription } from '../agent-subscriptions.js';
import { startWorkflow } from '../workflow-runs.js';
import { humanRoomMember } from '../workflow-admin.js';
import { setCornerHold } from '../corner-holds.js';
import { computerViewToken, endComputerSessionByViewer, handBackComputerSession } from '../computer-session.js';
import { beginComposioAppSignIn } from '../app-connections.js';
import { webPushPublicKey } from '../web-push.js';
import { type PhoneOperationMap } from '@beeline/api-contract/phone';
import { reportMessageIssue } from '../feedback.js';
import { markNeedsYouSeen } from '../needs-you.js';
import { REVIEW_IDENTITY_ID } from '../review-access.js';
import { recordOwnerGitHubSelection } from '../app-connections.js';
import type { ReadWalletHistoryInput } from '@beeline/api-contract/wallet';
import { createWallet, readWallet, sendFromWallet, grantWalletDelegation, revokeWalletDelegation, walletHistory } from '../wallet.js';
import { listRoomWorkflowRuns } from '../workflow-run-views.js';
import { answerStarPrompt, readStarPrompt } from '../github-star-prompt.js';
import type { PhoneContext } from './context.js';
import { Input, Output } from './types.js';
import { REVIEW_LOCKED_OPERATIONS, SPECTATOR_READ_OPERATIONS } from './operation-names.js';
import { REVIEW_IDENTITY_MESSAGE, messageId, token, AGENT_OWNER_AUTHORITY_MESSAGE } from './values.js';
import { phoneReadScheduledWork, phoneListRoomSchedules, phoneDeleteRoomSchedule, phoneListRoomWorkflowRuns, phoneReadWorkflowRun } from './schedules.js';
import { phoneReadWelcomeCards, phoneCompleteWelcomeCards } from './live-reads.js';
import { phoneSendMessage, phoneObserveSentMessage, phoneSendReply, phoneReactToMessage, phoneDeleteRoomMessage, phoneSetMessageBookmark, phoneClearMessageBookmarks, phoneUploadMedia } from './messages.js';
import { phoneBeginAgentSignIn, phoneDecideAgentGrant, phoneRevokeAgentGrant, phoneCreatePairing, phoneUpdateAgentSoul, phoneUpdateAgentModel, phoneRefreshAgentModelCatalog, phoneCompleteAgentSignIn } from './agent-configuration.js';
import { phoneListMessageBookmarks, phoneReadNeedsYou, phoneReadTray, phoneCountNeedsYou, phoneClearNeedsYou, phoneClearNeedsYouSection } from './tray.js';
import { phoneHasRoomAccess, phoneRequireWorkspaceAgent, phoneRequireWorkspaceMember, phoneRequireHumanRoomWorkspaceManager, phoneRequireGitHub } from './access.js';
import { phoneCancelAgentTurn, phoneRequestCornerClose, phoneDecideApprovalCard, phoneDecidePermission } from './approvals.js';
import { phoneCreateHumanCorner, phoneCreateRoom, phoneUpdateRoom, phoneDeleteRoom, phoneLeaveRoom, phoneCloseChat, phoneReopenChat, phoneAddRoomMember, phoneRemoveRoomMember } from './room-writes.js';
import { phoneAcceptConnectorOffer } from './connector-offers.js';
import { phoneCreateRoomPoll, phoneActOnRepositoryCard, phoneAnswerChoice, phoneSkipChoice } from './room-actions.js';
import { phoneCreateWorkspace, phoneUpdateWorkspace, phoneLeaveWorkspace, phoneDeleteWorkspace } from './workspace-writes.js';
import { phoneAddWorkspaceMember, phoneRemoveWorkspaceMember, phoneResolveDirectMessage, phoneCreateInvite, phoneRedeemInvite } from './members-invites.js';
import { phoneReadInvite, phoneClaimAgentPairing } from './pairing.js';
import { phoneReadAgent } from './agent-reads.js';
import { phoneUpdateAgentYolo, phoneUpdateAgentAccessPolicy, phoneRemoveAgent } from './agent-removal.js';
import { phoneUpdateProfile, phoneUpdateFace, phoneUpdateRoomPushState, phoneUpdatePushLevel, phoneDeleteAccount } from './account-profile.js';
import { phoneManagedIdentity, phoneSetRepository, phoneSetTargetBranch, phoneRemoveRepositoryBinding, phoneIdentityRecovery, phoneAdoptGitHubHandle, phoneClaimManagedHandle, phoneListRepositories, phoneRepositoryAccess } from './repositories.js';
import { identity } from './read-projection.js';
import { phoneReadWorkspaces, phoneReadWorkspace } from './workspaces.js';
import { phoneReadWorkbench, phoneReadConnectorInstall } from './workbench-reads.js';
import { phoneRegisterPush, phoneReportUpdate } from './push-updates.js';
import { phoneSearchWorkbenchApps, phoneViewerWorkbenchWorkspace } from './workbench-catalog.js';
import { phonePairConnector, phoneUnpairConnector, phoneConnectWorkbenchApp, phoneCompleteAppSignIn, phoneDisconnectWorkbenchApp } from './connections.js';
import { phoneReadConnectionDetail, phoneRevokeConnectionGrants } from './connection-reads.js';



  export async function phoneExecuteOperation<Name extends keyof PhoneOperationMap>(ctx: PhoneContext, 
    name: Name,
    input: Input<Name>,
    viewerId: string,
    sourceClient?: { id: string; name: string },
    /** Sign-in family of this device session. Absent when the caller is not one. */
    familyId?: string,
    /** Transport receipts may precede tracked observation; direct callers retain full completion. */
    deferPostCommitObservation = false,
  ): Promise<Output<Name>> {
    if (viewerId === REVIEW_IDENTITY_ID && REVIEW_LOCKED_OPERATIONS.has(name))
      throw new Error(REVIEW_IDENTITY_MESSAGE);
    if (name === 'openComputerSession') {
      const access = await computerViewToken(ctx.database, (input as Input<'openComputerSession'>).id, viewerId);
      if (!access) throw new Error('computer session access denied');
      return { access } as Output<Name>;
    }
    if (name === 'handbackComputerSession') {
      await handBackComputerSession(ctx.database, (input as Input<'handbackComputerSession'>).id, viewerId);
      return undefined as Output<Name>;
    }
    if (name === 'endComputerSession') {
      await endComputerSessionByViewer(ctx.database, ctx.live, (input as Input<'endComputerSession'>).id, viewerId);
      return undefined as Output<Name>;
    }
    const scope = input as { workspaceId?: string; roomId?: string };
    // The spectator guard below casts nonempty scope ids to uuid. Wallet
    // grants need a plain input error before that generic SQL gate runs.
    if (
      name === 'grantWalletDelegation' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        scope.workspaceId ?? '',
      )
    )
      throw new Error('valid Workspace ID required');
    if ((scope.workspaceId || scope.roomId) && !SPECTATOR_READ_OPERATIONS.has(name) && name !== 'sendRoomMessage') {
      const spectator = await ctx.database.query(
        `SELECT 1 FROM memberships m WHERE m.identity_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
         AND m.role='spectator' AND (m.workspace_id=$2::uuid OR m.workspace_id=(SELECT workspace_id FROM rooms WHERE id=$3::uuid))`,
        [viewerId, scope.workspaceId ?? null, scope.roomId ?? null],
      );
      if (spectator.rowCount) throw new Error('spectator access is read-only (access denied)');
    }
    switch (name) {
      case 'revealWebhookToken':
      case 'rotateWebhookToken': {
        const i = input as Input<'revealWebhookToken'>;
        return await webhookToken(ctx.database, i.roomId, i.subscriptionId, viewerId,
          name === 'rotateWebhookToken') as Output<Name>;
      }
      case 'listRoomSubscriptions': {
        const roomId = (input as Input<'listRoomSubscriptions'>).roomId;
        await requireScheduledWorkReader(ctx.database, roomId, viewerId);
        return await listRoomSubscriptions(ctx.database, roomId) as Output<Name>;
      }
      case 'readScheduledWork':
        return (await phoneReadScheduledWork(ctx, 
          (input as Input<'readScheduledWork'>).roomId, viewerId,
        )) as Output<Name>;
      case 'deleteRoomSubscription': {
        const i = input as Input<'deleteRoomSubscription'>;
        await requireScheduledWorkManager(ctx.database, i.roomId, viewerId);
        const webhook = await ctx.database.query(`SELECT 1 FROM agent_subscriptions WHERE id::text=$1 AND source='webhook'`, [i.subscriptionId]);
        if (webhook.rowCount) await requireWebhookAdmin(ctx.database, i.roomId, viewerId);
        await deleteRoomSubscription(ctx.database, i.roomId, i.subscriptionId, ctx.composio);
        return undefined as Output<Name>;
      }
      case 'readWelcomeCards':
        return (await phoneReadWelcomeCards(ctx, viewerId)) as Output<Name>;
      case 'completeWelcomeCards':
        return (await phoneCompleteWelcomeCards(ctx, viewerId)) as Output<Name>;
      case 'readStarPrompt':
        return (await readStarPrompt(ctx.database, viewerId, ctx.github)) as Output<Name>;
      case 'answerStarPrompt':
        return (await answerStarPrompt(
          ctx.database,
          viewerId,
          input as Input<'answerStarPrompt'>,
          ctx.github,
        )) as Output<Name>;
      case 'sendRoomMessage': {
        const sent = await phoneSendMessage(ctx, input as Input<'sendRoomMessage'>, viewerId, sourceClient, familyId);
        phoneBeginAgentSignIn(ctx, input as Input<'sendRoomMessage'>, sent.messageId);
        await phoneObserveSentMessage(ctx, (input as Input<'sendRoomMessage'>).roomId, viewerId, deferPostCommitObservation);
        return sent as Output<Name>;
      }
      case 'sendRoomReply': {
        await prepareMentionReplyInput(ctx.database, viewerId, input as Input<'sendRoomReply'>);
        const sent = await phoneSendReply(ctx, input as Input<'sendRoomReply'>, viewerId, sourceClient, familyId);
        phoneBeginAgentSignIn(ctx, input as Input<'sendRoomReply'>, sent.messageId);
        await phoneObserveSentMessage(ctx, (input as Input<'sendRoomReply'>).roomId, viewerId, deferPostCommitObservation);
        return sent as Output<Name>;
      }
      case 'reactToMessage':
        return (await phoneReactToMessage(ctx, input as Input<'reactToMessage'>, viewerId)) as Output<Name>;
      case 'deleteRoomMessage':
        return (await phoneDeleteRoomMessage(ctx, input as Input<'deleteRoomMessage'>, viewerId)) as Output<Name>;
      case 'reportMessageIssue':
        return (await reportMessageIssue(
          ctx.database,
          input as Input<'reportMessageIssue'>,
          viewerId,
          sourceClient,
          familyId,
        )) as Output<Name>;
      case 'setMessageBookmark':
        return (await phoneSetMessageBookmark(ctx, 
          input as Input<'setMessageBookmark'>,
          viewerId,
        )) as Output<Name>;
      case 'clearMessageBookmarks':
        await phoneClearMessageBookmarks(ctx, input as Input<'clearMessageBookmarks'>, viewerId);
        return undefined as Output<Name>;
      case 'listMessageBookmarks':
        return (await phoneListMessageBookmarks(ctx, 
          input as Input<'listMessageBookmarks'>,
          viewerId,
        )) as Output<Name>;
      case 'readNeedsYou':
        return (await phoneReadNeedsYou(ctx, input as Input<'readNeedsYou'>, viewerId)) as Output<Name>;
      case 'readTray':
        return (await phoneReadTray(ctx, input as Input<'readTray'>, viewerId)) as Output<Name>;
      case 'countNeedsYou':
        return (await phoneCountNeedsYou(ctx, 
          input as Input<'countNeedsYou'>,
          viewerId,
        )) as Output<Name>;
      case 'markNeedsYouSeen': {
        const request = input as Input<'markNeedsYouSeen'>;
        return await markNeedsYouSeen(ctx.database, request.workspaceId, viewerId, request.messageIds) as Output<Name>;
      }
      case 'clearNeedsYou':
        await phoneClearNeedsYou(ctx, input as Input<'clearNeedsYou'>, viewerId);
        return undefined as Output<Name>;
      case 'clearNeedsYouSection':
        await phoneClearNeedsYouSection(ctx, input as Input<'clearNeedsYouSection'>, viewerId);
        return undefined as Output<Name>;
      case 'listRoomSchedules':
        return (await phoneListRoomSchedules(ctx, 
          (input as Input<'listRoomSchedules'>).roomId,
          viewerId,
        )) as Output<Name>;
      case 'deleteRoomSchedule':
        await phoneDeleteRoomSchedule(ctx, input as Input<'deleteRoomSchedule'>, viewerId);
        return undefined as Output<Name>;
      case 'listRoomWorkflowRuns':
        return (await phoneListRoomWorkflowRuns(ctx, 
          (input as Input<'listRoomWorkflowRuns'>).roomId,
          viewerId,
        )) as Output<Name>;
      case 'listWorkflowDefinitions': {
        const request = input as Input<'listWorkflowDefinitions'>;
        if (!(await phoneHasRoomAccess(ctx, request.roomId, viewerId)))
          throw new Error('room access denied');
        const definitions = await ctx.database.query<{ slug: string }>(
          `SELECT skill.slug FROM workspace_skills skill
              JOIN rooms room ON room.workspace_id=skill.workspace_id WHERE room.id=$1 AND skill.kind='workflow' AND skill.state='active'
              ORDER BY skill.slug`,
          [request.roomId],
        );
        return {
          workflows: definitions.rows.map((row) => ({ name: row.slug })),
        } as Output<Name>;
      }
      case 'readWorkflowDefinition': {
        const request = input as Input<'readWorkflowDefinition'>;
        if (!(await phoneHasRoomAccess(ctx, request.roomId, viewerId)))
          throw new Error('room access denied');
        const row = (
          await ctx.database.query<{ markdown: string }>(
            `SELECT version.markdown FROM workspace_skills skill
              JOIN rooms room ON room.workspace_id=skill.workspace_id
              JOIN workspace_skill_versions version ON version.skill_id=skill.id AND version.version=skill.current_version
              WHERE room.id=$1 AND skill.slug=$2 AND skill.kind='workflow'`,
            [request.roomId, request.name],
          )
        ).rows[0];
        if (!row) throw new Error('workflow is unavailable');
        return {
          contract: JSON.parse(row.markdown),
          runs: (
            await listRoomWorkflowRuns(
              ctx.database,
              request.roomId,
              viewerId,
              request.name,
              ctx.publicOrigin,
            )
          ).workflows,
        } as Output<Name>;
      }
      case 'startOwnedWorkflow': {
        const request = input as Input<'startOwnedWorkflow'>;
        // Starting a run is open to anyone in the Room; it is attributed to them.
        if (!(await humanRoomMember(ctx.database, request.roomId, viewerId)))
          throw new Error('room access denied: only a person in this Room can start a run here');
        return (await startWorkflow(
          ctx.database,
          { room_id: request.roomId, agent_id: viewerId },
          request,
        )) as Output<Name>;
      }
      case 'readWorkflowRun':
        return (await phoneReadWorkflowRun(ctx, 
          input as Input<'readWorkflowRun'>,
          viewerId,
        )) as Output<Name>;
      case 'cancelAgentTurn':
        await phoneCancelAgentTurn(ctx, input as Input<'cancelAgentTurn'>, viewerId);
        return undefined as Output<Name>;
      case 'createHumanCorner':
        return (await phoneCreateHumanCorner(ctx, 
          input as Input<'createHumanCorner'>,
          viewerId,
        )) as Output<Name>;
      case 'setCornerHold': {
        const hold = input as Input<'setCornerHold'>;
        const result = await ctx.database.transaction(db => setCornerHold(db, hold, viewerId));
        await ctx.github?.reconcileQueuedCorners(hold.cornerId);
        return result as Output<Name>;
      }
      case 'setCornerLocked': {
        const value = input as Input<'setCornerLocked'>;
        if (typeof value.locked !== 'boolean') throw new Error('locked must be a boolean');
        await phoneRequestCornerClose(ctx, value.roomId, viewerId, value.locked);
        return undefined as Output<Name>;
      }
      case 'requestCornerClose':
        await phoneRequestCornerClose(ctx, (input as Input<'requestCornerClose'>).roomId, viewerId);
        return undefined as Output<Name>;
      case 'decideApprovalCard':
        return await phoneDecideApprovalCard(ctx, input as Input<'decideApprovalCard'>, viewerId) as Output<Name>;
      case 'decideWritePermission':
        return (await phoneDecidePermission(ctx, 
          input as Input<'decideWritePermission'>,
          viewerId,
        )) as Output<Name>;
      case 'decideAgentGrant':
        return (await phoneDecideAgentGrant(ctx, 
          input as Input<'decideAgentGrant'>,
          viewerId,
        )) as Output<Name>;
      case 'revokeAgentGrant':
        return (await phoneRevokeAgentGrant(ctx, 
          input as Input<'revokeAgentGrant'>,
          viewerId,
        )) as Output<Name>;
      case 'acceptConnectorOffer':
        return (await phoneAcceptConnectorOffer(ctx, 
          input as Input<'acceptConnectorOffer'>,
          viewerId,
        )) as Output<Name>;
      case 'createRoomPoll':
        return (await phoneCreateRoomPoll(ctx, 
          input as Input<'createRoomPoll'>,
          viewerId,
        )) as Output<Name>;
      case 'actOnRepositoryCard':
        return await phoneActOnRepositoryCard(ctx, input as Input<'actOnRepositoryCard'>, viewerId) as Output<Name>;
      case 'answerChoice':
        return (await phoneAnswerChoice(ctx, input as Input<'answerChoice'>, viewerId)) as Output<Name>;
      case 'skipChoice':
        return (await phoneSkipChoice(ctx, input as Input<'skipChoice'>, viewerId)) as Output<Name>;
      case 'createWorkspace':
        return (await phoneCreateWorkspace(ctx, 
          input as Input<'createWorkspace'>,
          viewerId,
        )) as Output<Name>;
      case 'updateWorkspace':
        await phoneUpdateWorkspace(ctx, input as Input<'updateWorkspace'>, viewerId);
        return undefined as Output<Name>;
      case 'leaveWorkspace':
        await phoneLeaveWorkspace(ctx, input as Input<'leaveWorkspace'>, viewerId);
        return undefined as Output<Name>;
      case 'deleteWorkspace':
        await phoneDeleteWorkspace(ctx, input as Input<'deleteWorkspace'>, viewerId);
        return undefined as Output<Name>;
      case 'addWorkspaceMember':
        return (await phoneAddWorkspaceMember(ctx, 
          input as Input<'addWorkspaceMember'>,
          viewerId,
        )) as Output<Name>;
      case 'removeWorkspaceMember':
        await phoneRemoveWorkspaceMember(ctx, input as Input<'removeWorkspaceMember'>, viewerId);
        return undefined as Output<Name>;
      case 'createRoom':
        return (await phoneCreateRoom(ctx, input as Input<'createRoom'>, viewerId)) as Output<Name>;
      case 'updateRoom':
        await phoneUpdateRoom(ctx, input as Input<'updateRoom'>, viewerId);
        return undefined as Output<Name>;
      case 'deleteRoom':
        await phoneDeleteRoom(ctx, (input as Input<'deleteRoom'>).roomId, viewerId);
        return undefined as Output<Name>;
      case 'leaveRoom':
        await phoneLeaveRoom(ctx, input as Input<'leaveRoom'>, viewerId);
        return undefined as Output<Name>;
      case 'closeChat':
        await phoneCloseChat(ctx, (input as Input<'closeChat'>).roomId, viewerId);
        return undefined as Output<Name>;
      case 'reopenChat':
        await phoneReopenChat(ctx, (input as Input<'reopenChat'>).roomId, viewerId);
        return undefined as Output<Name>;
      case 'addRoomMember':
        return (await phoneAddRoomMember(ctx, 
          input as Input<'addRoomMember'>,
          viewerId,
        )) as Output<Name>;
      case 'removeRoomMember':
        await phoneRemoveRoomMember(ctx, input as Input<'removeRoomMember'>, viewerId);
        return undefined as Output<Name>;
      case 'resolveDirectMessage':
        return (await phoneResolveDirectMessage(ctx, 
          input as Input<'resolveDirectMessage'>,
          viewerId,
        )) as Output<Name>;
      case 'createInvite':
        return (await phoneCreateInvite(ctx, input as Input<'createInvite'>, viewerId)) as Output<Name>;
      case 'resolveInvite': {
        const invite = await phoneReadInvite(ctx, (input as Input<'resolveInvite'>).token, viewerId);
        if (!invite) throw new Error('invite not found');
        return invite as Output<Name>;
      }
      case 'redeemInvite':
        return (await phoneRedeemInvite(ctx, input as Input<'redeemInvite'>, viewerId)) as Output<Name>;
      case 'createAgentPairingCode':
        return (await phoneCreatePairing(ctx, 
          input as Input<'createAgentPairingCode'>,
          viewerId,
        )) as Output<Name>;
      case 'claimAgentPairing': {
        const result = await phoneClaimAgentPairing(ctx, 
          (input as Input<'claimAgentPairing'>).code,
          viewerId,
        );
        if (!result) throw new Error('pairing not found');
        return result as Output<Name>;
      }
      case 'updateAgentSoul':
        await phoneUpdateAgentSoul(ctx, input as Input<'updateAgentSoul'>, viewerId);
        return (await phoneReadAgent(ctx, (input as Input<'updateAgentSoul'>).workspaceId,
          (input as Input<'updateAgentSoul'>).agentId, viewerId)) as Output<Name>;
      case 'updateAgentModelSelection':
        await phoneUpdateAgentModel(ctx, input as Input<'updateAgentModelSelection'>, viewerId);
        return (await phoneReadAgent(ctx, (input as Input<'updateAgentModelSelection'>).workspaceId,
          (input as Input<'updateAgentModelSelection'>).agentId, viewerId)) as Output<Name>;
      case 'refreshAgentUsage': {
        const request = input as Input<'refreshAgentUsage'>;
        await phoneRequireWorkspaceAgent(ctx, request.workspaceId, request.agentId, viewerId);
        return (await requestUsageRefresh(ctx.database, ctx.live, request.agentId)) as Output<Name>;
      }
      case 'refreshAgentModelCatalog':
        await phoneRefreshAgentModelCatalog(ctx, input as Input<'refreshAgentModelCatalog'>, viewerId);
        return undefined as Output<Name>;
      case 'completeAgentSignIn':
        return (await phoneCompleteAgentSignIn(ctx, 
          input as Input<'completeAgentSignIn'>,
          viewerId,
        )) as Output<Name>;
      case 'updateAgentYolo':
        await phoneUpdateAgentYolo(ctx, input as Input<'updateAgentYolo'>, viewerId);
        return (await phoneReadAgent(ctx, (input as Input<'updateAgentYolo'>).workspaceId,
          (input as Input<'updateAgentYolo'>).agentId, viewerId)) as Output<Name>;
      case 'updateAgentWake': {
        const request = input as Input<'updateAgentWake'>;
        await phoneRequireWorkspaceMember(ctx, request.workspaceId, viewerId);
        const member = (await ctx.database.query<{ owner_id: string }>(
          `SELECT m.owner_id FROM rooms_mcp_members m JOIN memberships membership
           ON membership.identity_id=m.member_id AND membership.workspace_id=$2
           AND membership.room_id IS NULL AND membership.removed_at IS NULL
           WHERE m.member_id=$1`, [request.agentId, request.workspaceId])).rows[0];
        if (!member) throw new Error('AI-client member not found');
        if (member.owner_id !== viewerId) throw new Error(AGENT_OWNER_AUTHORITY_MESSAGE);
        if (typeof request.url !== 'string') throw new Error('Webhook URL is invalid');
        try {
          await ctx.database.transaction(async tx => {
            await setMcpMemberWebhook(tx, request.agentId, { url: request.url, secret: request.key });
            await tx.query('UPDATE agents SET updated_at=now() WHERE agent_id=$1', [request.agentId]);
          });
        } catch (error) {
          if (error instanceof McpToolError) {
            if (error.message.includes('not enabled'))
              throw new Error('Auth tokens are not enabled on this server. Ask the operator to configure BEELINE_MCP_WEBHOOK_KEY.');
            throw new Error('Webhook setup is invalid. Use a public HTTPS URL and an auth token without internal spaces or control characters.');
          }
          throw error;
        }
        return (await phoneReadAgent(ctx, request.workspaceId, request.agentId, viewerId)) as Output<Name>;
      }
      case 'updateAgentAccessPolicy':
        await phoneUpdateAgentAccessPolicy(ctx, input as Input<'updateAgentAccessPolicy'>, viewerId);
        return (await phoneReadAgent(ctx, (input as Input<'updateAgentAccessPolicy'>).workspaceId,
          (input as Input<'updateAgentAccessPolicy'>).agentId, viewerId)) as Output<Name>;
      case 'removeAgent':
        await phoneRemoveAgent(ctx, input as Input<'removeAgent'>, viewerId);
        return undefined as Output<Name>;
      case 'updatePersonProfile':
        return (await phoneUpdateProfile(ctx, 
          input as Input<'updatePersonProfile'>,
          viewerId,
        )) as Output<Name>;
      case 'updateIdentityFace':
        await phoneUpdateFace(ctx, input as Input<'updateIdentityFace'>, viewerId);
        return undefined as Output<Name>;
      case 'updateRoomPushState':
        return (await phoneUpdateRoomPushState(ctx, 
          input as Input<'updateRoomPushState'>,
          viewerId,
        )) as Output<Name>;
      case 'updateIdentitySpeakingSpeed': {
        const { speakingSpeed } = input as Input<'updateIdentitySpeakingSpeed'>;
        if (![1.15, 1.3, 1.5].includes(speakingSpeed)) throw new Error('invalid speaking speed');
        const updated = await ctx.database.query(
          `UPDATE identities SET speaking_speed=$2,updated_at=now() WHERE id=$1 AND kind='human'`, [viewerId, speakingSpeed]);
        if (!updated.rowCount) throw new Error('identity not found');
        return await phoneManagedIdentity(ctx, viewerId) as Output<Name>;
      }
      case 'updateIdentityPushLevel':
        return (await phoneUpdatePushLevel(ctx, 
          input as Input<'updateIdentityPushLevel'>,
          viewerId,
        )) as Output<Name>;
      case 'setRoomRepository':
        return (await phoneSetRepository(ctx, 
          input as Input<'setRoomRepository'>,
          viewerId,
        )) as Output<Name>;
      case 'setRoomTargetBranch':
        return (await phoneSetTargetBranch(ctx, 
          input as Input<'setRoomTargetBranch'>,
          viewerId,
        )) as Output<Name>;
      case 'removeRoomRepository':
        await phoneRemoveRepositoryBinding(ctx, input as Input<'removeRoomRepository'>, viewerId);
        return undefined as Output<Name>;
      case 'listRoomWorkflows':
        await phoneRequireHumanRoomWorkspaceManager(ctx, 
          (input as Input<'listRoomWorkflows'>).roomId,
          viewerId,
        );
        return (await phoneRequireGitHub(ctx).listRoomWorkflows(
          (input as Input<'listRoomWorkflows'>).roomId,
        )) as Output<Name>;
      case 'dispatchRoomWorkflow':
        await phoneRequireHumanRoomWorkspaceManager(ctx, 
          (input as Input<'dispatchRoomWorkflow'>).roomId,
          viewerId,
        );
        await phoneRequireGitHub(ctx).dispatchRoomWorkflow(
          (input as Input<'dispatchRoomWorkflow'>).roomId,
          (input as Input<'dispatchRoomWorkflow'>).workflowName,
        );
        return undefined as Output<Name>;
      case 'approveCornerMerge':
        return (await phoneRequireGitHub(ctx).approveCornerMerge(
          viewerId,
          input as Input<'approveCornerMerge'>,
        )) as Output<Name>;
      case 'getAuthCapabilities':
        return { github: Boolean(ctx.github), repositoryOnboarding: true } as Output<Name>;
      case 'getIdentityRecovery':
        return (await phoneIdentityRecovery(ctx, viewerId)) as Output<Name>;
      case 'getManagedIdentity':
        return (await phoneManagedIdentity(ctx, viewerId)) as Output<Name>;
      case 'readIdentitySettings': {
        const [identity, workspaces] = await Promise.all([
          phoneManagedIdentity(ctx, viewerId), phoneReadWorkspaces(ctx, viewerId),
        ]);
        const requested = (input as Input<'readIdentitySettings'>).workspaceId;
        const selected = workspaces.workspaces.find((item) => item.id === requested) ?? workspaces.workspaces[0];
        return {
          identity, workspaces,
          ...(selected ? { workbench: await phoneReadWorkbench(ctx, { workspaceId: selected.id }, viewerId)
            .catch(() => undefined) } : {}),
        } as Output<Name>;
      }
      case 'readAgentProfile': {
        const { workspaceId, agentId } = input as Input<'readAgentProfile'>;
        const [workspace, agent] = await Promise.all([
          phoneReadWorkspace(ctx, workspaceId, viewerId),
          phoneReadAgent(ctx, workspaceId, agentId, viewerId),
        ]);
        if (!workspace || !agent) throw new Error('agent profile not found');
        return { workspace, agent } as Output<Name>;
      }
      case 'adoptGitHubHandle':
        return (await phoneAdoptGitHubHandle(ctx, viewerId)) as Output<Name>;
      case 'claimManagedHandle':
        if (
          !/^[a-z0-9](?:[a-z0-9._-]{0,28}[a-z0-9])?$/.test(
            (input as Input<'claimManagedHandle'>).handle,
          )
        )
          throw new Error('invalid managed handle');
        await phoneClaimManagedHandle(ctx, viewerId, (input as Input<'claimManagedHandle'>).handle);
        return (await phoneManagedIdentity(ctx, viewerId)) as Output<Name>;
      case 'listGitHubRepositories': {
        let githubReconnectNeeded = false;
        if ((input as Input<'listGitHubRepositories'>).refresh) {
          try {
            const outcome = await phoneRequireGitHub(ctx).refresh(viewerId);
            githubReconnectNeeded = Boolean(outcome?.githubReconnectNeeded);
          } catch {
            // Never 503 the repo picker: degrade to stored installations/repositories.
          }
        }
        const result = (await phoneListRepositories(ctx, viewerId)) as Output<Name>;
        return githubReconnectNeeded ? { ...result, githubReconnectNeeded } : result;
      }
      case 'getGitHubRepositoryAccess':
        return (await phoneRepositoryAccess(ctx, 
          (input as Input<'getGitHubRepositoryAccess'>).fullName,
          viewerId,
        )) as Output<Name>;
      case 'registerPushDevice':
        return (await phoneRegisterPush(ctx, 
          input as Input<'registerPushDevice'>,
          viewerId,
        )) as Output<Name>;
      case 'readWebPushKey':
        return { publicKey: webPushPublicKey(process.env) } as Output<Name>;
      case 'unregisterPushDevice':
        await ctx.database.query(`DELETE FROM push_devices WHERE token=$1 AND identity_id=$2`, [
          (input as Input<'unregisterPushDevice'>).token,
          viewerId,
        ]);
        return undefined as Output<Name>;
      case 'reportRunningUpdate':
        await phoneReportUpdate(ctx, input as Input<'reportRunningUpdate'>, viewerId, familyId);
        return undefined as Output<Name>;
      case 'disconnectAiClient': {
        const clientId = (input as Input<'disconnectAiClient'>).clientId;
        if (typeof clientId !== 'string' || !clientId || clientId.length > 100) throw new Error('Invalid client');
        await disconnectMcp(ctx.database, viewerId, clientId);
        return undefined as Output<Name>;
      }
      case 'readWorkbench':
        return (await phoneReadWorkbench(ctx, 
          input as Input<'readWorkbench'>,
          viewerId,
        )) as Output<Name>;
      case 'readConnectApp': {
        const workbench = await phoneReadWorkbench(ctx, input as Input<'readConnectApp'>, viewerId);
        return { workbench, suggestions: workbench.companies!.suggestions.map(item => ({
          appKey: item.appKey, name: item.name, domain: item.domain, description: item.purpose,
          logo: item.logo.kind === 'image' ? item.logo.uri : undefined,
        })) } as Output<Name>;
      }
      case 'searchWorkbenchApps':
        return (await phoneSearchWorkbenchApps(ctx, 
          input as Input<'searchWorkbenchApps'>,
          viewerId,
        )) as Output<Name>;
      case 'pairConnector':
        return (await phonePairConnector(ctx, 
          input as Input<'pairConnector'>,
          viewerId,
        )) as Output<Name>;
      case 'cancelGoogleSignIn':
        return { cancelled: false } as Output<Name>;
      case 'beginGoogleSignIn':
        throw new Error('This sign-in was retired; use Connect an app');
      case 'readGoogleSignIn':
        return { connected: false, connectedTypes: [] } as Output<Name>;
      case 'disconnectGoogleSignIn':
        return undefined as Output<Name>;
      case 'beginLinkSignIn':
        await phoneViewerWorkbenchWorkspace(ctx, viewerId);
        if (!ctx.linkWallet) throw new Error('Link is not configured');
        return { authorizationUrl: await ctx.linkWallet.begin(viewerId) } as Output<Name>;
      case 'cancelLinkSignIn':
        await phoneViewerWorkbenchWorkspace(ctx, viewerId);
        await ctx.linkWallet?.cancel(viewerId, (input as Input<'cancelLinkSignIn'>).state);
        return undefined as Output<Name>;
      case 'disconnectLinkSignIn':
        await phoneViewerWorkbenchWorkspace(ctx, viewerId);
        await ctx.linkWallet?.disconnect(viewerId);
        return undefined as Output<Name>;
      case 'unpairConnector':
        await phoneUnpairConnector(ctx, input as Input<'unpairConnector'>, viewerId);
        return undefined as Output<Name>;
      case 'connectWorkbenchApp':
        return (await phoneConnectWorkbenchApp(ctx, 
          input as Input<'connectWorkbenchApp'>,
          viewerId,
        )) as Output<Name>;
      case 'beginAppSignIn':
        await phoneViewerWorkbenchWorkspace(ctx, viewerId);
        {
          const integration = FIRST_PARTY_INTEGRATIONS.find(
            (entry) => entry.appId === (input as Input<'beginAppSignIn'>).appId,
          );
          if (integration) {
            const provider = integration.provider({ linkWallet: ctx.linkWallet });
            if (!provider) throw new Error(`${integration.name} sign-in is unavailable`);
            return {
              authorizationUrl: await provider.begin(viewerId, ctx.database),
            } as Output<Name>;
          }
        }
        {
          const card = (
            await ctx.database.query<{
              card: { connectKind: string; connectorId: string; agentId: string };
            }>(
              `SELECT card FROM messages WHERE card_type='app-sign-in' AND card->>'appId'=$1
              AND card->>'ownerId'=$2 AND card->>'status'='pending' AND card ? 'connectKind'
              ORDER BY created_at DESC LIMIT 1`,
              [(input as Input<'beginAppSignIn'>).appId, viewerId],
            )
          ).rows[0]?.card;
          if (card) {
            const status =
              card.connectKind === 'trusty-squire'
                ? await squireWorkStatus(ctx.database, card.agentId)
                : (
                    await ctx.database.query<{ sign_in: { url?: string } | null }>(
                      'SELECT sign_in FROM workspace_connectors WHERE id=$1 AND owner_identity_id=$2',
                      [card.connectorId, viewerId],
                    )
                  ).rows[0];
            const signIn = status && ('sign_in' in status ? status.sign_in : status.signIn);
            if (!signIn?.url)
              throw new CommandRefusalError('This sign-in is no longer pending. Reconnect to retry.', 409);
            if (card.connectKind === 'registry-mcp') {
              await ctx.database.transaction((database) =>
                recordOwnerGitHubSelection(
                  database,
                  (input as Input<'beginAppSignIn'>).appId,
                  viewerId,
                  'registry-mcp',
                  card.connectorId,
                ),
              );
            }
            return { authorizationUrl: signIn.url } as Output<Name>;
          }
        }
        if (!ctx.composio) throw new Error('App sign-in is unavailable');
        return (await beginComposioAppSignIn(
          ctx.database,
          ctx.composio,
          viewerId,
          (input as Input<'beginAppSignIn'>).appId,
        )) as Output<Name>;
      case 'completeAppSignIn':
        await phoneViewerWorkbenchWorkspace(ctx, viewerId);
        if (!ctx.composio) throw new Error('App sign-in is unavailable');
        return (await phoneCompleteAppSignIn(ctx, 
          (input as Input<'completeAppSignIn'>).sessionUri,
          (input as Input<'completeAppSignIn'>).appId,
          viewerId,
        )) as Output<Name>;
      case 'disconnectWorkbenchApp':
        await phoneDisconnectWorkbenchApp(ctx, input as Input<'disconnectWorkbenchApp'>, viewerId);
        return undefined as Output<Name>;
      case 'createWallet':
        return (await createWallet(
          ctx.database,
          viewerId,
          await phoneViewerWorkbenchWorkspace(ctx, viewerId),
        )) as Output<Name>;
      case 'readWallet':
        return (await readWallet(
          ctx.database,
          viewerId,
          await phoneViewerWorkbenchWorkspace(ctx, viewerId),
        )) as Output<Name>;
      case 'refreshWallet':{
        const binding=(await ctx.database.query<{workspace_id:string}>('SELECT workspace_id FROM wallet_bindings WHERE identity_id=$1',[viewerId])).rows[0];
        if(!binding)throw new Error('wallet not created');
        return await readWallet(ctx.database,viewerId,binding.workspace_id) as Output<Name>;
      }
      case 'sendFromWallet':
        await phoneRequireWorkspaceMember(ctx, 
          (input as Input<'sendFromWallet'>).workspaceId,
          viewerId,
        );
        return (await sendFromWallet(
          ctx.database,
          viewerId,
          (input as Input<'sendFromWallet'>).workspaceId,
          input as unknown as Input<'sendFromWallet'>,
        )) as Output<Name>;
      case 'grantWalletDelegation':
        // The wallet is human-owned, but its receipt must stay in a Workspace
        // where that human is currently a member.
        await phoneRequireWorkspaceMember(ctx, 
          (input as Input<'grantWalletDelegation'>).workspaceId,
          viewerId,
        );
        return (await grantWalletDelegation(
          ctx.database,
          viewerId,
          (input as Input<'grantWalletDelegation'>).workspaceId,
        )) as Output<Name>;
      case 'revokeWalletDelegation':
        await revokeWalletDelegation(ctx.database, viewerId);
        return undefined as Output<Name>;
      case 'readWalletHistory': {
        // The ledger is keyed on the viewer's identity alone, so the viewer
        // scope IS the authorization — no workspace parameter to project.
        const historyInput = input as unknown as Input<'readWalletHistory'>;
        return {
          entries: await walletHistory(
            ctx.database,
            viewerId,
            (historyInput as ReadWalletHistoryInput).limit ?? 20,
          ),
        } as Output<Name>;
      }
      case 'readConnectorInstall':
        return (await phoneReadConnectorInstall(ctx, 
          input as Input<'readConnectorInstall'>,
          viewerId,
        )) as Output<Name>;
      case 'readConnectionDetail':
        return (await phoneReadConnectionDetail(ctx, 
          input as Input<'readConnectionDetail'>,
          viewerId,
        )) as Output<Name>;
      case 'revokeConnectionGrants':
        return (await phoneRevokeConnectionGrants(ctx, 
          input as Input<'revokeConnectionGrants'>,
          viewerId,
        )) as Output<Name>;
      case 'sendPushTest':
        if (!ctx.sendPushTest) throw new Error('push delivery is not configured');
        await ctx.sendPushTest(viewerId);
        return undefined as Output<Name>;
      case 'deleteAccount':
        await phoneDeleteAccount(ctx, viewerId);
        return undefined as Output<Name>;
      case 'beginGitHubIdentityBind':
        return (await phoneRequireGitHub(ctx).beginIdentity(
          viewerId,
          input as Input<'beginGitHubIdentityBind'>,
        )) as Output<Name>;
      case 'completeGitHubIdentityBind':
        return (await phoneRequireGitHub(ctx).completeIdentity(
          viewerId,
          input as Input<'completeGitHubIdentityBind'>,
          false,
        )) as Output<Name>;
      case 'recoverGitHubIdentity':
        return (await phoneRequireGitHub(ctx).completeIdentity(
          viewerId,
          input as Input<'recoverGitHubIdentity'>,
          true,
        )) as Output<Name>;
      case 'beginGitHubInstallation':
        return (await phoneRequireGitHub(ctx).beginInstallation(
          viewerId,
          input as Input<'beginGitHubInstallation'>,
        )) as Output<Name>;
      case 'createGitHubRepository':
        return (await phoneRequireGitHub(ctx).createRepository(
          viewerId,
          input as Input<'createGitHubRepository'>,
        )) as Output<Name>;
      case 'uploadMedia': {
        const media = input as Input<'uploadMedia'>;
        return (await phoneUploadMedia(ctx, 
          viewerId,
          media.bytes,
          media.mimeType,
          media.name ?? 'upload',
          25 * 1024 * 1024,
        )) as Output<Name>;
      }
      default:
        throw new Error(`unsupported phone operation: ${String(name)}`);
    }
  }
