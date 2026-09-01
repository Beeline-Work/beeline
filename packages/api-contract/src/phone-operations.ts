import type {
  AgentModelSelection,
  AgentPairingClaimView,
  AttachmentReference,
  InviteView,
} from './phone-types.js';

export type PhoneOperationMap = {
  sendRoomMessage: { input: SendRoomMessageInput; output: MessageWriteResult };
  sendRoomReply: { input: SendRoomReplyInput; output: MessageWriteResult };
  decideWritePermission: { input: DecideWritePermissionInput; output: MessageWriteResult };
  createWorkspace: { input: NamedWorkspaceInput; output: IdResult };
  updateWorkspace: { input: UpdateWorkspaceInput; output: void };
  leaveWorkspace: { input: WorkspaceInput; output: void };
  addWorkspaceMember: { input: WorkspaceMemberInput; output: MembershipResult };
  createRoom: { input: CreateRoomInput; output: IdResult };
  updateRoom: { input: UpdateRoomInput; output: void };
  deleteRoom: { input: RoomInput; output: void };
  leaveRoom: { input: RoomInput; output: void };
  addRoomMember: { input: RoomMemberInput; output: MembershipResult };
  removeRoomMember: { input: RoomMemberInput; output: void };
  resolveDirectMessage: { input: ResolveDirectMessageInput; output: DirectMessageResult };
  createInvite: { input: WorkspaceInput; output: InviteTokenResult };
  resolveInvite: { input: InviteTokenInput; output: InviteView };
  redeemInvite: { input: InviteTokenInput; output: InviteMembershipResult };
  createAgentPairingCode: { input: WorkspaceInput; output: PairingCodeResult };
  claimAgentPairing: { input: PairingCodeInput; output: AgentPairingClaimView };
  updateAgentSoul: { input: UpdateAgentSoulInput; output: void };
  updateAgentModelSelection: { input: UpdateAgentModelInput; output: void };
  removeAgent: { input: WorkspaceAgentInput; output: void };
  updatePersonProfile: { input: UpdatePersonProfileInput; output: PersonProfileResult };
  setRoomRepository: { input: SetRoomRepositoryInput; output: RoomRepositoryResult };
  setRoomTargetBranch: { input: SetRoomTargetBranchInput; output: RoomRepositoryResult };
  setRoomGitHubEvents: { input: SetRoomGitHubEventsInput; output: RoomRepositoryResult };
  getAuthCapabilities: { input: EmptyInput; output: AuthCapabilitiesResult };
  beginGitHubIdentityBind: { input: BeginBrowserAuthInput; output: BrowserAuthStartResult };
  completeGitHubIdentityBind: { input: CompleteBrowserAuthInput; output: IdentityBindResult };
  recoverGitHubIdentity: { input: CompleteBrowserAuthInput; output: IdentityBindResult };
  getIdentityRecovery: { input: EmptyInput; output: IdentityRecoveryResult };
  getManagedIdentity: { input: EmptyInput; output: ManagedIdentityResult };
  adoptGitHubHandle: { input: EmptyInput; output: ManagedIdentityResult };
  claimManagedHandle: { input: ClaimManagedHandleInput; output: ManagedIdentityResult };
  listGitHubRepositories: { input: RefreshInput; output: GitHubRepositoryListResult };
  beginGitHubInstallation: { input: BeginGitHubInstallationInput; output: BrowserAuthStartResult };
  createGitHubRepository: { input: CreateGitHubRepositoryInput; output: GitHubRepositoryResult };
  getGitHubRepositoryAccess: {
    input: GitHubRepositoryAccessInput;
    output: GitHubRepositoryAccessResult;
  };
  uploadMedia: { input: UploadMediaInput; output: AttachmentReference };
  registerPushDevice: { input: PushDeviceInput; output: PushRegistrationResult };
  unregisterPushDevice: { input: PushDeviceInput; output: void };
  sendPushTest: { input: EmptyInput; output: void };
  reportRunningUpdate: { input: RunningUpdateInput; output: void };
};

