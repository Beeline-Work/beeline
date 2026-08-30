import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { McpServerWire } from './acp.js';
import { buildAgentMessage } from './activity.js';
import {
  DurableMergeGate,
  git,
  publishEvent,
  type Identity,
  type RelayClient,
} from '@beeline/gate';
import {
  createBuzzClient,
  listMembers,
  type AttachmentReference,
  type ChannelOpsContext,
} from '@beeline/buzz-client';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import type { BodyConfig } from './config.js';
import {
  WORK_SCHEDULE_KIND,
  buildWorkSchedule,
  parseWorkSchedule,
  parseWorkScheduleValue,
  workScheduleKey,
  type ParsedWorkSchedule,
  type WorkScheduleV1,
} from './work-calendar.js';
import {
  canonicalizeImageForUpload,
  isAllowedAgentAttachmentMimeType,
  mimeTypeForName,
  previewUrlForAgentAttachment,
  type AgentOutputCandidate,
} from './attachments.js';
import {
  authorizedExternalMcpServers,
  squireToolsForCapabilities,
} from './external-mcp-capabilities.js';
import type { SquireHostBroker } from './squire-host-broker.js';
import { AgentToolHostBroker, type AgentToolSessionBinding } from './agent-tool-host-broker.js';
import { AuthorizeOrRequestKernel } from './authorize-or-request.js';
import {
  BEELINE_ACTION_TOKENS,
  BEELINE_AGENT_TOOL_SCHEMA_VERSION,
  BEELINE_MANDATE_DEFAULTS_VERSION,
  BEELINE_SCHEDULE_OPERATIONS,
  assertBeelineAgentToolHandshake,
  type BeelineActionScope,
  type BeelineActionToken,
  type BeelineAgentToolName,
  type BeelineScheduleOperation,
  type CloseCornerDisposition,
  type CornerReadResult,
  type DeliverAudience,
  type DirectToolResult,
  type ListCornersResult,
  type ReadMandateResult,
  type RequestMandateResult,
  type ScheduleConfigurationInput,
} from './agent-tool-contract.js';
import { inspectMcpServer } from './mcp-inventory.js';
import type { ModelTurnAttribution } from './model-spend.js';
import type { AgentSession, BoundRepo, ChannelTaskRequest, SubchannelInfo } from './body.js';

type CornerOpenAttempt = {
  roomId: string;
  requestId: string;
  objective: string;
  cornerId?: string;
  name?: string;
};

export class AgentToolKnownFailure extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'AgentToolKnownFailure';
  }
}

export interface BodyAgentToolsHost {
  config(): BodyConfig;
  agentIdentity(): Identity;
  agentRelay(): RelayClient;
  squireBroker(): SquireHostBroker | undefined;
  activeTurnRequestId(channelId: string): string | undefined;
  pendingRoomRequest(roomId: string): ChannelTaskRequest | undefined;
  session(channelId: string): AgentSession | undefined;
  subchannel(channelId: string): SubchannelInfo | undefined;
  subchannels(): IterableIterator<SubchannelInfo>;
  cornerOpenAttempt(requestId: string): CornerOpenAttempt | undefined;
  cornerOpenAttempts(): IterableIterator<CornerOpenAttempt>;
  agentClientContext(): ChannelOpsContext;
  currentAgentToolMandate(
    workspaceId: string,
    roomId: string,
    requestedScope?: BeelineActionScope,
  ): Promise<ReadMandateResult>;
  agentToolScheduleIds(workspaceId: string): Promise<string[]>;
  agentToolSchedules(workspaceId: string, roomId: string): Promise<ParsedWorkSchedule[]>;
  publishAgentToolScheduleIndex(
    workspaceId: string,
    scheduleIds: readonly string[],
  ): Promise<NostrEvent>;
  missionCornerFresh(info: SubchannelInfo): Promise<boolean>;
  findHumanMergeApproval(info: SubchannelInfo): Promise<SubchannelInfo['humanMergeApproval']>;
  repoId(repo: BoundRepo): string;
  runScheduleNow():
    ((scheduleId: string) => Promise<{ runId: string; eventId: string }>) | undefined;
  liveSubchannelForRequest(roomId: string, requestId: string): SubchannelInfo | undefined;
  requesterCanOpenCornerDirectly(roomId: string, requesterPubkey: string): Promise<boolean>;
  openSubchannelForRequest(
    roomId: string,
    repo: BoundRepo,
    intent: string,
    request: ChannelTaskRequest,
    options?: { objective?: string },
  ): Promise<SubchannelInfo>;
  startCornerTaskOnce(
    info: SubchannelInfo,
    prompt: string,
    taskInstructions: string,
    attribution: ModelTurnAttribution,
  ): void;
  cornerOpenTaskPrompt(taskDescription: string | undefined, objective: string): string;
  requestCornerApproval(input: {
    roomId: string;
    workspaceId: string;
    roomRepo: BoundRepo;
    request: ChannelTaskRequest;
    objective: string;
    tool: string;
  }): Promise<{ request_id: string; event_id: string; message: string }>;
  publishMergeReady(info: SubchannelInfo): Promise<boolean>;
  forceSuspend(channelId: string): Promise<void>;
  archiveSubchannel(channelId: string): Promise<void>;
  runApprovalLandingPass(roomId: string, mergeGate?: DurableMergeGate): Promise<void>;
  pollMergeCompletions(): Promise<number>;
  candidateBytes(session: AgentSession, candidate: AgentOutputCandidate): Promise<Uint8Array>;
}

/**
 * Host-governed Beeline tools mounted into Body-managed ACP sessions.
 *
 * This collaborator owns the typed tool broker, authorization kernel, Room
 * repository/mandate facts, and merge gates. Body supplies only the concrete
 * lifecycle and truth callbacks that execute an authorized action.
 */
export class BodyAgentTools {
  private readonly agentToolBroker = new AgentToolHostBroker();
  private readonly agentToolKernel = new AuthorizeOrRequestKernel();
  readonly roomRepositories = new Map<string, BoundRepo>();
  private readonly agentToolMandates = new Map<string, ReadMandateResult>();
  private readonly roomMergeGates = new Map<string, DurableMergeGate | undefined>();

  constructor(private readonly host: BodyAgentToolsHost) {}

  private get agentToolRoomRepositories(): Map<string, BoundRepo> {
    return this.roomRepositories;
  }

  private get config(): BodyConfig {
    return this.host.config();
  }

  private get agentIdentity(): Identity {
    return this.host.agentIdentity();
  }

  private get agentRelay(): RelayClient {
    return this.host.agentRelay();
  }

  private get squireBroker(): SquireHostBroker | undefined {
    return this.host.squireBroker();
  }

  private get runScheduleNow():
    ((scheduleId: string) => Promise<{ runId: string; eventId: string }>) | undefined {
    return this.host.runScheduleNow();
  }

  private get scheduler(): { forceSuspend(channelId: string): Promise<void> } {
    return { forceSuspend: (channelId) => this.host.forceSuspend(channelId) };
  }

