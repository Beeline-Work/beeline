/**
 * Public surface of `@beeline/body` — agent body service.
 */
export {
  Body,
  createAgentSubchannel,
  isChannelAddressedMessage,
  isChannelWorkIntent,
  isChannelTaskRequest,
  AGENT_REQUEST_TAG,
  AGENT_CANCEL_TAG,
  MERGE_READY_TAG,
  type AgentSession,
  type SubchannelInfo,
  type BoundRepo,
  type ChannelTaskRequest,
} from './body.js';
export { WorkspaceSupervisor, boundRepoFromRoom } from './supervisor.js';
export { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';
export { DurableBodyState, type EventCursor, type ConversationEntry } from './durable-state.js';
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
