import { readRepositoryOnboardingCard } from './repository-onboarding.js';
import { readVaultSaveCard } from './vault-save.js';
import { isSystemEvent } from './system-events.js';
import { readVoiceCall } from './voice.js';
import { MESSAGE_REACTION_EMOJIS, type ChatListCorner, type RoomCornerSummary, type ChatListItem, type ChatListWorkspace, type ChoiceCardView, type CornerLifecycleView, type MessageReactionView, type RoomViewAgentTurn, type RoomViewPendingAgentCommand, type RoomViewMessage } from './phone-types.js';
import { isChoiceMode, isChoiceStatus } from './room-choices.js';
import { record, readIdentity, readList, readChoiceOption, uuid, hex64, integer, choiceLetter, field, readChoiceVideoPreview, oneOf, readIdentityOnly, nonempty, readHumanApprovalIdentity, githubUrl, readAttachment, readActivity, readGrantRequest, readSquireApproval, readComputerSession, readConnectorOfferCardView, readAppSignInCard, readAgentSignInCard, readHeader, httpUrl } from './phone-guards.js';



function readChoiceCard(value: unknown): ChoiceCardView | null {
  const item = record(value);
  const agent = readIdentity(item?.agent);
  const options = readList(item?.options, readChoiceOption);
  if (
    !item ||
    !uuid(item.choiceId) ||
    !isChoiceMode(item.mode) ||
    !isChoiceStatus(item.status) ||
    !agent ||
    (agent.kind !== 'agent' && !(item.mode === 'poll' && agent.kind === 'human')) ||
    typeof item.prompt !== 'string' ||
    !options ||
    options.length < 2 ||
    options.length > 4 ||
    !Array.isArray(item.electorate) ||
    !item.electorate.every(hex64) ||
    !integer(item.votedCount) ||
    !integer(item.electorateCount)
  ) {
    return null;
  }
  const responses = readList(item.responses, (candidate) => {
    const response = record(candidate);
    if (!response || !hex64(response.identityId) || !choiceLetter(response.optionId)) return null;
    return { identityId: response.identityId, optionId: response.optionId };
  });
  return {
    ...field('videoPreview', readChoiceVideoPreview(item.videoPreview)),
    ...field('onboardingManual', typeof item.onboardingManual === 'boolean' ? item.onboardingManual : undefined),
    ...field('starterOnboarding', oneOf(item.starterOnboarding, ['welcome', 'next'] as const)),
    choiceId: item.choiceId,
    mode: item.mode,
    status: item.status,
    agent,
    prompt: item.prompt,
    ...field('ask', typeof item.ask === 'string' ? item.ask : undefined),
    options,
    electorate: item.electorate,
    votedCount: item.votedCount,
    electorateCount: item.electorateCount,
    responses: responses ?? [],
    ...field('requester', readIdentityOnly(item.requester)),
    ...field('constraint', typeof item.constraint === 'string' ? item.constraint : undefined),
    ...field(
      'mentionIds',
      Array.isArray(item.mentionIds) && item.mentionIds.every(hex64) ? item.mentionIds : undefined,
    ),
    ...field('closesAt', integer(item.closesAt) ? item.closesAt : undefined),
    ...field('answeredBy', readIdentityOnly(item.answeredBy)),
    ...field(
      'selectedOptionId',
      choiceLetter(item.selectedOptionId) ? item.selectedOptionId : undefined,
    ),
    ...field('outcome', oneOf(item.outcome, ['winner', 'tie', 'no-votes'])),
    ...field('footer', typeof item.footer === 'string' ? item.footer : undefined),
  };
}


function readAgentCommand(value: unknown): NonNullable<RoomViewMessage['agentCommand']> | null {
  const item = record(value);
  const recipient = record(item?.recipient);
  if (
    !item ||
    (item.kind !== 'order' && item.kind !== 'report') ||
    typeof item.text !== 'string' ||
    !recipient ||
    typeof recipient.id !== 'string' ||
    typeof recipient.name !== 'string'
  ) {
    return null;
  }
  return {
    kind: item.kind,
    recipient: {
      id: recipient.id,
      name: recipient.name,
      ...field('handle', typeof recipient.handle === 'string' ? recipient.handle : undefined),
    },
    ...field('status', oneOf(item.status, ['done', 'blocked', 'needs-decision', 'failed'])),
    text: item.text,
  };
}


