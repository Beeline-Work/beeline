/**
 * Public surface of `@buzzy/body` — agent body service.
 */
export { Body, createAgentSubchannel, type AgentSession, type SubchannelInfo } from './body.js';
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
export { generateSoul, type GeneratedSoul } from './soul.js';
export { createSoulServer } from './soul-server.js';
