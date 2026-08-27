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
export { ThinDaemonCore } from './thin-core.js';
export {
  NAMED_REPOSITORY_PERMISSION_COMMAND,
  namedRepositoryTargetFromPermission,
  parseNamedRepositoryTarget,
  type NamedRepositoryTarget,
} from './repository-target.js';
export { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';
export { DurableBodyState, type EventCursor } from './durable-state.js';
export {
  PermissionKnownFailure,
  PermissionRuntime,
  parseRoomCreatePermissionDirective,
  type PermissionActionClaim,
  type PermissionDirectiveRosterEntry,
  type PermissionExecutionOutcome,
  type PermissionExecutionHandle,
  type PermissionBeginOutcome,
  type PermissionRuntimeDependencies,
} from './permission-runtime.js';
export {
  DelegationRuntime,
  buildDelegationEscalationPermission,
  dispatchRootFactoryDirectives,
  type DelegationDailyLimit,
  type DelegationDailyUsage,
  type DelegationDispatchOutcome,
  type DelegationRuntimeDependencies,
  type DelegationRuntimeReader,
  type RootFactoryDirectiveDependencies,
  type RootFactoryRosterEntry,
} from './delegation-runtime.js';
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
  DEFAULT_CALENDAR_RESYNC_SECONDS,
  DEFAULT_CALENDAR_RETRY_SECONDS,
  MAX_CALENDAR_DUE_PER_WAKE,
  SCHEDULED_TURN_TAG,
  WORK_SCHEDULE_KIND,
  WORK_SCHEDULE_PAUSED_TAG,
  WORK_SCHEDULE_RUNTIME_TAG,
  WORK_SCHEDULE_TAG,
  WORK_SCHEDULE_VERSION,
  WorkCalendar,
  DurableWorkCalendarState,
  buildScheduledTurnReceipt,
  buildWorkSchedule,
  buildWorkSchedulePauseCard,
  buildWorkScheduleProjection,
  deterministicScheduleRunId,
  nextWorkOccurrence,
  parseScheduledTurnReceipt,
  parseWorkSchedule,
  parseWorkScheduleValue,
  previousWorkOccurrence,
  workScheduleKey,
  workScheduleRevisionDigest,
  type ParsedScheduledTurnReceipt,
  type ParsedWorkSchedule,
  type ScheduleAuthorityResult,
  type ScheduledTurnReceiptV1,
  type ScheduledTurnRequest,
  type ScheduledTurnStatus,
  type WorkCalendarDependencies,
  type WorkCalendarStore,
  type WorkScheduleRuntimeState,
  type WorkScheduleProjectionV1,
  type WorkScheduleV1,
} from './work-calendar.js';
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
  externalMcpPermissionPolicy,
  externalMcpServers,
  governedSquireCall,
  isExternalMcpCapability,
  isExternalMcpPermissionRequest,
  SQUIRE_GOVERNED_TOOLS,
  type ExternalMcpCapability,
  type ExternalMcpPermissionPolicy,
  type GovernedSquireCall,
  type SquireGovernedTool,
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
  postChangeReviewMetadata,
} from './change-review.js';
export {
  appendPersonaSessionInstructions,
  personaSessionInstructions,
} from './persona-instructions.js';