function readWalletTx(value: unknown): NonNullable<RoomViewMessage['walletTx']> | null {
  const item = record(value);
  if (
    !item ||
    (item.direction !== 'in' && item.direction !== 'out') ||
    typeof item.amountText !== 'string' ||
    typeof item.counterparty !== 'string' ||
    typeof item.chain !== 'string' ||
    typeof item.balanceAfterUsd !== 'string'
  ) {
    return null;
  }
  return {
    direction: item.direction,
    amountText: item.amountText,
    counterparty: item.counterparty,
    chain: item.chain,
    balanceAfterUsd: item.balanceAfterUsd,
    ...field('txUrl', typeof item.txUrl === 'string' ? item.txUrl : undefined),
    ...field(
      'agentName',
      typeof item.agentName === 'string' || item.agentName === null ? item.agentName : undefined,
    ),
  };
}


function readWalletInsufficient(
  value: unknown,
): NonNullable<RoomViewMessage['walletInsufficient']> | null {
  const item = record(value);
  if (
    !item ||
    typeof item.needed !== 'string' ||
    typeof item.asset !== 'string' ||
    typeof item.chain !== 'string'
  ) {
    return null;
  }
  return {
    needed: item.needed,
    asset: item.asset,
    chain: item.chain,
    ...field(
      'available',
      typeof item.available === 'string' || item.available === null ? item.available : undefined,
    ),
    ...field(
      'agentName',
      typeof item.agentName === 'string' || item.agentName === null ? item.agentName : undefined,
    ),
    ...field('reason', typeof item.reason === 'string' ? item.reason : undefined),
  };
}


function readWalletDelegation(
  value: unknown,
): NonNullable<RoomViewMessage['walletDelegation']> | null {
  const item = record(value);
  if (item?.standing === true) return { standing: true };
  if (!item || !integer(item.expiresAt) || !integer(item.ttlHours)) return null;
  return { expiresAt: item.expiresAt, ttlHours: item.ttlHours };
}


function readMessageCorner(value: unknown): NonNullable<RoomViewMessage['corner']> | null {
  const item = record(value);
  if (
    !item ||
    !uuid(item.id) ||
    (item.state !== 'working' &&
      item.state !== 'waiting' &&
      item.state !== 'idle' &&
      item.state !== 'review' &&
      item.state !== 'archived')
  ) {
    return null;
  }
  return { id: item.id, state: item.state };
}


function readPermission(value: unknown): NonNullable<RoomViewMessage['permission']> | null {
  const item = record(value);
  const agent = readIdentity(item?.agent);
  const requester = readIdentity(item?.requester);
  const decider = readIdentity(item?.decider);
  if (
    !item ||
    !nonempty(item.permissionId) ||
    !nonempty(item.requestId) ||
    !agent ||
    agent.kind !== 'agent' ||
    !requester ||
    requester.kind !== 'human' ||
    !nonempty(item.tool) ||
    (item.status !== 'pending' &&
      item.status !== 'allowed' &&
      item.status !== 'denied' &&
      item.status !== 'expired' &&
      item.status !== 'failed')
  ) {
    return null;
  }
  return {
    permissionId: item.permissionId,
    requestId: item.requestId,
    agent,
    requester,
    tool: item.tool,
    status: item.status,
    ...field('decider', decider && decider.kind === 'human' ? decider : undefined),
    ...field('repository', typeof item.repository === 'string' ? item.repository : undefined),
    ...field('purpose', oneOf(item.purpose, ['squire-spending'])),
    ...field('reason', nonempty(item.reason) ? item.reason : undefined),
    ...field('decidedAt', integer(item.decidedAt) ? item.decidedAt : undefined),
    ...field('ownerId', nonempty(item.ownerId) ? item.ownerId : undefined),
    ...field('cornerId', uuid(item.cornerId) ? item.cornerId : undefined),
  };
}


function readTargetBranch(value: unknown): NonNullable<RoomViewMessage['targetBranch']> | null {
  const item = record(value);
  if (!item || !nonempty(item.proposalId) || typeof item.from !== 'string' || !nonempty(item.to)) {
    return null;
  }
  return {
    proposalId: item.proposalId,
    ...field('purpose', nonempty(item.purpose) ? item.purpose : undefined),
    ...field('status', oneOf(item.status, ['allowed', 'denied'])),
    ...field('decidedBy', readHumanApprovalIdentity(item.decidedBy)),
    ...field('decidedAt', integer(item.decidedAt) ? item.decidedAt : undefined),
    from: item.from,
    to: item.to,
    ...field('repository', typeof item.repository === 'string' ? item.repository : undefined),
    ...field('agent', readIdentityOnly(item.agent)),
    ...field('requester', readIdentityOnly(item.requester)),
  };
}


