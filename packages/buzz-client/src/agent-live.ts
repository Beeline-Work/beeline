import { TAG_AGENT_DRAFT, TAG_AGENT_THOUGHT } from './kinds.js';

/** One replaceable live draft per Room/corner. */
export function agentDraftKey(channelId: string): string {
  return `${TAG_AGENT_DRAFT}:${channelId}`;
}

/** One replaceable rolling-thought record per Room/corner. */
export function agentThoughtKey(channelId: string): string {
  return `${TAG_AGENT_THOUGHT}:${channelId}`;
}
