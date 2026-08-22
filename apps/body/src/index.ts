/**
 * Public surface of `@beeline/body` — agent body service.
 */
export {
  Body,
  createAgentSubchannel,
  isChannelAddressedMessage,
  isReadOnlyInformationRequest,
  isChannelWorkIntent,
  isChannelTaskRequest,
  ReadOnlyToolsUnavailableError,
  readOnlyMcpServer,
  roomEditPolicyInstructions,
  AGENT_REQUEST_TAG,
  AGENT_CANCEL_TAG,
  MERGE_READY_TAG,
  type AgentSession,
  type SubchannelInfo,
  type BoundRepo,
  type ChannelTaskRequest,
  type RoomEditPolicy,
} from './body.js';
export { WorkspaceSupervisor } from './supervisor.js';
export {
  NAMED_REPOSITORY_PERMISSION_COMMAND,
  namedRepositoryTargetFromPermission,
  parseNamedRepositoryTarget,
  type NamedRepositoryTarget,
} from './repository-target.js';
export { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';
export { DurableBodyState, type EventCursor, type ConversationEntry } from './durable-state.js';
export {
  completedModelSpend,
  dailyAgentSpend,
  dailyRestartReprimes,
  failedModelSpend,
  formatAgentSpendReport,
  formatReprimeReport,
  reportedTokenUsage,
  type AgentDailySpend,
  type ModelTurnAttribution,
  type ModelTurnCause,
  type ModelTurnSpend,
  type RestartReprimeSpend,
  type SessionReprimeRecord,
} from './model-spend.js';
export {
  AcpClient,
  type McpServerWire,
  type SessionUpdate,
  type ToolCallEntry,
  type PromptResult,
} from './acp.js';
export {
  loadBodyConfig,
  resolveBinaries,
  resolveReadonlyMcpCommand,
  buildAgentEnv,
  hasLlmCredentials,
  parseEnvFile,
  type BodyConfig,
  type SessionMode,
  WRITE_TOOL_NAMES,
} from './config.js';
export {
  listMcpToolNames,
  inventoryForMcpServers,
  hasWriteTools,
  type McpServerSpec,
} from './mcp-inventory.js';
export {
  isReadOnlyMcpPermissionRequest,
  READ_ONLY_MCP_SERVER_NAME,
  READ_ONLY_TOOL_NAMES,
} from './read-only-policy.js';
export {
  EXTERNAL_MCP_CAPABILITIES,
  authorizedExternalMcpServers,
  externalMcpServers,
  isExternalMcpCapability,
  isExternalMcpPermissionRequest,
  type ExternalMcpCapability,
} from './external-mcp-capabilities.js';
export {
  classifyCornerPermission,
  classifyRoomPermission,
  permissionTargetPaths,
  pathEscapesRoot,
  physicalPath,
  ROOM_READ_ONLY_STEER,
  type SandboxDenyCode,
  type SandboxVerdict,
} from './session-sandbox.js';
export {
  enforcesPermissionBoundary,
  harnessEnforcement,
  roomSandboxWarning,
  type HarnessEnforcement,
} from './harness-capabilities.js';
export {
  buildBwrapArgv,
  detectBwrapSandbox,
  harnessHomeStateDirs,
  isSandboxPolicy,
  resolveGitCommonDir,
  sandboxMountPlan,
  wrapAgentCommand,
  DEFAULT_SANDBOX_POLICY,
  type BwrapAvailability,
  type SandboxMountPlan,
  type SandboxPolicy,
  type SandboxSessionSpec,
} from './bwrap-sandbox.js';
export {
  harnessToolScope,
  harnessReadsMetaSystemPrompt,
  sessionToolScopeMeta,
  toolScopeWarning,
  CLAUDE_TOOL_SCOPE_SETTINGS,
  NO_PERSONAL_CONNECTORS_INSTRUCTION,
  type ToolScopeEnforcement,
} from './harness-tool-scope.js';
export {
  projectActivity,
  postAgentMessage,
  postControlMessage,
  ACTIVITY_TAG,
  AGENT_MESSAGE_TAG,
  type ActivityBatch,
} from './activity.js';
export {
  resolveReviewBaseTip,
  listChangeReviewFiles,
  readChangeReviewPatch,
  chunkChangeReviewPatch,
  postChangeReviewMetadata,
} from './change-review.js';
export {
  appendPersonaSessionInstructions,
  personaSessionInstructions,
} from './persona-instructions.js';