function readGithubEvent(value: unknown): NonNullable<RoomViewMessage['githubEvent']> | null {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.type) ||
    !nonempty(item.action) ||
    typeof item.actor !== 'string' ||
    typeof item.title !== 'string' ||
    !githubUrl(item.url)
  ) {
    return null;
  }
  return {
    ...field('cornerId', uuid(item.cornerId) ? item.cornerId : undefined),
    type: item.type,
    action: item.action,
    actor: item.actor,
    title: item.title,
    url: item.url,
    ...field('branch', typeof item.branch === 'string' ? item.branch : undefined),
    ...field('targetBranch', typeof item.targetBranch === 'string' ? item.targetBranch : undefined),
  };
}


function readDaemonFact(value: unknown): NonNullable<RoomViewMessage['daemonFact']> | null {
  const item = record(value);
  if (
    !item ||
    (item.type !== 'corner-complete' &&
      item.type !== 'checks-failing' &&
      item.type !== 'worktree-cleaned' &&
      item.type !== 'corner-open') ||
    !uuid(item.cornerId) ||
    typeof item.objective !== 'string' ||
    // The objective titles a legacy card; a person-opened corner has none and
    // is titled by its name instead. A card must carry one of the two.
    (!item.objective.trim() && !(typeof item.name === 'string' && item.name.trim()))
  ) {
    return null;
  }
  if (
    item.type === 'corner-complete' &&
    item.outcome !== 'landed' &&
    item.outcome !== 'abandoned'
  ) {
    return null;
  }
  const pullRequest = record(item.pullRequest);
  const projectedPull =
    pullRequest && githubUrl(pullRequest.url)
      ? {
          url: pullRequest.url,
          ...field(
            'number',
            Number.isSafeInteger(pullRequest.number) && Number(pullRequest.number) > 0
              ? (pullRequest.number as number)
              : undefined,
          ),
          ...field('title', typeof pullRequest.title === 'string' ? pullRequest.title : undefined),
          ...field(
            'targetBranch',
            typeof pullRequest.targetBranch === 'string' ? pullRequest.targetBranch : undefined,
          ),
        }
      : undefined;
  return {
    type: item.type,
    cornerId: item.cornerId,
    objective: item.objective,
    ...field('name', typeof item.name === 'string' ? item.name : undefined),
    ...field(
      'sourceMessageId',
      typeof item.sourceMessageId === 'string' && item.sourceMessageId
        ? item.sourceMessageId
        : undefined,
    ),
    ...field('outcome', oneOf(item.outcome, ['landed', 'abandoned'])),
    ...field('pullRequest', projectedPull),
    ...field(
      'subgoals',
      readList(item.subgoals, (candidate) => {
        const entry = record(candidate);
        if (
          !entry ||
          typeof entry.step !== 'string' ||
          !entry.step.trim() ||
          (entry.status !== 'pending' &&
            entry.status !== 'in_progress' &&
            entry.status !== 'completed')
        ) {
          return null;
        }
        return { step: entry.step, status: entry.status };
      }),
    ),
  };
}


function readReaction(value: unknown): MessageReactionView | null {
  const item = record(value);
  if (
    !item ||
    !(MESSAGE_REACTION_EMOJIS as readonly string[]).includes(item.emoji as string) ||
    !integer(item.count) ||
    item.count <= 0 ||
    typeof item.reacted !== 'boolean'
  ) {
    return null;
  }
  const members = readList(item.members, readIdentity);
  return {
    emoji: item.emoji as MessageReactionView['emoji'],
    count: item.count,
    reacted: item.reacted,
    ...field('members', members),
  };
}


