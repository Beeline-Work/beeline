import type { ChangedFile, MessageSubmitInput, SessionId } from './rig-transport';
import {
  RoomViewClient,
  createBuzzClient,
  buildAttachmentTags,
  getAuthCapabilities,
  listGitHubRepositories,
  startGitHubInstallation,
  createGitHubRepository,
  getGitHubRepositoryAccess,
  parseChangeReviewArtifact,
  type AgentCommandList,
  type AttachmentReference,
  type BuzzClient,
  type ChangeReviewArtifact,
  type ChangeReviewArtifactDescriptor,
  type GitHubInstallationAccess,
  type GitHubRepositoryAccessResult,
  type Identity,
  type KnownMessageReference,
  type MergeTarget,
  type RoomRepository,
  type RoomRepositoryInput,
  type WritePermissionDecision,
} from '@beeline/buzz-client';
import type { NostrEvent } from '@beeline/nostr';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { dedupeRepoCandidates } from '@/buzz/room-repo-picker';

let sharedClientEntry: { key: string; client: BuzzClient } | undefined;

function sharedClient(identity: Identity, baseUrl: string): BuzzClient {
  const normalized = baseUrl.replace(/\/$/, '');
  const key = `${normalized}\u0000${identity.publicKey}`;
  if (sharedClientEntry?.key === key) return sharedClientEntry.client;
  sharedClientEntry?.client.disconnect();
  const client = createBuzzClient({ baseUrl: normalized, identity, batchQueries: true });
  sharedClientEntry = { key, client };
  return client;
}

/**
 * Write/signing adapter only. All Room/Workspace reads live in RoomViewClient;
 * this class intentionally has no backfill, parser, reducer, selector, or
 * snapshot API.
 */
export class BuzzRigTransport {
  private client: BuzzClient | null = null;
  private readonly outgoingPublishes = new Map<string, Promise<string>>();
  private readonly reviewArtifacts = new Map<string, Promise<ChangeReviewArtifact>>();

  constructor(
    private readonly identity: Identity,
    private readonly baseUrl: string = getBuzzRuntimeConfig().relayUrl,
  ) {}

  private async getClient(): Promise<BuzzClient> {
    this.client ??= sharedClient(this.identity, this.baseUrl);
    return this.client;
  }

  async ensureClient(): Promise<BuzzClient> {
    return this.getClient();
  }

  private views(): RoomViewClient {
    return new RoomViewClient({ baseUrl: this.baseUrl, identity: this.identity });
  }

  async composeMessage(
    input: MessageSubmitInput,
    opts?: { mentionAgent?: string; mentionPubkeys?: string[] },
  ): Promise<NostrEvent> {
    const attachmentTags = buildAttachmentTags(input.attachments ?? []);
    return (await this.getClient()).buildMessage(input.sessionId, input.text, {
      ...(opts?.mentionAgent ? { mentionAgent: opts.mentionAgent } : {}),
      ...(opts?.mentionPubkeys?.length ? { mentionPubkeys: opts.mentionPubkeys } : {}),
      ...(attachmentTags.length ? { extraTags: attachmentTags } : {}),
    });
  }

  async publishPreparedMessage(event: NostrEvent): Promise<string> {
    const existing = this.outgoingPublishes.get(event.id);
    if (existing) return existing;
    const publish = this.getClient()
      .then((client) => client.publish(event))
      .then(() => event.id)
      .finally(() => {
        if (this.outgoingPublishes.get(event.id) === publish)
          this.outgoingPublishes.delete(event.id);
      });
    this.outgoingPublishes.set(event.id, publish);
    return publish;
  }

  async composeReplyMessage(
    text: string,
    parent: KnownMessageReference,
    mentionAgent?: string,
    attachments: AttachmentReference[] = [],
    mentionPubkeys: string[] = [],
  ): Promise<NostrEvent> {
    const attachmentTags = buildAttachmentTags(attachments);
    return (await this.getClient()).buildReplyMessage(text, parent, {
      ...(mentionAgent ? { mentionAgent } : {}),
      ...(mentionPubkeys.length ? { mentionPubkeys } : {}),
      ...(attachmentTags.length ? { contentTags: attachmentTags } : {}),
    });
  }

  async respondToWritePermission(
    channelId: string,
    permissionId: string,
    requestId: string,
    agentPubkey: string,
    decision: WritePermissionDecision,
    repository: string,
  ): Promise<string> {
    const event = await (
      await this.getClient()
    ).respondToWritePermission(
      channelId,
      permissionId,
      requestId,
      agentPubkey,
      decision,
      repository,
    );
    return event.id;
  }

