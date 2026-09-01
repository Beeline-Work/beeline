import { getRandomBytes } from 'expo-crypto';
import type { NostrEvent } from '@beeline/nostr';
import type {
  AttachmentReference,
  BuzzClient,
  Identity,
  KnownMessageReference,
  RoomRepository,
  RoomRepositoryInput,
  WritePermissionDecision,
} from '@beeline/buzz-client';
import type { MessageSubmitInput } from './rig-transport';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import type { RepoCandidate } from '@/buzz/room-repo-picker';

type LiveWireEvent =
  | { type: 'invalidate'; roomId: string; reason: string }
  | { type: 'draft' | 'thought'; roomId: string; agentId: string; turnId: string; text: string }
  | { type: 'retract'; roomId: string; agentId: string; turnId: string; kind: 'draft' | 'thought' }
  | {
      type: 'presence';
      roomId: string;
      agentId: string;
      status: 'online' | 'offline';
      observedAt: number;
    };

export type MonolithSurfaceEvent = { readonly monolithLive: LiveWireEvent };

function eventId(): string {
  return [...getRandomBytes(32)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function tag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((item) => item[0] === name)?.[1];
}

class MonolithClientAdapter {
  constructor(private readonly transport: MonolithRigTransport) {}
  surfaceSubscribe(
    filters: readonly { readonly '#h'?: readonly string[]; readonly '#d'?: readonly string[] }[],
    listener: (event: NostrEvent | MonolithSurfaceEvent) => void,
  ) {
    return this.transport.surfaceSubscribe(filters, listener);
  }
  uploadMedia(bytes: Uint8Array, mimeType: string) {
    return this.transport.uploadMedia(bytes, mimeType);
  }
  async createCommunity(name: string, options?: { communityId?: string }) {
    return (
      (await this.transport.operation('createWorkspace', {
        name,
        ...(options?.communityId ? { workspaceId: options.communityId } : {}),
      })) as { id: string }
    ).id;
  }
  waitUntilMember() {
    return Promise.resolve(true);
  }
  async createChannel(
    name: string,
    options: {
      communityId: string;
      visibility?: 'public' | 'invite-only';
      onPublished?: () => void;
    },
  ) {
    return this.transport.createRoom(name, options);
  }
  renameChannel(roomId: string, name: string) {
    return this.transport.operation('updateRoom', { roomId, name });
  }
  setChannelVisibility(roomId: string, visibility: 'public' | 'invite-only') {
    return this.transport.operation('updateRoom', { roomId, visibility });
  }
  renameCommunity(workspaceId: string, name: string) {
    return this.transport.operation('updateWorkspace', { workspaceId, name });
  }
  setCommunityAvatar(workspaceId: string, avatar: string) {
    return this.transport.operation('updateWorkspace', { workspaceId, avatar });
  }
  setCommunityVisibility(workspaceId: string, visibility: 'public' | 'invite-only') {
    return this.transport.operation('updateWorkspace', { workspaceId, visibility });
  }
  createInvite(workspaceId: string) {
    return this.transport.operation('createInvite', { workspaceId });
  }
  createAgentPairingCode(workspaceId: string) {
    return this.transport.operation('createAgentPairingCode', { workspaceId });
  }
  addMember(workspaceId: string, memberId: string, role: string) {
    return this.transport.operation('addWorkspaceMember', { workspaceId, memberId, role });
  }
  waitUntilMemberRole() {
    return Promise.resolve(true);
  }
  setAgentSoul(
    workspaceId: string,
    agentId: string,
    soul: { name: string; instructions: string; avatarSeed: string; avatar?: string },
  ) {
    return this.transport.operation('updateAgentSoul', { workspaceId, agentId, ...soul });
  }
  setAgentModelConfig(workspaceId: string, agentId: string, selection: Record<string, unknown>) {
    return this.transport.operation('updateAgentModelSelection', {
      workspaceId,
      agentId,
      ...selection,
    });
  }
  removeAgent(workspaceId: string, agentId: string) {
    return this.transport.operation('removeAgent', { workspaceId, agentId });
  }
  getGlobalPersonProfile() {
    return Promise.resolve(null);
  }
  getPersonProfile() {
    return Promise.resolve(null);
  }
  setGlobalPersonProfile(profile: { name: string; handle?: string; avatar?: string }) {
    return this.transport.operation('updatePersonProfile', profile);
  }
  listCommunities() {
    return Promise.resolve([]);
  }
  getCommunity() {
    return Promise.resolve(null);
  }
  communityMembers() {
    return Promise.resolve([]);
  }
  disconnect() {}
}

export class MonolithRigTransport {
  private readonly baseUrl = getBuzzRuntimeConfig().monolithUrl;
  private readonly adapter = new MonolithClientAdapter(this);
  constructor(private readonly identity: Identity) {}

  ensureClient(): Promise<BuzzClient> {
    return Promise.resolve(this.adapter as unknown as BuzzClient);
  }

  async createRoom(
    name: string,
    options: {
      communityId: string;
      visibility?: 'public' | 'invite-only';
      repository?: RepoCandidate;
      onPublished?: () => void;
    },
  ): Promise<string> {
    const repositoryId = options.repository
      ? Number(/^github:(\d+)$/.exec(options.repository.key)?.[1])
      : undefined;
    if (options.repository && !Number.isSafeInteger(repositoryId))
      throw new Error('Installed repository has an invalid key');
    const result = (await this.operation('createRoom', {
      workspaceId: options.communityId,
      name,
      ...(options.visibility ? { visibility: options.visibility } : {}),
      ...(repositoryId !== undefined ? { repositoryId } : {}),
    })) as { id: string };
    options.onPublished?.();
    return result.id;
  }

  async operation(name: string, input: unknown): Promise<unknown> {
    const response = await monolithSession.fetch(`${this.baseUrl}/v1/phone/operations/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Monolith ${name} failed (${response.status})`);
    if (response.status === 204) return undefined;
    return response.json();
  }

  composeMessage(
    input: MessageSubmitInput,
    opts?: { mentionAgent?: string; mentionPubkeys?: string[] },
  ): Promise<NostrEvent> {
    const id = eventId();
    const mentions = [
      ...(opts?.mentionPubkeys ?? []),
      ...(opts?.mentionAgent ? [opts.mentionAgent] : []),
    ];
    return Promise.resolve({
      id,
      pubkey: this.identity.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 9,
      tags: [
        ['h', input.sessionId],
        ['monolith-attachments', JSON.stringify(input.attachments ?? [])],
        ['monolith-mentions', JSON.stringify(mentions)],
      ],
      content: input.text,
      sig: '',
    });
  }

  composeReplyMessage(
    text: string,
    parent: KnownMessageReference,
    mentionAgent?: string,
    attachments: AttachmentReference[] = [],
    mentionPubkeys: string[] = [],
  ): Promise<NostrEvent> {
    return this.composeMessage(
      { sessionId: parent.channelId, text, attachments },
      { mentionAgent, mentionPubkeys },
    ).then((event) => ({ ...event, tags: [...event.tags, ['monolith-parent', parent.eventId]] }));
  }

  async publishPreparedMessage(event: NostrEvent): Promise<string> {
    const roomId = tag(event, 'h');
    if (!roomId) throw new Error('Prepared monolith message has no Room');
    const attachments = JSON.parse(
      tag(event, 'monolith-attachments') ?? '[]',
    ) as AttachmentReference[];
    const mentions = JSON.parse(tag(event, 'monolith-mentions') ?? '[]') as string[];
    const parentMessageId = tag(event, 'monolith-parent');
    const result = (await this.operation(parentMessageId ? 'sendRoomReply' : 'sendRoomMessage', {
      roomId,
      messageId: event.id,
      text: event.content,
      mentions,
      attachments,
      ...(parentMessageId ? { parentMessageId } : {}),
    })) as { messageId: string };
    return result.messageId;
  }

  async uploadMedia(bytes: Uint8Array, mimeType: string): Promise<any> {
    const response = await monolithSession.fetch(`${this.baseUrl}/v1/phone/media`, {
      method: 'POST',
      headers: { 'content-type': mimeType },
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) throw new Error(`Media upload failed (${response.status})`);
    const value = (await response.json()) as AttachmentReference;
    return {
      url: value.url,
      type: value.mimeType,
      size: value.size,
      sha256: value.sha256,
      thumb: value.thumbnailUrl,
    };
  }

  async surfaceSubscribe(
    filters: readonly { readonly '#h'?: readonly string[]; readonly '#d'?: readonly string[] }[],
    listener: (event: NostrEvent | MonolithSurfaceEvent) => void,
  ): Promise<() => void> {
    const roomIds = new Set(
      filters
        .flatMap((filter) => [
          ...(filter['#h'] ?? []),
          ...(filter['#d'] ?? []).map((value) => value.split(':').at(-1) ?? ''),
        ])
        .filter(Boolean),
    );
    let socket: WebSocket | undefined;
    let closed = false;
    const poll = setInterval(
      () =>
        listener({
          monolithLive: { type: 'invalidate', roomId: [...roomIds][0] ?? '', reason: 'poll' },
        }),
      30_000,
    );
    try {
      const token = await monolithSession.authorization();
      const url = this.baseUrl.replace(/^http/, 'ws') + '/v1/phone/live';
      socket = new WebSocket(url, [`bearer.${token}`]);
      socket.onopen = () => {
        for (const roomId of roomIds) socket?.send(JSON.stringify({ type: 'subscribe', roomId }));
      };
      socket.onmessage = (message) => {
        if (!closed) listener({ monolithLive: JSON.parse(String(message.data)) as LiveWireEvent });
      };
    } catch {}
    return () => {
      closed = true;
      clearInterval(poll);
      socket?.close();
    };
  }

  respondToWritePermission(
    roomId: string,
    permissionId: string,
    requestId: string,
    agentId: string,
    decision: WritePermissionDecision,
    repository: string,
  ) {
    return this.operation('decideWritePermission', {
      roomId,
      permissionId,
      requestId,
      agentId,
      decision,
      repository,
    }).then((value) => (value as { messageId: string }).messageId);
  }
  inviteAgentToChannel(roomId: string, memberId: string) {
    return this.operation('addRoomMember', { roomId, memberId }).then(
      (value) => (value as { joined: boolean }).joined,
    );
  }
  inviteWorkspaceMemberToChannel(roomId: string, memberId: string) {
    return this.inviteAgentToChannel(roomId, memberId);
  }
  removeRoomMember(roomId: string, memberId: string) {
    return this.operation('removeRoomMember', { roomId, memberId }).then(() => undefined);
  }
  leaveRoom(roomId: string) {
    return this.operation('leaveRoom', { roomId }).then(() => undefined);
  }
  deleteRoom(roomId: string) {
    return this.operation('deleteRoom', { roomId }).then(() => undefined);
  }
  leaveWorkspace(workspaceId: string) {
    return this.operation('leaveWorkspace', { workspaceId }).then(() => undefined);
  }
  resolveDirectMessage(workspaceId: string, participantId: string) {
    return this.operation('resolveDirectMessage', { workspaceId, participantId }).then((value) => {
      const result = value as { id: string; created: boolean };
      return { channelId: result.id, created: result.created };
    });
  }
  closeCorner(roomId: string) {
    return this.operation('sendRoomMessage', {
      roomId,
      messageId: eventId(),
      text: 'Close this corner.',
    }).then(() => undefined);
  }
  agentCommandsRead() {
    return Promise.resolve(null);
  }
  roomRepositorySet(roomId: string, input: RoomRepositoryInput): Promise<RoomRepository> {
    return this.operation('setRoomRepository', {
      roomId,
      key: input.key,
      remote: input.remote,
      targetBranch: input.targetBranch ?? 'main',
      githubInstallationId: input.githubInstallationId,
    }) as Promise<RoomRepository>;
  }
  roomTargetBranchSet(roomId: string, targetBranch: string): Promise<RoomRepository> {
    return this.operation('setRoomTargetBranch', {
      roomId,
      targetBranch,
    }) as Promise<RoomRepository>;
  }
  roomGitHubEventsSet(roomId: string, enabled: boolean): Promise<RoomRepository> {
    return this.operation('setRoomGitHubEvents', { roomId, enabled }) as Promise<RoomRepository>;
  }
  async workspaceGitHubAccess(options: { refresh?: boolean } = {}) {
    const value = (await this.operation('listGitHubRepositories', options)) as {
      installed: boolean;
      repositories: {
        id: number;
        fullName: string;
        installationId: number;
        defaultBranch: string;
      }[];
    };
    return {
      installed: value.installed,
      installations: [],
      candidates: value.repositories.map((repo) => ({
        key: `github:${repo.id}`,
        name: repo.fullName,
        remote: `git://github.com/${repo.fullName}`,
        githubInstallationId: repo.installationId,
        defaultBranch: repo.defaultBranch,
      })),
    };
  }
  async workspaceRoomRepositoryCandidates(): Promise<RepoCandidate[]> {
    return (await this.workspaceGitHubAccess()).candidates;
  }
  githubInstallationStart(redirectUri: string, installationId?: number) {
    return this.operation('beginGitHubInstallation', {
      redirectUri,
      ...(installationId ? { installationId } : {}),
    }).then((value) => (value as { url: string }).url);
  }
  async githubRepositoryCreate(input: {
    installationId: number;
    name: string;
    description?: string;
    private?: boolean;
  }): Promise<RepoCandidate> {
    const repo = (await this.operation('createGitHubRepository', input)) as {
      id: number;
      fullName: string;
      installationId: number;
      defaultBranch: string;
    };
    return {
      key: `github:${repo.id}`,
      name: repo.fullName,
      remote: `git://github.com/${repo.fullName}`,
      githubInstallationId: repo.installationId,
      defaultBranch: repo.defaultBranch,
    };
  }
  githubRepositoryAccess(fullName: string): Promise<any> {
    return this.operation('getGitHubRepositoryAccess', { fullName });
  }
  isChannelArchived() {
    return Promise.resolve(false);
  }
  getParentChannelId() {
    return Promise.resolve(null);
  }
  getPubkey() {
    return this.identity.publicKey;
  }
  disconnect() {}
}
