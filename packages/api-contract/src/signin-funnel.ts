/** Anonymous, allowlisted sign-in measurement. Never add identity or free-text fields. */
export const FUNNEL_EVENTS = [
  'app_opened',
  'signin_screen_shown',
  'provider_tapped',
  'callback_result',
  'signed_in',
  'workspace_created',
  'first_message_sent',
] as const;
export const FUNNEL_PLATFORMS = ['ios', 'android', 'web', 'macos', 'windows', 'linux'] as const;
export const FUNNEL_ERRORS = [
  'offline',
  'denied',
  'provider_error',
  'invalid_callback',
  'exchange_failed',
  'unknown',
] as const;
export interface SigninFunnelEvent {
  event: (typeof FUNNEL_EVENTS)[number];
  installId: string;
  attemptId: string;
  platform: (typeof FUNNEL_PLATFORMS)[number];
  version: string;
  environment: 'production' | 'development' | 'preview' | 'lab' | 'review';
  provider?: 'github' | 'google';
  outcome?: 'success' | 'cancelled' | 'error';
  errorCode?: (typeof FUNNEL_ERRORS)[number];
  timestamp: string;
}
export const FUNNEL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = [
  'event',
  'installId',
  'attemptId',
  'platform',
  'version',
  'environment',
  'provider',
  'outcome',
  'errorCode',
  'timestamp',
];
export function parseSigninFunnelEvent(value: unknown, now = Date.now()): SigninFunnelEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !KEYS.includes(k)) || JSON.stringify(v).length > 1024) return null;
  if (
    !FUNNEL_EVENTS.includes(v.event as never) ||
    !FUNNEL_PLATFORMS.includes(v.platform as never) ||
    typeof v.installId !== 'string' ||
    !FUNNEL_UUID.test(v.installId) ||
    typeof v.attemptId !== 'string' ||
    !FUNNEL_UUID.test(v.attemptId) ||
    typeof v.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[.+-][a-zA-Z0-9.-]{1,32})?$/.test(v.version) ||
    !['production', 'development', 'preview', 'lab', 'review'].includes(v.environment as string) ||
    typeof v.timestamp !== 'string' ||
    v.timestamp.length > 30 ||
    !Number.isFinite(Date.parse(v.timestamp)) ||
    Math.abs(now - Date.parse(v.timestamp)) > 86_400_000
  )
    return null;
  const providerStep = ['provider_tapped', 'callback_result', 'signed_in'].includes(
    v.event as string,
  );
  if (
    providerStep ? !['github', 'google'].includes(v.provider as string) : v.provider !== undefined
  )
    return null;
  if (v.event === 'callback_result') {
    if (!['success', 'cancelled', 'error'].includes(v.outcome as string)) return null;
    if (
      v.outcome === 'error'
        ? !FUNNEL_ERRORS.includes(v.errorCode as never)
        : v.errorCode !== undefined
    )
      return null;
  } else if (v.outcome !== undefined || v.errorCode !== undefined) return null;
  return v as unknown as SigninFunnelEvent;
}
export interface FunnelAuthObservation {
  phase: 'start' | 'callback';
  flowHash: string;
  provider: 'github' | 'google';
  context?: unknown;
  outcome?: 'success' | 'cancelled' | 'error';
  errorCode?: (typeof FUNNEL_ERRORS)[number];
}
