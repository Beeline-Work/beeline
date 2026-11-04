// Durable writes retain their existing intent owner; reads use the socket directly.
export { CommandIntents } from './command-intents.js';
export type { CommandIntent, CommandIntentStorage, CommandPartition, CommandAttempt, AdmittedCommand, IntentOperation, IntentState } from './command-intents.js';
export { canonical } from './canonical.js';
