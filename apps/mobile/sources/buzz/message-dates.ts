import type { ChatDisplayMessage } from './room-view-presentation';
import { ledgerStamp } from './relative-time';

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

function atDate(seconds: number | undefined): Date | null {
  if (!seconds || seconds <= 0) return null;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? null : at;
}

function localDayKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
}

export function isLedgerDayOpener(
  timestamp: number | undefined,
  previousTimestamp: number | undefined,
): boolean {
  const at = atDate(timestamp);
  if (!at) return false;
  const previous = atDate(previousTimestamp);
  if (!previous) return true;
  return localDayKey(at) !== localDayKey(previous);
}

export function ledgerDate(seconds: number | undefined): string {
  const at = atDate(seconds);
  if (!at) return '';
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/** Absolute weekday+date caption, or null when this row is not a day opener. */
export function ledgerDayCaption(
  timestamp: number | undefined,
  previousTimestamp?: number | undefined,
): string | null {
  if (!isLedgerDayOpener(timestamp, previousTimestamp)) return null;
  const at = atDate(timestamp);
  if (!at) return null;
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/**
 * Bylines: the clock, plus the date when the message is not today.
 * Today never carries a date. Gutter stamps stay on `ledgerStamp`.
 * The date is on every past-day byline so a reader landed at the newest
 * row still sees it; the day caption remains the opener-only marker.
 */
export function transcriptStamp(
  timestamp: number | undefined,
  _firstBylineOfDay: boolean,
  nowMs: number = Date.now(),
): string {
  const clock = ledgerStamp(timestamp);
  if (!clock) return '';
  const at = atDate(timestamp);
  const now = new Date(nowMs);
  if (!at || localDayKey(at) === localDayKey(now)) return clock;
  return `${ledgerDate(timestamp)} ${clock}`;
}

function hasTranscriptByline(message: ChatDisplayMessage): boolean {
  return !(
    message.roomUpdate ||
    message.writePermission ||
    message.grantRequest ||
    message.squireApproval ||
    message.choice ||
    message.connectorOffer ||
    message.walletTx ||
    message.walletInsufficient ||
    message.walletDelegation ||
    message.targetBranchProposal ||
    message.cornerApp ||
    message.relay ||
    message.corner ||
    message.notificationLifecycleRun ||
    message.githubEvent ||
    message.daemonFact ||
    message.isArchivedNotice ||
    message.isSystemNotice ||
    message.durableFact ||
    message.isAgentActivity
  );
}

export function transcriptBylineOpeners(
  messages: readonly ChatDisplayMessage[],
  hasByline: (message: ChatDisplayMessage) => boolean = hasTranscriptByline,
): Set<string> {
  const openers = new Set<string>();
  let previousTimestamp: number | undefined;
  for (const message of messages) {
    if (!hasByline(message)) continue;
    if (isLedgerDayOpener(message.timestamp, previousTimestamp)) openers.add(message.id);
    previousTimestamp = message.timestamp;
  }
  return openers;
}