export function readRoomViewMessage(value: unknown): RoomViewMessage | null {
  const item = record(value);
  const author = readIdentity(item?.author);
  const sourceClient = record(item?.sourceClient);
  if (!item || !hex64(item.id) || !author || !integer(item.createdAt)) return null;
  const presentation =
    item.presentation === 'message' ||
    item.presentation === 'system' ||
    item.presentation === 'activity' ||
    item.presentation === 'card'
      ? item.presentation
      : 'message';
  const reference = record(item.reference);
  const reply = record(item.reply);
  const projectedReference =
    reference &&
    uuid(reference.channelId) &&
    reference.eventId === item.id &&
    hex64(reference.rootId)
      ? {
          channelId: reference.channelId,
          eventId: item.id,
          rootId: reference.rootId,
        }
      : undefined;
  const projectedReply =
    reply && uuid(reply.channelId) && hex64(reply.eventId) && hex64(reply.rootId)
      ? { channelId: reply.channelId, eventId: reply.eventId, rootId: reply.rootId }
      : undefined;
  return {
    id: item.id,
    text: typeof item.text === 'string' ? item.text : '',
    createdAt: item.createdAt,
    author,
    presentation,
    ...field('deleted', typeof item.deleted === 'boolean' ? item.deleted : undefined),
    ...field('createdAtMs', integer(item.createdAtMs) ? item.createdAtMs : undefined),
    ...field('version', integer(item.version) ? item.version : undefined),
    ...field('bookmarked', typeof item.bookmarked === 'boolean' ? item.bookmarked : undefined),
    ...field(
      'feedbackReported',
      typeof item.feedbackReported === 'boolean' ? item.feedbackReported : undefined,
    ),
    ...field('reference', projectedReference),
    ...field('reply', projectedReply),
    ...field('liveTurnId', typeof item.liveTurnId === 'string' ? item.liveTurnId : undefined),
    ...field('requestId', typeof item.requestId === 'string' ? item.requestId : undefined),
    ...field('sourceClient', sourceClient && typeof sourceClient.id === 'string' && typeof sourceClient.name === 'string' && sourceClient.name.length <= 120 ? { id: sourceClient.id, name: sourceClient.name } : undefined),
    ...field('agentModel', typeof item.agentModel === 'string' ? item.agentModel : undefined),
    ...field('attachments', readList(item.attachments, readAttachment)),
    ...field(
      'mentionPubkeys',
      Array.isArray(item.mentionPubkeys) && item.mentionPubkeys.every(hex64)
        ? item.mentionPubkeys
        : undefined,
    ),
    ...field('reactions', readList(item.reactions, readReaction)),
    ...field('activity', readList(item.activity, readActivity)),
    ...field('durableFact', oneOf(item.durableFact, ['failure', 'merge', 'action'])),
    ...field('corner', readMessageCorner(item.corner)),
    ...field('permission', readPermission(item.permission)),
    ...field('grantRequest', readGrantRequest(item.grantRequest)),
    ...field('squireApproval', readSquireApproval(item.squireApproval)),
    ...field('computerSession', readComputerSession(item.computerSession)),
    ...field('voiceCall', readVoiceCall(item.voiceCall)),
    ...field('connectorOffer', readConnectorOfferCardView(item.connectorOffer)),
    ...field('vaultSave', readVaultSaveCard(item.vaultSave)),
    ...field('appSignIn', readAppSignInCard(item.appSignIn)),
    ...field('agentSignIn', readAgentSignInCard(item.agentSignIn)),
    ...field('onboarding', readRepositoryOnboardingCard(item.onboarding)),
    ...field('choice', readChoiceCard(item.choice)),
    ...field('agentCommand', readAgentCommand(item.agentCommand)),
    ...field('walletTx', readWalletTx(item.walletTx)),
    ...field('walletInsufficient', readWalletInsufficient(item.walletInsufficient)),
    ...field('walletDelegation', readWalletDelegation(item.walletDelegation)),
    ...field('targetBranch', readTargetBranch(item.targetBranch)),
    ...field('githubEvent', readGithubEvent(item.githubEvent)),
    ...field('daemonFact', readDaemonFact(item.daemonFact)),
    ...field('awayWarning', typeof item.awayWarning === 'boolean' ? item.awayWarning : undefined),
    ...field('systemEvent', isSystemEvent(item.systemEvent) ? item.systemEvent : undefined),
  };
}


export function isRoomViewMessage(value: unknown): value is RoomViewMessage {
  return readRoomViewMessage(value) !== null;
}


/**
 * A compact Room read (`x-beeline-view: compact`, apps/server/src/
 * compact-room-view.ts) leaves out what the reader derives here: the
 * whole-second `createdAt` beside `createdAtMs`, and a top-level message's own
 * reference to itself in this Room. A full read passes through unchanged.
 */