  async inviteAgentToChannel(
    channelId: string,
    agentPubkey: string,
    communityId: string,
  ): Promise<boolean> {
    return (
      await (await this.getClient()).attachAgentToChannel(channelId, agentPubkey, communityId)
    ).joined;
  }

  async inviteWorkspaceMemberToChannel(
    channelId: string,
    memberPubkey: string,
    communityId: string,
  ): Promise<boolean> {
    return (
      await (
        await this.getClient()
      ).attachCommunityMemberToChannel(channelId, memberPubkey, communityId)
    ).joined;
  }

  async removeRoomMember(channelId: string, memberPubkey: string): Promise<void> {
    await (await this.getClient()).removeRoomMember(channelId, memberPubkey);
  }

  async leaveRoom(channelId: string): Promise<void> {
    await (await this.getClient()).leaveRoom(channelId);
  }

  async deleteRoom(channelId: string): Promise<void> {
    await (await this.getClient()).deleteRoom(channelId);
  }

  async leaveWorkspace(communityId: string): Promise<void> {
    await (await this.getClient()).leaveWorkspace(communityId);
  }

  async resolveDirectMessage(
    communityId: string,
    otherPubkey: string,
  ): Promise<{ channelId: string; created: boolean }> {
    const result = await (await this.getClient()).resolveDirectMessage(communityId, otherPubkey);
    return { channelId: result.directMessage.channelId, created: result.created };
  }

  async closeCorner(subchannelId: string): Promise<void> {
    await (
      await this.getClient()
    ).messageSubmit(subchannelId, 'Close this corner.', {
      extraTags: [['t', 'buzz-corner-close']],
    });
  }

  /** Commands are moving into the agent surface; no raw relay fallback is permitted. */
  async agentCommandsRead(
    _channelId: string,
    _agentPubkey: string,
    _fallbackWorkspaceRootId?: string,
  ): Promise<AgentCommandList | null> {
    return null;
  }

  async roomRepositorySet(
    channelId: string,
    input: RoomRepositoryInput & { communityId?: string },
  ): Promise<RoomRepository> {
    return (await this.getClient()).setRoomRepository(channelId, input);
  }

  async roomTargetBranchSet(channelId: string, targetBranch: string): Promise<RoomRepository> {
    return (await this.getClient()).setRoomTargetBranch(channelId, targetBranch);
  }

  async roomGitHubEventsSet(channelId: string, enabled: boolean): Promise<RoomRepository> {
    return (await this.getClient()).setRoomGitHubEvents(channelId, enabled);
  }

  async workspaceRoomRepositoryCandidates(_communityId: string): Promise<RepoCandidate[]> {
    const capabilities = await getAuthCapabilities(this.baseUrl).catch(() => undefined);
    if (!capabilities?.github) return [];
    const access = await listGitHubRepositories(this.baseUrl, this.identity);
    return dedupeRepoCandidates(
      access.repositories.map((repo) => ({
        key: `github:${repo.id}`,
        name: repo.fullName,
        remote: `git://github.com/${repo.fullName}`,
        githubInstallationId: repo.installationId,
        defaultBranch: repo.defaultBranch,
      })),
    );
  }

  async workspaceGitHubAccess(options: { refresh?: boolean } = {}): Promise<{
    installed: boolean;
    installations: GitHubInstallationAccess[];
    candidates: RepoCandidate[];
  }> {
    const access = await listGitHubRepositories(this.baseUrl, this.identity, options);
    return {
      installed: access.installed,
      installations: access.installations,
      candidates: dedupeRepoCandidates(
        access.repositories.map((repo) => ({
          key: `github:${repo.id}`,
          name: repo.fullName,
          remote: `git://github.com/${repo.fullName}`,
          githubInstallationId: repo.installationId,
          defaultBranch: repo.defaultBranch,
        })),
      ),
    };
  }

  githubInstallationStart(redirectUri: string, installationId?: number): Promise<string> {
    return startGitHubInstallation(this.baseUrl, this.identity, redirectUri, installationId);
  }

  async githubRepositoryCreate(input: {
    installationId: number;
    name: string;
    description?: string;
    private?: boolean;
  }): Promise<RepoCandidate> {
    const repository = await createGitHubRepository(this.baseUrl, this.identity, input);
    return {
      key: `github:${repository.id}`,
      name: repository.fullName,
      remote: `git://github.com/${repository.fullName}`,
      githubInstallationId: repository.installationId,
      defaultBranch: repository.defaultBranch,
    };
  }

