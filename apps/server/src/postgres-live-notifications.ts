import { isAgentSignInKeyProvider, readUsageRefreshOutcome, type AgentSignInLink } from '@beeline/api-contract/daemon';
import type { LiveEvent } from './live.js';

/** Shared fixed channel identities. Publishers and SQL builders belong to postgres-live.ts. */
export const POSTGRES_LIVE_CHANNEL = 'beeline_live_v1';
export const COMMAND_COMPLETION_CHANNEL = 'beeline_command_completion';
export const AGENT_SIGN_IN_TABLE = 'agent_sign_in';
export const USAGE_REFRESH_TABLE = 'agent_usage_refresh';
export const USAGE_REFRESH_RESULT_TABLE = 'agent_usage_refresh_result';
export const X_SIGNUP_DELIVERY_TABLE = 'x_signup_delivery';
export const SERVER_LEASE_EVIDENCE_TABLE = 'server_lease_evidence';
export const MCP_WEBHOOK_TABLE = 'rooms_mcp_webhook_outbox';
type AgentSignInEvent = Extract<LiveEvent, { type: 'agent-sign-in' }>;
type Step = AgentSignInEvent['step'];
type UsageRefreshResult = Extract<LiveEvent, { type: 'usage-refresh-result' }>;
const ATTEMPT_ID = /^[0-9a-f-]{36}$/;
const CARD_ID = /^[0-9a-f]{64}$/;
const USER_CODE = /^[A-Z0-9-]{4,16}$/;
const MAX_REPORT_TEXT = 2_048;
const REQUEST_ID = /^[0-9a-f-]{36}$/;

function httpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://') && value.length <= MAX_REPORT_TEXT;
}

/** The machine's answer to `start`, validated; anything else is dropped. */
export function readAgentSignInLink(value: Record<string, unknown>): AgentSignInLink | undefined {
  switch (value.kind) {
    case 'paste-code':
    case 'approve-wait':
      return httpsUrl(value.authorizeUrl)
        ? { kind: value.kind, authorizeUrl: value.authorizeUrl }
        : undefined;
    case 'device-code':
      return httpsUrl(value.authorizeUrl) &&
        typeof value.userCode === 'string' &&
        USER_CODE.test(value.userCode) &&
        typeof value.expiresAt === 'number' &&
        Number.isFinite(value.expiresAt)
        ? {
            kind: 'device-code',
            authorizeUrl: value.authorizeUrl,
            userCode: value.userCode,
            expiresAt: value.expiresAt,
          }
        : undefined;
    case 'api-key':
      return isAgentSignInKeyProvider(value.provider)
        ? { kind: 'api-key', provider: value.provider }
        : undefined;
    default:
      return undefined;
  }
}

/** Decode one NOTIFY payload for this table; anything malformed is dropped. */
export function decodeAgentSignInNotification(raw: string): AgentSignInEvent | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (parsed.table !== AGENT_SIGN_IN_TABLE) return undefined;
  const { agentId, attemptId, step } = parsed;
  if (typeof agentId !== 'string' || !agentId) return undefined;
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) return undefined;
  const base = { type: 'agent-sign-in' as const, roomId: '' as const, agentId, attemptId };
  switch (step as Step) {
    case 'start':
      return typeof parsed.cardId === 'string' && CARD_ID.test(parsed.cardId)
        ? { ...base, step: 'start', cardId: parsed.cardId }
        : undefined;
    case 'code':
      return typeof parsed.code === 'string' && parsed.code
        ? { ...base, step: 'code', code: parsed.code }
        : undefined;
    case 'link': {
      const link =
        parsed.link && typeof parsed.link === 'object'
          ? readAgentSignInLink(parsed.link as Record<string, unknown>)
          : undefined;
      return link ? { ...base, step: 'link', link } : undefined;
    }
    case 'result':
      if (parsed.outcome === 'signed-in') return { ...base, step: 'result', outcome: 'signed-in' };
      return parsed.outcome === 'failed' && typeof parsed.error === 'string'
        ? { ...base, step: 'result', outcome: 'failed', error: parsed.error }
        : undefined;
    default:
      return undefined;
  }
}

/** Decode one NOTIFY payload for the refresh result table; anything malformed is dropped. */
export function decodeUsageRefreshResult(raw: string): UsageRefreshResult | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const outcome = readUsageRefreshOutcome(parsed.outcome);
  if (parsed.table !== USAGE_REFRESH_RESULT_TABLE || typeof parsed.agentId !== 'string' || !outcome) return;
  if (parsed.requestId !== undefined && !(typeof parsed.requestId === 'string' && REQUEST_ID.test(parsed.requestId)))
    return;
  return {
    type: 'usage-refresh-result', roomId: '', agentId: parsed.agentId, outcome,
    ...(parsed.requestId ? { requestId: parsed.requestId as string } : {}),
  };
}