function expandCompactMessage(value: unknown, roomId: string): unknown {
  const item = record(value);
  if (!item) return value;
  const createdAt =
    item.createdAt === undefined && integer(item.createdAtMs)
      ? Math.floor(item.createdAtMs / 1000)
      : undefined;
  const reference =
    item.reference === undefined && item.presentation === 'message' && hex64(item.id)
      ? { channelId: roomId, eventId: item.id, rootId: item.id }
      : undefined;
  if (createdAt === undefined && reference === undefined) return value;
  return {
    ...item,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(reference === undefined ? {} : { reference }),
  };
}


export function readScopedMessage(value: unknown, roomId: string): RoomViewMessage | null {
  const message = readRoomViewMessage(expandCompactMessage(value, roomId));
  if (!message) return null;
  const reference =
    message.reference && message.reference.channelId === roomId ? message.reference : undefined;
  const reply = message.reply && message.reply.channelId === roomId ? message.reply : undefined;
  const { reference: _foreignReference, reply: _foreignReply, ...rest } = message;
  return { ...rest, ...field('reference', reference), ...field('reply', reply) };
}


export function readAgentTurn(value: unknown): RoomViewAgentTurn | null {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.requestId) ||
    !hex64(item.agentPubkey) ||
    (item.status !== 'working' &&
      item.status !== 'complete' &&
      item.status !== 'failed' &&
      item.status !== 'cancelled') ||
    !integer(item.createdAt)
  ) {
    return null;
  }
  return {
    requestId: item.requestId,
    agentPubkey: item.agentPubkey,
    status: item.status,
    createdAt: item.createdAt,
    ...field('startedAt', integer(item.startedAt) ? item.startedAt : undefined),
    ...field('generationId', typeof item.generationId === 'string' ? item.generationId : undefined),
    ...field('requestedBy', typeof item.requestedBy === 'string' ? item.requestedBy : undefined),
  };
}


export function readPendingAgentCommand(value: unknown): RoomViewPendingAgentCommand | null {
  const item = record(value);
  if (!item || !nonempty(item.requestId) || !hex64(item.agentPubkey) || !integer(item.createdAt))
    return null;
  return {
    requestId: item.requestId,
    agentPubkey: item.agentPubkey,
    createdAt: item.createdAt,
  };
}


export function readWorkspace(value: unknown): ChatListWorkspace | null {
  const item = record(value);
  if (!item || !uuid(item.id)) return null;
  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : '',
    role: oneOf(item.role, ['owner', 'admin', 'member', 'spectator']) ?? 'member',
    updatedAt: integer(item.updatedAt) ? item.updatedAt : 0,
    ...field('roomCount', integer(item.roomCount) ? item.roomCount : undefined),
    ...field('attention', typeof item.attention === 'boolean' ? item.attention : undefined),
    ...field('visibility', oneOf(item.visibility, ['public', 'invite-only'])),
    ...field('avatar', typeof item.avatar === 'string' ? item.avatar : undefined),
  };
}


export function readLatest(value: unknown): NonNullable<ChatListItem['latestMessage']> | null {
  const item = record(value);
  const author = readIdentity(item?.author);
  // Not hex64: an automatic failure report is stored as `failure:<command>:<attempt>`
  // and a handoff card as a UUID. Dropping the preview made an active Room read
  // "No messages yet".
  if (
    !item ||
    !nonempty(item.id) ||
    typeof item.text !== 'string' ||
    !integer(item.createdAt) ||
    !author
  ) {
    return null;
  }
  return {
    id: item.id,
    text: item.text,
    createdAt: item.createdAt,
    author,
    ...field('attachments', readList(item.attachments, readAttachment)),
    ...field('mentionsViewer', item.mentionsViewer === true ? (true as const) : undefined),
  };
}


export function readCornerBlocker(value: unknown): import('./phone-types.js').CornerBlocker | undefined {
  const item = record(value);
  const kind = oneOf(item?.kind, ['message', 'merge-hold', 'report', 'ci']);
  if (!item || !kind) return undefined;
  return { kind,
    ...field('url', typeof item.url === 'string' && item.url.startsWith('https://github.com/') ? item.url : undefined),
    ...field('personId', nonempty(item.personId) ? item.personId : undefined),
    ...field('personName', nonempty(item.personName) ? item.personName : undefined) };
}