  githubRepositoryAccess(fullName: string): Promise<GitHubRepositoryAccessResult> {
    return getGitHubRepositoryAccess(this.baseUrl, this.identity, fullName);
  }

  private async readReviewArtifact(
    sessionId: string,
    descriptor: ChangeReviewArtifactDescriptor,
  ): Promise<ChangeReviewArtifact> {
    const key = `${sessionId}\u0000${descriptor.tip}\u0000${descriptor.sha256}`;
    const existing = this.reviewArtifacts.get(key);
    if (existing) return existing;
    const reading = (async () => {
      const response = await fetch(descriptor.url);
      if (!response.ok) throw new Error(`Review artifact download failed (${response.status})`);
      const artifact = parseChangeReviewArtifact(
        new Uint8Array(await response.arrayBuffer()),
        descriptor,
      );
      if (!artifact)
        throw new Error(
          `Review artifact failed integrity check for ${descriptor.tip.slice(0, 12)}`,
        );
      return artifact;
    })();
    this.reviewArtifacts.set(key, reading);
    void reading.catch(() => this.reviewArtifacts.delete(key));
    return reading;
  }

  async changedFileRead(
    sessionId: SessionId,
    path: string,
    reviewTip?: string,
  ): Promise<{ content: string; isBinary?: boolean } | null> {
    const review = (await this.views().room(sessionId)).review;
    const descriptor = review?.artifact;
    if (!descriptor || (reviewTip && descriptor.tip !== reviewTip)) return null;
    const artifact = await this.readReviewArtifact(sessionId, descriptor);
    const file = artifact.files.find((candidate) => candidate.path === path);
    if (!file || file.renderUnavailableReason === 'too-large') return null;
    if (file.diff === undefined) throw new Error(`Missing diff for ${path}`);
    return { content: file.diff, ...(file.isBinary ? { isBinary: true } : {}) };
  }

  async workspaceFilesRead(sessionId: SessionId, reviewTip?: string): Promise<ChangedFile[]> {
    const review = (await this.views().room(sessionId)).review;
    const descriptor = review?.artifact;
    if (!descriptor || (reviewTip && descriptor.tip !== reviewTip)) return [];
    const artifact = await this.readReviewArtifact(sessionId, descriptor);
    return artifact.files.map(({ diff: _diff, ...file }) => file);
  }

  async getSubchannelMergeTarget(
    subchannelId: string,
  ): Promise<
    { target: MergeTarget; channelId: string; authorPubkey: string } | { reason: string } | null
  > {
    const view = await this.views().room(subchannelId);
    for (const message of [...view.messages].reverse()) {
      if (message.merge?.action === 'not-ready')
        return message.text ? { reason: message.text } : null;
      if (
        message.merge?.action === 'ready' &&
        message.merge.repository &&
        message.merge.branch &&
        message.merge.tip
      ) {
        return {
          target: {
            repo: message.merge.repository,
            branch: message.merge.branch,
            tip: message.merge.tip,
          },
          channelId: view.parent?.id ?? '',
          authorPubkey: message.author.pubkey,
        };
      }
    }
    return null;
  }

  async submitMergeApproval(
    subchannelId: string,
    target: MergeTarget,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      await (await this.getClient()).submitMergeApproval(subchannelId, target);
      return { success: true, message: 'Approval sent for merge' };
    } catch (reason) {
      return { success: false, message: String(reason) };
    }
  }

  async submitMergeRejection(
    subchannelId: string,
    target: MergeTarget,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      await (await this.getClient()).submitMergeRejection(subchannelId, target);
      return { success: true, message: 'Rejection sent for review' };
    } catch (reason) {
      return { success: false, message: String(reason) };
    }
  }

  async isChannelArchived(channelId: string): Promise<boolean> {
    try {
      return (await this.views().room(channelId)).room.archived;
    } catch {
      return false;
    }
  }

  async getParentChannelId(channelId: string): Promise<string | null> {
    try {
      return (await this.views().room(channelId)).parent?.id ?? null;
    } catch {
      return null;
    }
  }

  getPubkey(): string {
    return this.identity.publicKey;
  }

  disconnect(): void {
    // Shared clients own the one authenticated socket for this viewer.
  }
}
