/**
 * Public surface of `@beeline/body` — agent body service.
 */
export {
  Body,
  createAgentSubchannel,
  isChannelTaskRequest,
  AGENT_REQUEST_TAG,
  MERGE_READY_TAG,
  type AgentSession,
  type SubchannelInfo,
  type BoundRepo,
  type ChannelTaskRequest,
} from './body.js';
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
  postControlMessage,
  ACTIVITY_TAG,
  type ActivityBatch,
} from './activity.js';
export {
  resolveReviewBaseTip,
  listChangeReviewFiles,
  readChangeReviewPatch,
  chunkChangeReviewPatch,
  postChangeReviewMetadata,
} from './change-review.js';
export { generateSoul, type GeneratedSoul } from './soul.js';
export { createSoulServer } from './soul-server.js';