function readChatCorner(value: unknown): ChatListCorner | null {
  const item = record(value);
  const state = oneOf(item?.state, ['working', 'waiting', 'idle', 'review']);
  if (!item || !uuid(item.id) || typeof item.name !== 'string' || !state) return null;
  return {
    id: item.id,
    name: item.name,
    state,
    ...field('mine', item.mine === true ? (true as const) : undefined),
    ...field('reason', oneOf(item.reason, ['approve', 'connect', 'question'])),
    ...field('blocker', readCornerBlocker(item.blocker)),
    ...field('itemId', nonempty(item.itemId) ? item.itemId : undefined),
    ...field('waitingSince', integer(item.waitingSince) ? item.waitingSince : undefined),
    ...field('attention', item.attention === true ? (true as const) : undefined),
  };
}


export function readCornerSummary(value: unknown): RoomCornerSummary | undefined {
  const item = record(value);
  if (!item) return undefined;
  const openCorners = readList(item.openCorners, readChatCorner);
  const counts = [item.cornerCount, item.waitingCornerCount, item.mineCornerCount];
  if (!openCorners || !counts.every(integer)) return undefined;
  return {
    cornerCount: item.cornerCount as number,
    waitingCornerCount: item.waitingCornerCount as number,
    mineCornerCount: item.mineCornerCount as number,
    openCorners,
  };
}


export function readChat(value: unknown): ChatListItem | null {
  const item = record(value);
  const room = readHeader(item?.room);
  if (!item || !room) return null;
  const direct = record(item.directMessage);
  const peer = readIdentity(direct?.peer);
  const presence = record(direct?.presence);
  const presenceStatus = oneOf(presence?.status, ['online', 'offline']);
  const projectedPresence =
    presence && presenceStatus && integer(presence.observedAt)
      ? {
          status: presenceStatus,
          observedAt: presence.observedAt,
          ...field('held', presence.held === true ? (true as const) : undefined),
        }
      : undefined;
  const attentionReason = record(item.attentionReason);
  const projectedAttentionReason =
    attentionReason?.kind === 'approval'
      ? {
          kind: 'approval' as const,
          ...field(
            'actor',
            typeof attentionReason.actor === 'string' && attentionReason.actor.trim()
              ? attentionReason.actor
              : undefined,
          ),
        }
      : undefined;
  return {
    room,
    ...field('unread', typeof item.unread === 'boolean' ? item.unread : undefined),
    ...field(
      'leaveDeletesRoom',
      typeof item.leaveDeletesRoom === 'boolean' ? item.leaveDeletesRoom : undefined,
    ),
    ...field('memberCount', integer(item.memberCount) ? item.memberCount : undefined),
    ...field('cornerCount', integer(item.cornerCount) ? item.cornerCount : undefined),
    ...field(
      'waitingCornerCount',
      integer(item.waitingCornerCount) && item.waitingCornerCount >= 0
        ? item.waitingCornerCount
        : undefined,
    ),
    ...field(
      'mineCornerCount',
      integer(item.mineCornerCount) && item.mineCornerCount >= 0 ? item.mineCornerCount : undefined,
    ),
    ...field('openCorners', readList(item.openCorners, readChatCorner)),
    ...field(
      'agentsOffline',
      typeof item.agentsOffline === 'boolean' ? item.agentsOffline : undefined,
    ),
    ...field('closed', typeof item.closed === 'boolean' ? item.closed : undefined),
    ...field('voiceCall', readVoiceCall(item.voiceCall)),
    ...field('latestMessage', readLatest(item.latestMessage)),
    ...field(
      'repositoryName',
      typeof item.repositoryName === 'string' ? item.repositoryName : undefined,
    ),
    ...field('agentState', oneOf(item.agentState, ['needs-you', 'working'])),
    ...field('attentionReason', projectedAttentionReason),
    ...field('directMessage', peer ? { peer, ...field('presence', projectedPresence) } : undefined),
  };
}


export function readCheck(
  value: unknown,
): NonNullable<NonNullable<CornerLifecycleView['checksSummary']>['checks']>[number] | null {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.name) ||
    (item.status !== 'pending' &&
      item.status !== 'passed' &&
      item.status !== 'failed' &&
      item.status !== 'cancelled')
  ) {
    return null;
  }
  return {
    name: item.name,
    status: item.status,
    ...field('conclusion', typeof item.conclusion === 'string' ? item.conclusion : undefined),
    ...field('url', httpUrl(item.url) ? item.url : undefined),
  };
}
