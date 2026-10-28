/** Anonymous, allowlisted sign-in measurement. Never add identity or free-text fields. */
export const ONBOARDING_EVENTS = [
  'repo_job_chosen', 'youtube_job_chosen', 'other_job_chosen',
  'banter_shown', 'welcome_shown', 'welcome_skipped', 'option_picked', 'user_answered',
  'task_question', 'task_first_answer', 'task_review_requested', 'task_final_answer',
  'game_posted', 'game_viewer_opened', 'game_viewer_closed',
  'invite_created', 'invite_shared', 'invite_opened', 'invite_friend_signed_up', 'invite_friend_messaged',
  'returned_day_1', 'returned_day_7', 'next_day_checkin_sent',
] as const;
export type OnboardingEvent = (typeof ONBOARDING_EVENTS)[number];
export const FUNNEL_EVENTS = [
  'app_opened',
  'signin_screen_shown',
  'provider_tapped',
  'callback_result',
  'signed_in',
  'workspace_created',
  'first_message_sent',
  'screen_shown',
  ...ONBOARDING_EVENTS,
] as const;
/**
 * Route patterns a first-session screen event may name. Patterns only, with
 * groups removed and dynamic segments left as `[name]`; never a value.
 */
export const FUNNEL_SCREENS = [
  'index',
  'artifact-viewer',
  'beeline/agent-profile',
  'beeline/agents',
  'beeline/browser-share',
  'beeline/channels',
  'beeline/chat/[channelId]',
  'beeline/community',
  'beeline/corner-app/[slug]',
  'beeline/corners/[roomId]',
  'beeline/create-workspace',
  'beeline/github-callback',
  'beeline/github-installation',
  'beeline/google-callback',
  'beeline/human-profile',
  'beeline/members',
  'beeline/onboarding',
  'beeline/settings',
  'beeline/settings/identity',
  'beeline/settings/schedule',
  'beeline/settings/schedules',
  'beeline/settings/subscription',
  'beeline/settings/workbench',
  'beeline/settings/workbench/app',
  'beeline/settings/workbench/connect',
  'beeline/settings/workbench/connect-app',
  'beeline/settings/workbench/connect-signin',
  'beeline/settings/workbench/connection',
  'beeline/settings/workbench/service',
  'beeline/settings/workbench/wallet',
  'beeline/settings/workbench/wallet-receive',
  'beeline/settings/workbench/wallet-send',
  'beeline/settings/workbench/wallet-service',
  'beeline/settings/workflows',
  'beeline/settings/workspace',
  'beeline/tray',
  'beeline/workflow',
  'beeline/workflow-run',
  'buzz/github-callback',
  'buzz/github-installation',
  'changelog',
  'join/[token]',
  'review/[secret]',
  'settings',
  'text-selection',
] as const;
export type FunnelScreen = (typeof FUNNEL_SCREENS)[number];
/** Screen events are sent and kept only within this long after `signed_in`. */
export const FUNNEL_FIRST_SESSION_MS = 10 * 60_000;
/** At most this many screen events per install in that window; a person who reaches it is "capped". */
export const FUNNEL_SCREEN_SEND_CAP = 64;
/** Maps expo-router segment patterns to an allowlisted screen, or null. */
export function funnelScreenFromSegments(segments: readonly string[]): FunnelScreen | null {
  const parts = segments.filter((segment) => !segment.startsWith('('));
  if (parts[parts.length - 1] === 'index') parts.pop();
  const route = parts.join('/') || 'index';
  return FUNNEL_SCREENS.includes(route as never) ? (route as FunnelScreen) : null;
}
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
  screen?: FunnelScreen;
  option?: 'A' | 'B' | 'C' | 'D';
  durationMs?: number;
  artifactId?: string;
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
  'screen',
  'timestamp',
  'option',
  'durationMs',
  'artifactId',
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
  if (v.artifactId !== undefined && (!['game_posted', 'game_viewer_opened', 'game_viewer_closed'].includes(v.event as string) || typeof v.artifactId !== 'string' || !FUNNEL_UUID.test(v.artifactId))) return null;
  if (v.option !== undefined && (!ONBOARDING_EVENTS.includes(v.event as never) || !['A', 'B', 'C', 'D'].includes(v.option as string))) return null;
  if (v.durationMs !== undefined && (v.event !== 'game_viewer_closed' || !Number.isSafeInteger(v.durationMs) || Number(v.durationMs) < 0 || Number(v.durationMs) > 86_400_000)) return null;
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
  if (
    v.event === 'screen_shown'
      ? !FUNNEL_SCREENS.includes(v.screen as never)
      : v.screen !== undefined
  )
    return null;
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