  private get activePermissionTurns(): {
    get(channelId: string): { requestId: string } | undefined;
  } {
    return {
      get: (channelId) => {
        const requestId = this.host.activeTurnRequestId(channelId);
        return requestId ? { requestId } : undefined;
      },
    };
  }

  private get pendingRoomTurns(): {
    get(roomId: string): { request: ChannelTaskRequest } | undefined;
  } {
    return {
      get: (roomId) => {
        const request = this.host.pendingRoomRequest(roomId);
        return request ? { request } : undefined;
      },
    };
  }

  private get subchannels(): {
    get(channelId: string): SubchannelInfo | undefined;
    values(): IterableIterator<SubchannelInfo>;
  } {
    return {
      get: (channelId) => this.host.subchannel(channelId),
      values: () => this.host.subchannels(),
    };
  }

  private get cornerOpenAttempts(): {
    get(requestId: string): CornerOpenAttempt | undefined;
    values(): IterableIterator<CornerOpenAttempt>;
  } {
    return {
      get: (requestId) => this.host.cornerOpenAttempt(requestId),
      values: () => this.host.cornerOpenAttempts(),
    };
  }

  private get sessions(): { get(channelId: string): AgentSession | undefined } {
    return { get: (channelId) => this.host.session(channelId) };
  }

  private agentClientContext(): ChannelOpsContext {
    return this.host.agentClientContext();
  }

  private missionCornerFresh(info: SubchannelInfo): Promise<boolean> {
    return this.host.missionCornerFresh(info);
  }

  private findHumanMergeApproval(
    info: SubchannelInfo,
  ): Promise<SubchannelInfo['humanMergeApproval']> {
    return this.host.findHumanMergeApproval(info);
  }

  private repoId(repo: BoundRepo): string {
    return this.host.repoId(repo);
  }

  private liveSubchannelForRequest(roomId: string, requestId: string): SubchannelInfo | undefined {
    return this.host.liveSubchannelForRequest(roomId, requestId);
  }

  private requesterCanOpenCornerDirectly(
    roomId: string,
    requesterPubkey: string,
  ): Promise<boolean> {
    return this.host.requesterCanOpenCornerDirectly(roomId, requesterPubkey);
  }

  private openSubchannelForRequest(
    roomId: string,
    repo: BoundRepo,
    intent: string,
    request: ChannelTaskRequest,
    options?: { objective?: string },
  ): Promise<SubchannelInfo> {
    return this.host.openSubchannelForRequest(roomId, repo, intent, request, options);
  }

  private startCornerTaskOnce(
    info: SubchannelInfo,
    prompt: string,
    taskInstructions: string,
    attribution: ModelTurnAttribution,
  ): void {
    this.host.startCornerTaskOnce(info, prompt, taskInstructions, attribution);
  }

  private requestCornerApproval(
    input: Parameters<BodyAgentToolsHost['requestCornerApproval']>[0],
  ): ReturnType<BodyAgentToolsHost['requestCornerApproval']> {
    return this.host.requestCornerApproval(input);
  }

  private publishMergeReady(info: SubchannelInfo): Promise<boolean> {
    return this.host.publishMergeReady(info);
  }

  private archiveSubchannel(channelId: string): Promise<void> {
    return this.host.archiveSubchannel(channelId);
  }

  private runApprovalLandingPass(roomId: string, mergeGate?: DurableMergeGate): Promise<void> {
    return this.host.runApprovalLandingPass(roomId, mergeGate);
  }

  private pollMergeCompletions(): Promise<number> {
    return this.host.pollMergeCompletions();
  }

  private candidateBytes(
    session: AgentSession,
    candidate: AgentOutputCandidate,
  ): Promise<Uint8Array> {
    return this.host.candidateBytes(session, candidate);
  }

  bindRoomRepository(roomId: string, repo: BoundRepo): void {
    this.roomRepositories.set(roomId, repo);
  }

  bindMandate(roomId: string, mandate: ReadMandateResult): void {
    this.agentToolMandates.set(roomId, mandate);
  }

  setMergeGate(roomId: string, mergeGate: DurableMergeGate | undefined): void {
    this.roomMergeGates.set(roomId, mergeGate);
  }

  deleteMergeGate(roomId: string): void {
    this.roomMergeGates.delete(roomId);
  }

  revoke(channelId: string): void {
    this.agentToolBroker.revoke(channelId);
  }

  async close(): Promise<void> {
    await this.agentToolBroker.close();
    this.roomRepositories.clear();
    this.agentToolMandates.clear();
    this.roomMergeGates.clear();
  }

  async authorizedExternalServers(channelId: string): Promise<McpServerWire[]> {
    const capabilities = this.config.externalMcpCapabilities ?? [];
    const broker = this.squireBroker
      ? await this.squireBroker.mcpServer(channelId, squireToolsForCapabilities(capabilities))
      : undefined;
    return authorizedExternalMcpServers(this.config.accessPolicy, capabilities, broker);
  }

  /** Mount, inspect, and then remint the per-session capability handed to the harness. */
  async mcpServer(binding: AgentToolSessionBinding): Promise<McpServerWire> {
    const probe = await this.agentToolBroker.mcpServer(binding);
    assertBeelineAgentToolHandshake(
      await inspectMcpServer({
        ...probe,
        env: Object.fromEntries((probe.env ?? []).map(({ name, value }) => [name, value])),
      }),
    );
    // The probe endpoint is revoked when the replacement is minted. Only the
    // fresh endpoint and its capability are handed to the harness.
    return this.agentToolBroker.mcpServer(binding);
  }

  private agentToolDedupKey(
    channelId: string,
    tool: BeelineAgentToolName,
    objective: string,
  ): string {
    const turn = this.activePermissionTurns.get(channelId);
    if (!turn)
      throw new AgentToolKnownFailure('no_active_turn', 'This tool requires an active turn.');
    return createHash('sha256')
      .update(this.agentIdentity.publicKey)
      .update('\0')
      .update(turn.requestId)
      .update('\0')
      .update(tool)
      .update('\0')
      .update(objective.trim().replace(/\s+/g, ' ').toLowerCase())
      .digest('hex');
  }

  private stringToolArg(
    args: Record<string, unknown>,
    name: string,
    options: { required?: boolean; max?: number } = {},
  ): string | undefined {
    const value = args[name];
    if (value === undefined && !options.required) return undefined;
    if (typeof value !== 'string' || !value.trim()) {
      throw new AgentToolKnownFailure('invalid_arguments', `${name} must be a non-empty string.`);
    }
    const trimmed = value.trim();
    if (trimmed.length > (options.max ?? 4_096)) {
      throw new AgentToolKnownFailure('invalid_arguments', `${name} is too long.`);
    }
    return trimmed;
  }

