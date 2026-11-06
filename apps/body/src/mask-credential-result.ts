import { isCredentialFetchToolName } from '@beeline/api-contract/daemon';
import type { ToolCallEntry } from './acp.js';

/** Tool identity, including MCP names and harness argument envelopes; never output text. */
function isCredentialFetch(call: ToolCallEntry): boolean {
  if (isCredentialFetchToolName(call.name) || isCredentialFetchToolName(call.title)) return true;
  let input = call.rawInput;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { return false; }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const record = input as Record<string, unknown>;
    if (isCredentialFetchToolName(record.name) || isCredentialFetchToolName(record.tool) || isCredentialFetchToolName(record.tool_name)) return true;
    input = record.arguments ?? record.tool_input ?? record.toolInput;
  }
  return false;
}

/** The harness receives the real result. Every Body record gets only this placeholder. */
export function maskCredentialResult<T extends ToolCallEntry>(call: T, identity: ToolCallEntry = call): T {
  if (!isCredentialFetch(identity)) return call;
  return {
    ...call,
    ...('content' in call ? { content: '[REDACTED]' } : {}),
    ...('rawOutput' in call ? { rawOutput: '[REDACTED]' } : {}),
    ...('locations' in call ? { locations: undefined } : {}),
    ...(call.rawOutput && typeof call.rawOutput === 'object' &&
      (call.rawOutput as { isError?: unknown }).isError === true ? { status: 'failed' } : {}),
  };
}