export type EmptyInput = Record<string, never>;
export type WorkspaceInput = { readonly workspaceId: string };
export type RoomInput = { readonly roomId: string };
export type WorkspaceAgentInput = WorkspaceInput & { readonly agentId: string };
export type RoomMemberInput = RoomInput & { readonly memberId: string };
export type WorkspaceMemberInput = WorkspaceInput & {
  readonly memberId: string;
  readonly role: 'owner' | 'admin' | 'member';
};
export type NamedWorkspaceInput = { readonly name: string; readonly workspaceId?: string };
export type IdResult = { readonly id: string };
export type MembershipResult = { readonly joined: boolean };
export type InviteMembershipResult = MembershipResult & { readonly workspaceId: string };
export type MessageWriteResult = { readonly messageId: string };
export type SendRoomMessageInput = RoomInput & {
  /** Client-generated retry/optimistic identity. Random 32-byte hex. */
  readonly messageId?: string;
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly attachments?: readonly AttachmentReference[];
};
export type SendRoomReplyInput = SendRoomMessageInput & { readonly parentMessageId: string };
export type DecideWritePermissionInput = RoomInput & {
  readonly permissionId: string;
  readonly requestId: string;
  readonly agentId: string;
  readonly decision: 'allow' | 'deny';
  readonly repository: string;
};
export type UpdateWorkspaceInput = WorkspaceInput & {
  readonly name?: string;
  readonly avatar?: string;
  readonly visibility?: 'public' | 'invite-only';
};
export type CreateRoomInput = WorkspaceInput & {
  readonly name: string;
  readonly visibility?: 'public' | 'invite-only';
  /** Optional repository from listGitHubRepositories, bound atomically with Room creation. */
  readonly repositoryId?: number;
};
export type UpdateRoomInput = RoomInput & {
  readonly name?: string;
  readonly visibility?: 'public' | 'invite-only';
};
export type ResolveDirectMessageInput = WorkspaceInput & { readonly participantId: string };
export type DirectMessageResult = IdResult & { readonly created: boolean };
export type InviteTokenInput = { readonly token: string };
export type InviteTokenResult = InviteTokenInput & {
  /** Absolute Unix timestamp in seconds. */
  readonly expiresAt: number;
};
export type PairingCodeInput = { readonly code: string };
export type PairingCodeResult = PairingCodeInput & { readonly expiresAt: number };
export type UpdateAgentSoulInput = WorkspaceAgentInput & {
  readonly name: string;
  readonly instructions: string;
  readonly avatarSeed: string;
  readonly avatar?: string;
};
export type UpdateAgentModelInput = WorkspaceAgentInput &
  Omit<AgentModelSelection, 'effort'> & { readonly effort?: string | null };
export type UpdatePersonProfileInput = {
  readonly name?: string;
  readonly handle?: string;
  readonly avatar?: string;
};
export type PersonProfileResult = {
  readonly personId: string;
  readonly name: string;
  readonly handle?: string;
  readonly avatar?: string;
};
export type SetRoomRepositoryInput = RoomInput & {
  readonly key: string;
  readonly name: string;
  readonly remote: string;
  readonly targetBranch: string;
  readonly githubInstallationId?: number;
};
export type SetRoomTargetBranchInput = RoomInput & { readonly targetBranch: string };
export type SetRoomGitHubEventsInput = RoomInput & { readonly enabled: boolean };
export type RoomRepositoryResult = {
  readonly channelId: string;
  readonly binding: {
    readonly key: string;
    readonly name: string;
    readonly remote: string;
    readonly localOnly: false;
    readonly githubInstallationId?: number;
  };
  readonly targetBranch: string;
  readonly updatedAt: number;
  readonly githubEventsEnabled: boolean;
  readonly source: 'config';
};
export type AuthCapabilitiesResult = { readonly github: boolean };
export type BeginBrowserAuthInput = { readonly redirectUri: string; readonly state: string };
export type BrowserAuthStartResult = { readonly url: string };
export type CompleteBrowserAuthInput = { readonly challenge: string; readonly proof: string };
export type IdentityBindResult = { readonly personId: string; readonly recovered: boolean };
export type IdentityRecoveryResult = {
  readonly candidates: readonly { readonly personId: string; readonly handle?: string }[];
};
export type ManagedIdentityResult = {
  readonly personId: string;
  readonly name: string;
  readonly handle?: string;
  readonly avatar?: string;
};
export type ClaimManagedHandleInput = { readonly handle: string };
export type RefreshInput = { readonly refresh?: boolean };
export type GitHubRepository = {
  readonly id: number;
  readonly fullName: string;
  readonly installationId: number;
  readonly defaultBranch: string;
};
export type GitHubInstallation = {
  readonly installationId: number;
  readonly accountId: string;
  readonly accountLogin: string;
  readonly accountType: 'User' | 'Organization';
  readonly accountAvatarUrl?: string;
  readonly repositorySelection: 'all' | 'selected';
  readonly status: 'active' | 'revoked' | 'suspended';
  readonly repositoryCount: number;
  readonly manageUrl: string;
};
export type GitHubRepositoryListResult = {
  readonly installed: boolean;
  readonly installations: readonly GitHubInstallation[];
  readonly repositories: readonly GitHubRepository[];
};
export type BeginGitHubInstallationInput = {
  readonly redirectUri: string;
  readonly installationId?: number;
};
export type CreateGitHubRepositoryInput = {
  readonly installationId: number;
  readonly name: string;
  readonly description?: string;
  readonly private?: boolean;
};
export type GitHubRepositoryResult = GitHubRepository;
export type GitHubRepositoryAccessInput = { readonly fullName: string };
export type GitHubRepositoryAccessResult = {
  readonly accessible: boolean;
  readonly reason?: string;
};
export type UploadMediaInput = {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly name?: string;
};
export type PushDeviceInput = {
  readonly token: string;
  readonly platform: 'android' | 'ios';
  readonly environment: 'physical' | 'emulator';
};
export type PushRegistrationResult = { readonly accepted: boolean };
export type RunningUpdateInput = {
  readonly deviceId: string;
  readonly updateId?: string;
  readonly channel?: string;
  readonly group?: string;
  readonly runtimeVersion?: string;
  readonly releaseVersion?: string;
  readonly sourceSha?: string;
};