  async readCurrentAgentToolMandate(
    workspaceId: string,
    roomId: string,
    requestedScope?: BeelineActionScope,
  ): Promise<ReadMandateResult> {
    const standing = this.agentToolMandates.get(roomId);
    if (!standing) {
      throw new AgentToolKnownFailure(
        'mandate_unavailable',
        'The signed mandate generation is unavailable for this session.',
        true,
      );
    }
    const [roomMembers, workspaceMembers] = await Promise.all([
      listMembers(this.agentClientContext(), roomId),
      workspaceId === roomId
        ? Promise.resolve(undefined)
        : listMembers(this.agentClientContext(), workspaceId),
    ]);
    const agent = this.agentIdentity.publicKey;
    const blockers = [...standing.blockers];
    if (!roomMembers.some((member) => member.pubkey === agent)) {
      blockers.push({
        code: 'room_membership_missing',
        message: 'Current Room membership is missing.',
      });
    }
    if (workspaceMembers && !workspaceMembers.some((member) => member.pubkey === agent)) {
      blockers.push({
        code: 'workspace_membership_missing',
        message: 'Current Workspace membership is missing.',
      });
    }
    const grants = [...standing.grants];
    if (requestedScope?.type === 'corner.close') {
      const info = this.subchannels.get(requestedScope.cornerId);
      const defaultAbandon = requestedScope.disposition === 'abandon';
      const missionLand =
        requestedScope.disposition === 'land' &&
        Boolean(info?.mission && (await this.missionCornerFresh(info)));
      const approvedLand =
        requestedScope.disposition === 'land' &&
        Boolean(info && (await this.findHumanMergeApproval(info)));
      if (defaultAbandon || missionLand || approvedLand) {
        grants.push({
          action: 'corner.close',
          scope: requestedScope,
          source: defaultAbandon ? 'default' : missionLand ? 'mission' : 'signed-grant',
          event_id:
            info?.humanMergeApproval?.id ??
            info?.mission?.grantEventId ??
            standing.generation.event_id,
        });
      }
    }
    if (blockers.length > 0) {
      return {
        ...standing,
        grants: [],
        defaults: standing.defaults.map((entry) => ({ ...entry, effect: 'deny' as const })),
        blockers,
      };
    }
    return { ...standing, grants, blockers };
  }

  private async publishAgentToolReceipt(input: {
    channelId: string;
    tool: BeelineAgentToolName;
    status: 'executed' | 'failed';
    action: string;
    resultId?: string;
    extraTags?: string[][];
  }): Promise<NostrEvent> {
    const event = signEvent(
      {
        pubkey: this.agentIdentity.publicKey,
        created_at: Math.floor(Date.now() / 1_000),
        kind: 9,
        tags: [
          ['h', input.channelId],
          ['t', 'beeline-agent-tool-result'],
          ['tool', input.tool],
          ['action', input.action],
          ['status', input.status],
          ...(input.resultId ? [['result', input.resultId]] : []),
          ...(input.extraTags ?? []),
        ],
        content: JSON.stringify({
          schema_version: BEELINE_AGENT_TOOL_SCHEMA_VERSION,
          tool: input.tool,
          status: input.status,
          action: input.action,
          ...(input.resultId ? { result_id: input.resultId } : {}),
        }),
      },
      this.agentIdentity.secretKey,
    );
    await publishEvent(event, this.agentIdentity);
    return event;
  }

  binding(input: {
    channelId: string;
    roomId: string;
    workspaceId: string;
  }): AgentToolSessionBinding {
    return {
      channelId: input.channelId,
      invoke: (tool, args) => this.invokeAgentTool(input, tool, args),
    };
  }

  async invokeAgentTool(
    binding: { channelId: string; roomId: string; workspaceId: string },
    tool: BeelineAgentToolName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (tool === 'read_mandate') {
      if (Object.keys(args).length > 0) {
        return {
          status: 'denied',
          code: 'invalid_arguments',
          message: 'read_mandate accepts no arguments.',
        };
      }
      return this.host.currentAgentToolMandate(binding.workspaceId, binding.roomId);
    }
    if (tool === 'read_corner') return this.invokeReadCornerTool(binding, args);
    if (tool === 'list_corners') return this.invokeListCornersTool(binding, args);
    if (tool === 'request_mandate') return this.invokeRequestMandateTool(binding, args);
    if (tool === 'open_corner') return this.invokeOpenCornerTool(binding, args);
    if (tool === 'close_corner') return this.invokeCloseCornerTool(binding, args);
    if (tool === 'schedule') return this.invokeScheduleTool(binding, args);
    return this.invokeDeliverTool(binding, args);
  }

  private cornerReadSummary(info: SubchannelInfo): NonNullable<CornerReadResult['corner']> {
    const state = info.cornerState?.state ?? 'open';
    return {
      corner_id: info.subchannelId,
      name: info.cornerName ?? info.taskDescription ?? info.featureBranch,
      objective: info.taskDescription ?? '',
      feature_ref: info.featureBranch,
      state: state === 'closed' ? 'concluded' : state,
    };
  }

  private invokeReadCornerTool(
    binding: { channelId: string; roomId: string; workspaceId: string },
    args: Record<string, unknown>,
  ): CornerReadResult | DirectToolResult<never> {
    if (Object.keys(args).length > 0) {
      return {
        status: 'denied',
        code: 'invalid_arguments',
        message: 'read_corner accepts no arguments.',
      };
    }
    const request =
      this.pendingRoomTurns.get(binding.roomId)?.request ??
      this.subchannels.get(binding.channelId)?.request;
    if (!request) {
      return {
        status: 'failed',
        code: 'triggering_request_unavailable',
        retryable: false,
        message: 'This session has no triggering Room request to inspect.',
      };
    }
    const info = this.liveSubchannelForRequest(binding.roomId, request.eventId);
    if (info) {
      return {
        request_id: request.eventId,
        exists: true,
        state: this.cornerReadSummary(info).state,
        corner: this.cornerReadSummary(info),
      };
    }
    const attempt = this.cornerOpenAttempts.get(request.eventId);
    if (attempt?.roomId === binding.roomId && attempt.cornerId) {
      return {
        request_id: request.eventId,
        exists: true,
        state: 'opening',
        corner: {
          corner_id: attempt.cornerId,
          name: attempt.name ?? attempt.objective,
          objective: attempt.objective,
          state: 'opening',
        },
      };
    }
    return { request_id: request.eventId, exists: false, state: attempt ? 'opening' : 'not_found' };
  }

  private invokeListCornersTool(
    binding: { channelId: string; roomId: string; workspaceId: string },
    args: Record<string, unknown>,
  ): ListCornersResult | DirectToolResult<never> {
    if (Object.keys(args).length > 0) {
      return {
        status: 'denied',
        code: 'invalid_arguments',
        message: 'list_corners accepts no arguments.',
      };
    }
    const corners = [...this.subchannels.values()]
      .filter((info) => !info.archived && info.session.parentChannelId === binding.roomId)
      .map((info) => this.cornerReadSummary(info));
    const known = new Set(corners.map((corner) => corner.corner_id));
    for (const attempt of this.cornerOpenAttempts.values()) {
      if (attempt.roomId !== binding.roomId || !attempt.cornerId || known.has(attempt.cornerId))
        continue;
      corners.push({
        corner_id: attempt.cornerId,
        name: attempt.name ?? attempt.objective,
        objective: attempt.objective,
        state: 'opening',
      });
    }
    return { corners };
  }

