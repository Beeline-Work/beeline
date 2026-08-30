/**
 * Signed permission ledger for bounded factory side effects.
 *
 * Compatibility facade: the protocol is implemented by focused scope, event,
 * ledger, and fresh-verification modules while the public package API remains
 * available from this historical entry point.
 */
export {
  MAX_MISSION_RESERVED_TOKENS,
  MAX_PERMISSION_CONTENT_CHARS,
  MAX_PERMISSION_GRANT_TTL_SECONDS,
  MAX_PERMISSION_LIST_ITEMS,
  MAX_PERMISSION_NOTE_CHARS,
  MAX_PERMISSION_RATE_WINDOW_SECONDS,
  MAX_PERMISSION_REASON_CHARS,
  MAX_PERMISSION_SUMMARY_CHARS,
  MAX_PERMISSION_USES,
  PERMISSION_DECISION_MARKER,
  PERMISSION_EXECUTION_MARKER,
  PERMISSION_PROTOCOL_VERSION,
  PERMISSION_REQUEST_MARKER,
  PERMISSION_REVOCATION_MARKER,
  PERMISSION_SCOPE_REGISTRY,
  parsePermissionScope,
} from './permission-scope.js';
export type {
  ArtifactRevisionRef,
  MissionControlScope,
  MissionCornerOperation,
  MissionScheduleAllocation,
  MissionScheduleMode,
  MissionScheduleOperation,
  MissionTargetAllocation,
  NormalizedDestination,
  ParsedPermissionDecision,
  ParsedPermissionEvent,
  ParsedPermissionExecution,
  ParsedPermissionRequest,
  ParsedPermissionRevocation,
  PermissionAudience,
  PermissionDecisionV1,
  PermissionExecutionStatus,
  PermissionExecutionV1,
  PermissionExecutor,
  PermissionGrantEnvelopeV1,
  PermissionRequestV1,
  PermissionRevocationV1,
  PermissionRole,
  PermissionScope,
  PermissionScopePolicy,
  PermissionScopeType,
} from './permission-scope.js';
export {
  buildPermissionDecision,
  buildPermissionExecution,
  buildPermissionRequest,
  buildPermissionRevocation,
  defaultPermissionGrantEnvelope,
  parsePermissionDecision,
  parsePermissionEvent,
  parsePermissionExecution,
  parsePermissionRequest,
  parsePermissionRevocation,
} from './permission-events.js';
export {
  foldPermissionLedger,
  permissionActionId,
  permissionScopeAllows,
  summarizePermissionUsage,
} from './permission-ledger.js';
export type { PermissionFoldState, PermissionUsage } from './permission-ledger.js';
export {
  verifyMissionPermissionActionAuthority,
  verifyPermissionAction,
} from './permission-verification.js';
export type {
  PermissionConcreteAction,
  PermissionFreshReader,
  PermissionVerificationResult,
} from './permission-verification.js';
