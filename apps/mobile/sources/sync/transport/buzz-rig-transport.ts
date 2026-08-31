import type { MessageSubmitInput, SessionId } from './rig-transport';
import {
  RoomViewClient,
  createBuzzClient,
  buildAttachmentTags,
  getAuthCapabilities,
  listGitHubRepositories,
  startGitHubInstallation,
  createGitHubRepository,
  getGitHubRepositoryAccess,
  type AgentCommandList,
  type AttachmentReference,
  type BuzzClient,
  type GitHubInstallationAccess,
  type GitHubRepositoryAccessResult,
  type Identity,
  type KnownMessageReference,
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
