/**
 * Public surface of `@beeline/gate` for sibling packages (e.g. `@beeline/body`).
 * Prefer these re-exports over deep relative imports.
 */
export type { Identity } from './identity.js';
export { newIdentity } from './identity.js';

export {
  KIND_PUT_USER,
  KIND_CREATE_GROUP,
  KIND_EDIT_METADATA,
  KIND_STREAM_MESSAGE,
  KIND_REPO_ANNOUNCEMENT,
  TAG_COMMUNITY,
  createChannel,
  createCommunity,
  setMemberRole,
  archiveChannel,
  announceRepo,
} from './buzz.js';

export { publishEvent, queryEvents, type SubmitResult } from './relay.js';

export { HOST, SCHEME, BASE_URL, gitRepoUrl } from './config.js';

export { git, gitAuthed, lsRemoteRef, type GitResult } from './git.js';

export {
  checkAgentNotPushAllowed,
  assertAgentNotPushAllowed,
  resolveChannelRole,
  resolveCommunityRole,
  type ProvisioningCheckInput,
  type ProvisioningCheckResult,
  type ChannelRole,
  type ProtectionRule,
} from './provisioning.js';

export { nip98AuthHeader, buildNip98Event, NIP98_KIND } from './nip98.js';

export { isRegisteredAgentIdentity } from './agent-identity.js';

export { buildApproval, verifyApproval, APPROVAL_MARKER, type MergeTarget } from './approval.js';

export {
  attemptMerge,
  DurableMergeGate,
  roomMergeCandidates,
  type MergeRequest,
  type MergeOutcome,
  type RoomMergeServiceConfig,
  type RoomMergeCandidate,
  type RoomMergeAttempt,
} from './worker.js';