  private objectToolArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
    const value = args[name];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AgentToolKnownFailure('invalid_arguments', `${name} must be an object.`);
    }
    return value as Record<string, unknown>;
  }

  private assertToolArgKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
    if (Object.keys(args).some((key) => !allowed.includes(key))) {
      throw new AgentToolKnownFailure(
        'invalid_arguments',
        'The tool payload contains an unknown or host-owned field.',
      );
    }
  }

  private async mandateScopeFromToolArgs(
    binding: { channelId: string; roomId: string; workspaceId: string },
    action: BeelineActionToken,
    raw: Record<string, unknown>,
  ): Promise<BeelineActionScope> {
    if (raw.type !== action) {
      throw new AgentToolKnownFailure(
        'scope_action_mismatch',
        'The typed scope must match the requested action.',
      );
    }
    const roomRepo = this.agentToolRoomRepositories.get(binding.roomId);
    const repositoryKey = roomRepo
      ? (roomRepo.truth?.binding.key ?? roomRepo.repositoryKey ?? this.repoId(roomRepo))
      : undefined;
    const targetRef = roomRepo?.targetBranch ?? (roomRepo ? 'refs/heads/main' : undefined);
    if (action === 'corner.open') {
      this.assertToolArgKeys(raw, ['type', 'repository_key', 'target_ref']);
      if (!repositoryKey || !targetRef) {
        throw new AgentToolKnownFailure(
          'repository_unavailable',
          'This Room has no host-bound repository for a corner.',
        );
      }
      if (
        (raw.repository_key !== undefined && raw.repository_key !== repositoryKey) ||
        (raw.target_ref !== undefined && raw.target_ref !== targetRef)
      ) {
        throw new AgentToolKnownFailure(
          'repository_scope_mismatch',
          'The requested repository scope is outside this session binding.',
        );
      }
      return {
        type: action,
        workspaceId: binding.workspaceId,
        roomId: binding.roomId,
        repositoryKey,
        targetRef,
      };
    }
    if (action === 'corner.close') {
      this.assertToolArgKeys(raw, [
        'type',
        'corner_id',
        'disposition',
        'repository_key',
        'target_ref',
        'source_sha',
      ]);
      const cornerId = this.stringToolArg(raw, 'corner_id', { required: true, max: 256 })!;
      const disposition = this.stringToolArg(raw, 'disposition', { required: true, max: 16 });
      if (cornerId !== binding.channelId || (disposition !== 'land' && disposition !== 'abandon')) {
        throw new AgentToolKnownFailure(
          'corner_scope_mismatch',
          'The requested mandate must name this bound corner and a closed disposition.',
        );
      }
      const info = this.subchannels.get(cornerId);
      if (!info || info.session.parentChannelId !== binding.roomId) {
        throw new AgentToolKnownFailure('corner_unavailable', 'The bound corner is unavailable.');
      }
      const sourceSha = (await git(info.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
        throw new AgentToolKnownFailure('corner_tip_unavailable', 'The corner tip is unavailable.');
      }
      if (
        (raw.repository_key !== undefined && raw.repository_key !== repositoryKey) ||
        (raw.target_ref !== undefined && raw.target_ref !== targetRef) ||
        (raw.source_sha !== undefined && raw.source_sha !== sourceSha)
      ) {
        throw new AgentToolKnownFailure(
          'corner_scope_mismatch',
          'The requested close scope is stale or outside this session binding.',
        );
      }
      return {
        type: action,
        workspaceId: binding.workspaceId,
        roomId: binding.roomId,
        cornerId,
        disposition,
        ...(repositoryKey && targetRef ? { repositoryKey, targetRef, sourceSha } : {}),
      };
    }
    if (action === 'artifact.deliver') {
      this.assertToolArgKeys(raw, ['type', 'audience', 'corner_id']);
      const audience = this.stringToolArg(raw, 'audience', { required: true, max: 32 });
      if (audience !== 'current_corner' && audience !== 'parent_room') {
        throw new AgentToolKnownFailure(
          'invalid_arguments',
          'audience must be current_corner or parent_room.',
        );
      }
      const cornerId = binding.channelId === binding.roomId ? undefined : binding.channelId;
      if (raw.corner_id !== undefined && raw.corner_id !== cornerId) {
        throw new AgentToolKnownFailure(
          'corner_scope_mismatch',
          'The requested artifact scope is outside this session binding.',
        );
      }
      return {
        type: action,
        workspaceId: binding.workspaceId,
        roomId: binding.roomId,
        ...(cornerId ? { cornerId } : {}),
        audience,
      };
    }
    this.assertToolArgKeys(raw, ['type', 'schedule_id', 'repository_key', 'target_ref']);
    const scheduleId = this.stringToolArg(raw, 'schedule_id', { max: 256 });
    if (
      (raw.repository_key !== undefined && raw.repository_key !== repositoryKey) ||
      (raw.target_ref !== undefined && raw.target_ref !== targetRef)
    ) {
      throw new AgentToolKnownFailure(
        'repository_scope_mismatch',
        'The requested schedule scope is outside this session binding.',
      );
    }
    return {
      type: action,
      workspaceId: binding.workspaceId,
      roomId: binding.roomId,
      ...(scheduleId ? { scheduleId } : {}),
      ...(repositoryKey && targetRef ? { repositoryKey, targetRef } : {}),
    };
  }

  private async invokeRequestMandateTool(
    binding: { channelId: string; roomId: string; workspaceId: string },
    args: Record<string, unknown>,
  ): Promise<RequestMandateResult> {
    try {
      this.assertToolArgKeys(args, ['action', 'scope', 'beneficiary']);
      const action = this.stringToolArg(args, 'action', { required: true, max: 64 });
      if (!(BEELINE_ACTION_TOKENS as readonly string[]).includes(action!)) {
        throw new AgentToolKnownFailure(
          'unknown_action',
          'The requested action is not in this schema version.',
        );
      }
      const beneficiary =
        this.stringToolArg(args, 'beneficiary', { max: 64 }) ?? this.agentIdentity.publicKey;
      if (!/^[0-9a-f]{64}$/.test(beneficiary)) {
        throw new AgentToolKnownFailure(
          'invalid_arguments',
          'beneficiary must be a canonical agent public key.',
        );
      }
      if (beneficiary !== this.agentIdentity.publicKey) {
        return {
          status: 'denied',
          code: 'sponsor_authority_required',
          message: 'Sponsoring another beneficiary requires an explicit sponsor mandate.',
        };
      }
      const scope = await this.mandateScopeFromToolArgs(
        binding,
        action as BeelineActionToken,
        this.objectToolArg(args, 'scope'),
      );
      const direct = await this.agentToolKernel.authorizeOrRequest({
        action: action as BeelineActionToken,
        scope,
        dedupKey: this.agentToolDedupKey(
          binding.channelId,
          'request_mandate',
          JSON.stringify({ action, scope, beneficiary }),
        ),
        readMandate: () =>
          this.host.currentAgentToolMandate(binding.workspaceId, binding.roomId, scope),
        execute: async (mandate) => ({
          event_id: mandate.generation.event_id,
          result: { mandate },
        }),
        requestApproval: async () => {
          if (scope.type !== 'corner.close' || scope.disposition !== 'land') {
            throw new AgentToolKnownFailure(
              'approval_unavailable',
              'This mandate action cannot create an approval request.',
            );
          }
          const info = this.subchannels.get(scope.cornerId);
          const turnId = this.activePermissionTurns.get(binding.channelId)?.requestId;
          if (!info || !turnId) {
            throw new AgentToolKnownFailure(
              'no_active_turn',
              'This mandate request requires an active corner turn.',
            );
          }
          const pending = await this.prepareToolCloseForReview(info, turnId);
          return {
            request_id: pending.requestId,
            event_id: pending.eventId,
            message: 'The exact reviewed tip is frozen and waiting for owner approval.',
          };
        },
      });
      if (direct.status !== 'executed') return direct;
      const mandate = direct.result.mandate;
      return {
        status: 'granted',
        event_id: direct.event_id,
        generation: mandate.generation,
        beneficiary,
        action: action as BeelineActionToken,
        scope,
      };
    } catch (error) {
      return this.agentToolFailure(error) as RequestMandateResult;
    }
  }

  private scheduleIndexKey(workspaceId: string): string {
    return `buzz-agent-tool-schedules:${workspaceId}:${this.agentIdentity.publicKey}`;
  }

  async readAgentToolScheduleIds(workspaceId: string): Promise<string[]> {
    const key = this.scheduleIndexKey(workspaceId);
    const events = await this.agentRelay.queryEvents([
      { kinds: [WORK_SCHEDULE_KIND], '#d': [key], limit: 20 },
    ]);
    const latest = events
      .filter(
        (event) =>
          verifyEvent(event) &&
          event.pubkey === this.agentIdentity.publicKey &&
          event.tags.some((tag) => tag[0] === 'd' && tag[1] === key) &&
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'beeline-agent-tool-schedules'),
      )
      .sort(
        (left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id),
      )[0];
    if (!latest) return [];
    try {
      const value = JSON.parse(latest.content) as { schedule_ids?: unknown };
      if (!Array.isArray(value.schedule_ids)) return [];
      return [
        ...new Set(
          value.schedule_ids.filter(
            (item): item is string =>
              typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(item),
          ),
        ),
      ].sort();
    } catch {
      return [];
    }
  }

  async writeAgentToolScheduleIndex(
    workspaceId: string,
    scheduleIds: readonly string[],
  ): Promise<NostrEvent> {
    const key = this.scheduleIndexKey(workspaceId);
    const event = signEvent(
      {
        pubkey: this.agentIdentity.publicKey,
        created_at: Math.floor(Date.now() / 1_000),
        kind: WORK_SCHEDULE_KIND,
        tags: [
          ['d', key],
          ['t', 'beeline-agent-tool-schedules'],
          ['workspace', workspaceId],
          ['agent', this.agentIdentity.publicKey],
        ],
        content: JSON.stringify({ version: 1, schedule_ids: [...new Set(scheduleIds)].sort() }),
      },
      this.agentIdentity.secretKey,
    );
    await publishEvent(event, this.agentIdentity);
    return event;
  }

  async readAgentToolSchedules(workspaceId: string, roomId: string): Promise<ParsedWorkSchedule[]> {
    const scheduleIds = await this.host.agentToolScheduleIds(workspaceId);
    if (scheduleIds.length === 0) return [];
    const events = await this.agentRelay.queryEvents(
      scheduleIds.map((scheduleId) => ({
        kinds: [WORK_SCHEDULE_KIND],
        '#d': [
          workScheduleKey({
            workspaceId,
            agentPubkey: this.agentIdentity.publicKey,
            scheduleId,
          }),
        ],
        limit: 20,
      })),
    );
    const latest = new Map<string, ParsedWorkSchedule>();
    for (const event of events) {
      const parsed = parseWorkSchedule(event);
      if (
        !parsed ||
        parsed.value.workspaceId !== workspaceId ||
        parsed.value.roomId !== roomId ||
        parsed.value.agentPubkey !== this.agentIdentity.publicKey
      ) {
        continue;
      }
      const current = latest.get(parsed.value.scheduleId);
      if (
        !current ||
        parsed.value.revision > current.value.revision ||
        (parsed.value.revision === current.value.revision &&
          (parsed.event.created_at > current.event.created_at ||
            (parsed.event.created_at === current.event.created_at &&
              parsed.event.id.localeCompare(current.event.id) > 0)))
      ) {
        latest.set(parsed.value.scheduleId, parsed);
      }
    }
    return [...latest.values()].sort((left, right) =>
      left.value.scheduleId.localeCompare(right.value.scheduleId),
    );
  }

  private scheduleConfigurationArg(value: unknown): ScheduleConfigurationInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AgentToolKnownFailure('invalid_arguments', 'schedule must be an object.');
    }
    const input = value as Record<string, unknown>;
    this.assertToolArgKeys(input, [
      'operation',
      'cadence',
      'starts_at',
      'expires_at',
      'max_runs',
      'per_run_reserved_tokens',
      'daily_reserved_tokens',
      'catch_up',
      'max_consecutive_failures',
    ]);
    const operation = this.objectToolArg(input, 'operation');
    this.assertToolArgKeys(operation, ['type', 'prompt']);
    if (operation.type !== 'agent_turn') {
      throw new AgentToolKnownFailure(
        'invalid_schedule',
        'The scheduled operation type is not supported.',
      );
    }
    this.stringToolArg(operation, 'prompt', { required: true, max: 32_000 });
    return input as unknown as ScheduleConfigurationInput;
  }

  private workScheduleFromToolInput(input: {
    binding: { roomId: string; workspaceId: string };
    scheduleId: string;
    revision: number;
    config: ScheduleConfigurationInput;
    mandate: ReadMandateResult;
  }): WorkScheduleV1 {
    const now = Math.floor(Date.now() / 1_000);
    const cadence =
      input.config.cadence.type === 'daily'
        ? {
            type: 'daily' as const,
            localTime: input.config.cadence.local_time,
            timezone: input.config.cadence.timezone,
          }
        : input.config.cadence.type === 'interval'
          ? {
              type: 'interval' as const,
              everySeconds: input.config.cadence.every_seconds,
              anchorAt: input.config.cadence.anchor_at ?? input.config.starts_at ?? now,
            }
          : input.config.cadence;
    const candidate = parseWorkScheduleValue({
      version: 1,
      scheduleId: input.scheduleId,
      revision: input.revision,
      workspaceId: input.binding.workspaceId,
      roomId: input.binding.roomId,
      agentPubkey: this.agentIdentity.publicKey,
      principalPubkey: this.agentIdentity.publicKey,
      prompt: input.config.operation.prompt,
      execution: { mode: 'model' },
      cadence,
      startsAt: input.config.starts_at ?? now,
      expiresAt: input.config.expires_at,
      maxRuns: input.config.max_runs,
      perRunReservedTokens: input.config.per_run_reserved_tokens,
      dailyReservedTokens: input.config.daily_reserved_tokens,
      catchUp: input.config.catch_up === 'latest_one' ? 'latest-one' : input.config.catch_up,
      maxConsecutiveFailures: input.config.max_consecutive_failures,
      status: 'active',
      agentToolMandate: {
        eventId: input.mandate.generation.event_id,
        defaultsVersion: BEELINE_MANDATE_DEFAULTS_VERSION,
      },
    });
    if (!candidate) {
      throw new AgentToolKnownFailure(
        'invalid_schedule',
        'The schedule payload violates the calendar bounds or cadence rules.',
      );
    }
    return candidate;
  }

  private async invokeScheduleTool(
    binding: { channelId: string; roomId: string; workspaceId: string },
    args: Record<string, unknown>,
  ): Promise<DirectToolResult<unknown>> {
    try {
      this.assertToolArgKeys(args, ['operation', 'schedule_id', 'schedule']);
      const rawOperation = this.stringToolArg(args, 'operation', { required: true, max: 32 });
      if (!(BEELINE_SCHEDULE_OPERATIONS as readonly string[]).includes(rawOperation!)) {
        throw new AgentToolKnownFailure('invalid_arguments', 'Unknown schedule operation.');
      }
      const operation = rawOperation as BeelineScheduleOperation;
      const scheduleId = this.stringToolArg(args, 'schedule_id', { max: 256 });
      if (operation !== 'list' && !scheduleId) {
        throw new AgentToolKnownFailure(
          'invalid_arguments',
          'schedule_id is required for this operation.',
        );
      }
      const suppliedConfig =
        args.schedule === undefined ? undefined : this.scheduleConfigurationArg(args.schedule);
      if ((operation === 'create' || operation === 'update') !== Boolean(suppliedConfig)) {
        throw new AgentToolKnownFailure(
          'invalid_arguments',
          'schedule is required only for create and update.',
        );
      }
      const action = `schedule.${operation}` as BeelineActionToken;
      const roomRepo = this.agentToolRoomRepositories.get(binding.roomId);
      const scope: BeelineActionScope = {
        type: action as `schedule.${BeelineScheduleOperation}`,
        workspaceId: binding.workspaceId,
        roomId: binding.roomId,
        ...(scheduleId ? { scheduleId } : {}),
        ...(roomRepo
          ? {
              repositoryKey:
                roomRepo.truth?.binding.key ?? roomRepo.repositoryKey ?? this.repoId(roomRepo),
              targetRef: roomRepo.targetBranch ?? 'refs/heads/main',
            }
          : {}),
      };
      return await this.agentToolKernel.authorizeOrRequest<unknown>({
        action,
        scope,
        dedupKey: this.agentToolDedupKey(
          binding.channelId,
          'schedule',
          JSON.stringify({ operation, scheduleId, suppliedConfig }),
        ),
        readMandate: () =>
          this.host.currentAgentToolMandate(binding.workspaceId, binding.roomId, scope),
        execute: async (mandate) => {
          const schedules = await this.host.agentToolSchedules(binding.workspaceId, binding.roomId);
          const current = schedules.find((item) => item.value.scheduleId === scheduleId);
          if (operation === 'list') {
            return {
              event_id: mandate.generation.event_id,
              result: {
                schedules: schedules.map((item) => ({
                  event_id: item.event.id,
                  schedule: item.value,
                })),
              },
            };
          }
          if (operation === 'get') {
            if (!current) {
              throw new AgentToolKnownFailure('schedule_not_found', 'The schedule was not found.');
            }
            return { event_id: current.event.id, result: { schedule: current.value } };
          }
          if (operation === 'run_now') {
            if (!current || current.value.status !== 'active') {
              throw new AgentToolKnownFailure(
                'schedule_not_runnable',
                'The active schedule was not found.',
              );
            }
            if (!this.runScheduleNow) {
              throw new AgentToolKnownFailure(
                'calendar_unavailable',
                'The durable work calendar is unavailable.',
                true,
              );
            }
            const run = await this.runScheduleNow(current.value.scheduleId);
            return {
              event_id: run.eventId,
              result: { schedule_id: current.value.scheduleId, run_id: run.runId },
            };
          }
          let next: WorkScheduleV1;
          if (operation === 'create') {
            if (current) {
              throw new AgentToolKnownFailure(
                'schedule_exists',
                'A schedule with this id already exists.',
              );
            }
            next = this.workScheduleFromToolInput({
              binding,
              scheduleId: scheduleId!,
              revision: 1,
              config: suppliedConfig!,
              mandate,
            });
          } else {
            if (!current || current.value.status === 'cancelled') {
              throw new AgentToolKnownFailure('schedule_not_found', 'The schedule was not found.');
            }
            if (operation === 'update') {
              next = this.workScheduleFromToolInput({
                binding,
                scheduleId: scheduleId!,
                revision: current.value.revision + 1,
                config: suppliedConfig!,
                mandate,
              });
            } else {
              next = {
                ...current.value,
                revision: current.value.revision + 1,
                status:
                  operation === 'resume'
                    ? 'active'
                    : operation === 'cancel'
                      ? 'cancelled'
                      : 'paused',
                agentToolMandate: {
                  eventId: mandate.generation.event_id,
                  defaultsVersion: BEELINE_MANDATE_DEFAULTS_VERSION,
                },
              };
            }
          }
          const event = buildWorkSchedule(this.agentIdentity, next);
          await publishEvent(event, this.agentIdentity);
          const ids = new Set(await this.host.agentToolScheduleIds(binding.workspaceId));
          ids.add(next.scheduleId);
          await this.host.publishAgentToolScheduleIndex(binding.workspaceId, [...ids]);
          return {
            event_id: event.id,
            result: {
              schedule_id: next.scheduleId,
              revision: next.revision,
              status: next.status,
            },
          };
        },
        requestApproval: async () => {
          throw new AgentToolKnownFailure(
            'approval_unavailable',
            'Schedule operations are default-granted and cannot create a second grant path.',
          );
        },
      });
    } catch (error) {
      return this.agentToolFailure(error);
    }
  }

  private async invokeOpenCornerTool(
    binding: { channelId: string; roomId: string; workspaceId: string },
    args: Record<string, unknown>,
  ): Promise<DirectToolResult<{ corner_id: string; feature_ref: string }>> {
    try {
      const objective = this.stringToolArg(args, 'objective', { required: true, max: 2_000 })!;
      const requestedRepository = this.stringToolArg(args, 'repository', { max: 512 });
      const roomRepo = this.agentToolRoomRepositories.get(binding.roomId);
      if (!roomRepo) {
        throw new AgentToolKnownFailure(
          'repository_unavailable',
          'This Room has no host-bound repository for a corner.',
        );
      }
      const repositoryKey =
        roomRepo.truth?.binding.key ?? roomRepo.repositoryKey ?? this.repoId(roomRepo);
      if (
        requestedRepository &&
        requestedRepository !== repositoryKey &&
        requestedRepository !== this.repoId(roomRepo)
      ) {
        throw new AgentToolKnownFailure(
          'repository_scope_mismatch',
          'The requested repository is outside this session binding.',
        );
      }
      const scope: BeelineActionScope = {
        type: 'corner.open',
        workspaceId: binding.workspaceId,
        roomId: binding.roomId,
        repositoryKey,
        targetRef: roomRepo.targetBranch ?? 'refs/heads/main',
      };
      const pending = this.pendingRoomTurns.get(binding.roomId);
      const sourceCorner = this.subchannels.get(binding.channelId);
      const request = pending?.request ?? sourceCorner?.request;
      if (!request) {
        throw new AgentToolKnownFailure(
          'triggering_request_unavailable',
          'open_corner requires a triggering human Room request.',
        );
      }
      const directlyAuthorized =
        !request.delegation &&
        (await this.requesterCanOpenCornerDirectly(binding.roomId, request.authorPubkey));
      const readMandate = async () => {
        const mandate = await this.host.currentAgentToolMandate(
          binding.workspaceId,
          binding.roomId,
          scope,
        );
        return directlyAuthorized
          ? {
              ...mandate,
              grants: [
                ...mandate.grants,
                {
                  action: 'corner.open' as const,
                  scope,
                  source: 'default' as const,
                  event_id: mandate.generation.event_id,
                },
              ],
            }
          : mandate;
      };
      return await this.agentToolKernel.authorizeOrRequest<{
        corner_id: string;
        feature_ref: string;
      }>({
        action: 'corner.open',
        scope,
        dedupKey: this.agentToolDedupKey(binding.roomId, 'open_corner', request.eventId),
        readMandate,
        execute: async () => {
          const info = await this.openSubchannelForRequest(
            binding.roomId,
            roomRepo,
            objective,
            request,
            { objective },
          );
          this.startCornerTaskOnce(
            info,
            objective,
            this.host.cornerOpenTaskPrompt(info.taskDescription, objective),
            {
              requestId: request.eventId,
              originalRequestId: request.eventId,
              cause: 'corner-opening',
            },
          );
          const receipt = await this.publishAgentToolReceipt({
            channelId: binding.roomId,
            tool: 'open_corner',
            status: 'executed',
            action: 'corner.open',
            resultId: info.subchannelId,
            extraTags: [
              ['corner', info.subchannelId],
              ['feature', info.featureBranch],
            ],
          });
          return {
            event_id: receipt.id,
            result: { corner_id: info.subchannelId, feature_ref: info.featureBranch },
          };
        },
        requestApproval: () =>
          this.requestCornerApproval({
            roomId: binding.roomId,
            workspaceId: binding.workspaceId,
            roomRepo,
            request,
            objective,
            tool: 'open_corner',
          }),
      });
    } catch (error) {
      return this.agentToolFailure(error);
    }
  }

  private agentToolFailure<T>(error: unknown): DirectToolResult<T> {
    if (error instanceof AgentToolKnownFailure) {
      return {
        status: 'failed',
        code: error.code,
        retryable: error.retryable,
        message: error.safeMessage,
      };
    }
    console.error('[body] Beeline agent tool failed:', error);
    return {
      status: 'failed',
      code: 'host_action_failed',
      retryable: false,
      message: 'The Beeline host could not complete this action.',
    };
  }

  private async prepareToolCloseForReview(
    info: SubchannelInfo,
    turnId: string,
    suspendWriter = true,
  ): Promise<{ requestId: string; eventId: string; sourceSha: string; targetRef: string }> {
    if (!(await this.publishMergeReady(info)) || !info.mergeTarget || !info.mergeReadyEventId) {
      throw new AgentToolKnownFailure(
        'corner_not_reviewable',
        'The corner is not reviewable. Commit intended changes and resolve dirty or untracked files.',
      );
    }
    const pending = {
      turnId,
      sourceSha: info.mergeTarget.tip,
      targetRef: info.mergeTarget.branch,
      requestId: info.mergeReadyEventId,
      eventId: info.mergeReadyEventId,
    };
    info.toolClosePending = pending;
    // End this physical writer shortly after its result crosses MCP. New turns
    // are rejected by the pending-close guard below; the worktree stays intact
    // for the existing landing pipeline.
    if (suspendWriter) {
      const timer = setTimeout(() => {
        try {
          info.session.client.sessionCancel(info.session.sessionId);
        } catch {
          // A completed/retired turn is already frozen.
        }
        void this.scheduler
          .forceSuspend(info.subchannelId)
          .catch((error) =>
            console.error(`[body] pending close suspend failed for ${info.subchannelId}:`, error),
          );
      }, 250);
      timer.unref?.();
    }
    return pending;
  }

  private async invokeCloseCornerTool(
    binding: { channelId: string; roomId: string; workspaceId: string },
    args: Record<string, unknown>,
  ): Promise<
    DirectToolResult<{
      corner_id: string;
      disposition: CloseCornerDisposition;
      state: 'closed';
      landed_tip?: string;
    }>
  > {
    try {
      const cornerId = this.stringToolArg(args, 'corner_id', { required: true, max: 256 })!;
      const rawDisposition = this.stringToolArg(args, 'disposition', { required: true, max: 16 });
      if (rawDisposition !== 'land' && rawDisposition !== 'abandon') {
        throw new AgentToolKnownFailure(
          'invalid_arguments',
          'disposition must be land or abandon.',
        );
      }
      const disposition: CloseCornerDisposition = rawDisposition;
      if (binding.channelId !== cornerId) {
        throw new AgentToolKnownFailure(
          'corner_scope_mismatch',
          'close_corner may close only the current bound corner.',
        );
      }
      const info = this.subchannels.get(cornerId);
      if (!info || info.archived || info.session.parentChannelId !== binding.roomId) {
        throw new AgentToolKnownFailure('corner_unavailable', 'The bound corner is unavailable.');
      }
      const head = (await git(info.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(head)) {
        throw new AgentToolKnownFailure('corner_tip_unavailable', 'The corner tip is unavailable.');
      }
      const scope: BeelineActionScope = {
        type: 'corner.close',
        workspaceId: binding.workspaceId,
        roomId: binding.roomId,
        cornerId,
        disposition,
        ...(info.boundRepo
          ? {
              repositoryKey:
                info.boundRepo.truth?.binding.key ??
                info.boundRepo.repositoryKey ??
                this.repoId(info.boundRepo),
              targetRef: info.boundRepo.targetBranch ?? 'refs/heads/main',
              sourceSha: head,
            }
          : {}),
      };
      const turnId = this.activePermissionTurns.get(binding.channelId)?.requestId;
      if (!turnId) {
        throw new AgentToolKnownFailure('no_active_turn', 'This tool requires an active turn.');
      }
      return await this.agentToolKernel.authorizeOrRequest<{
        corner_id: string;
        disposition: CloseCornerDisposition;
        state: 'closed';
        landed_tip?: string;
      }>({
        action: 'corner.close',
        scope,
        dedupKey: this.agentToolDedupKey(
          binding.channelId,
          'close_corner',
          `${cornerId}:${disposition}`,
        ),
        readMandate: () =>
          this.host.currentAgentToolMandate(binding.workspaceId, binding.roomId, scope),
        execute: async () => {
          if (disposition === 'abandon') {
            const receipt = await this.publishAgentToolReceipt({
              channelId: cornerId,
              tool: 'close_corner',
              status: 'executed',
              action: 'corner.close',
              resultId: cornerId,
              extraTags: [['disposition', 'abandon']],
            });
            await this.archiveSubchannel(cornerId);
            return {
              event_id: receipt.id,
              result: { corner_id: cornerId, disposition, state: 'closed' as const },
            };
          }
          await this.prepareToolCloseForReview(info, turnId, false);
          await this.runApprovalLandingPass(
            binding.roomId,
            this.roomMergeGates.get(binding.roomId),
          );
          await this.pollMergeCompletions();
          if (!info.landedTip) {
            throw new AgentToolKnownFailure(
              'landing_not_confirmed',
              'The target ref has not confirmed the reviewed tip.',
              true,
            );
          }
          const receipt = await this.publishAgentToolReceipt({
            channelId: binding.roomId,
            tool: 'close_corner',
            status: 'executed',
            action: 'corner.close',
            resultId: cornerId,
            extraTags: [
              ['corner', cornerId],
              ['disposition', 'land'],
              ['tip', info.landedTip],
            ],
          });
          return {
            event_id: receipt.id,
            result: {
              corner_id: cornerId,
              disposition,
              state: 'closed' as const,
              landed_tip: info.landedTip,
            },
          };
        },
        requestApproval: async () => {
          const pending = await this.prepareToolCloseForReview(info, turnId);
          return {
            request_id: pending.requestId,
            event_id: pending.eventId,
            message: 'The exact reviewed tip is frozen and waiting for owner approval.',
          };
        },
      });
    } catch (error) {
      return this.agentToolFailure(error);
    }
  }

  private async invokeDeliverTool(
    binding: { channelId: string; roomId: string; workspaceId: string },
    args: Record<string, unknown>,
  ): Promise<
    DirectToolResult<{
      artifact_id: string;
      url: string;
      name: string;
      sha256: string;
      size: number;
      mime_type: string;
    }>
  > {
    try {
      const path = this.stringToolArg(args, 'path');
      const content = args.content;
      const suppliedName = this.stringToolArg(args, 'name', { max: 255 });
      if ((path ? 1 : 0) + (typeof content === 'string' ? 1 : 0) !== 1) {
        throw new AgentToolKnownFailure(
          'invalid_arguments',
          'deliver requires exactly one of path or inline content.',
        );
      }
      if (content !== undefined && (typeof content !== 'string' || !suppliedName)) {
        throw new AgentToolKnownFailure(
          'invalid_arguments',
          'Inline delivery requires name and string content.',
        );
      }
      if (typeof content === 'string' && content.length > 1_000_000) {
        throw new AgentToolKnownFailure(
          'artifact_too_large',
          'Inline artifact content is too large.',
        );
      }
      const rawAudience = this.stringToolArg(args, 'audience', { max: 32 });
      if (
        rawAudience !== undefined &&
        rawAudience !== 'current_corner' &&
        rawAudience !== 'parent_room'
      ) {
        throw new AgentToolKnownFailure(
          'invalid_arguments',
          'audience must be current_corner or parent_room.',
        );
      }
      const audience: DeliverAudience = rawAudience ?? 'current_corner';
      const session = this.sessions.get(binding.channelId);
      if (!session)
        throw new AgentToolKnownFailure('session_unavailable', 'The session is unavailable.');
      const name = suppliedName ?? basename(path!);
      const mimeType = mimeTypeForName(name);
      if (!isAllowedAgentAttachmentMimeType(mimeType)) {
        throw new AgentToolKnownFailure(
          'artifact_type_denied',
          'This artifact type is not allowed.',
        );
      }
      const scope: BeelineActionScope = {
        type: 'artifact.deliver',
        workspaceId: binding.workspaceId,
        roomId: binding.roomId,
        ...(binding.channelId !== binding.roomId ? { cornerId: binding.channelId } : {}),
        audience,
      };
      return await this.agentToolKernel.authorizeOrRequest({
        action: 'artifact.deliver',
        scope,
        dedupKey: this.agentToolDedupKey(
          binding.channelId,
          'deliver',
          `${audience}:${name}:${
            path ??
            createHash('sha256')
              .update(content as string)
              .digest('hex')
          }`,
        ),
        readMandate: () =>
          this.host.currentAgentToolMandate(binding.workspaceId, binding.roomId, scope),
        execute: async () => {
          const bytes = await this.candidateBytes(session, {
            name,
            mimeType,
            ...(path ? { path } : { bytes: new TextEncoder().encode(content as string) }),
          });
          const canonical = canonicalizeImageForUpload(bytes, mimeType);
          const channelId = audience === 'parent_room' ? binding.roomId : binding.channelId;
          const members = await listMembers(this.agentClientContext(), channelId);
          if (!members.some((member) => member.pubkey === this.agentIdentity.publicKey)) {
            throw new AgentToolKnownFailure(
              'audience_membership_missing',
              'Current audience membership could not be verified.',
            );
          }
          const client = createBuzzClient({
            baseUrl: this.config.relayBaseUrl,
            host: this.config.relayHost,
            identity: this.agentIdentity,
          });
          try {
            const uploaded = await client.uploadMedia(canonical, mimeType);
            const uploadedMimeType = uploaded.type ?? mimeType;
            const attachment: AttachmentReference = {
              url: uploaded.url,
              name: basename(name),
              mimeType: uploadedMimeType,
              size: uploaded.size,
              sha256: uploaded.sha256,
              ...(previewUrlForAgentAttachment(uploaded.url, uploadedMimeType)
                ? {
                    previewUrl: previewUrlForAgentAttachment(uploaded.url, uploadedMimeType),
                  }
                : {}),
            };
            const note =
              this.stringToolArg(args, 'note', { max: 600 }) ?? `Shared ${attachment.name}.`;
            const event = buildAgentMessage(
              channelId,
              this.agentIdentity,
              note,
              undefined,
              [attachment],
              [
                ['artifact-delivery', 'beeline-agent-tool'],
                ['x', uploaded.sha256],
                ['size', String(uploaded.size)],
              ],
            );
            await publishEvent(event, this.agentIdentity);
            return {
              event_id: event.id,
              result: {
                artifact_id: event.id,
                url: uploaded.url,
                name: attachment.name,
                sha256: uploaded.sha256,
                size: uploaded.size,
                mime_type: uploadedMimeType,
              },
            };
          } finally {
            client.disconnect();
          }
        },
        requestApproval: async () => {
          throw new AgentToolKnownFailure(
            'approval_unavailable',
            'Artifact delivery is not requestable.',
          );
        },
      });
    } catch (error) {
      return this.agentToolFailure(error);
    }
  }
}
