import type { RoomViewMessage, SystemEvent, SystemSubject } from '@beeline/api-contract/phone';

/**
 * System lines on the phone: one grammar, one renderer, one row per message.
 *
 * The server phrases every system notification (`apps/server/src/system-line.ts`)
 * as `<subject> <verb>[ <object>][ · <consequence>]` and stores the structured
 * event beside the text. The phone renders the event (names in brass, the
 * object linked by its URL). Passive lifecycle events can share a disclosure row; their message ids and posted facts remain intact.
 * A row from before the grammar has no event and renders its text verbatim.
 */
export type SystemLineMessage = {
  id: string;
  text: string;
  timestamp: number;
  orderAtMs?: number;
  foldedReadBoundaries?: { id: string; orderAtMs: number }[];
  isSystemNotice?: boolean;
  /** A deleted message's line; it holds that message's place, so it never folds. */
  deleted?: boolean;
  systemEvent?: SystemEvent;
  githubEvent?: {
    cornerId?: string;
    type: string;
    action: string;
    actor: string;
    title: string;
    url: string;
    branch?: string;
    targetBranch?: string;
  };
  daemonFact?: {
    type: 'corner-complete' | 'checks-failing' | 'worktree-cleaned' | 'corner-open';
    cornerId: string;
    name?: string;
    objective: string;
    sourceMessageId?: string;
    outcome?: 'landed' | 'abandoned';
    pullRequest?: { number?: number; title?: string; url: string };
  };
  walletTx?: RoomViewMessage['walletTx'];
  walletDelegation?: RoomViewMessage['walletDelegation'];
  authorIdentity?: { kind: 'human' | 'agent'; name: string; handle?: string };
};

/** "@candy" · "@candy and @terra" · "@candy, @terra and @codex". */
export function joinSystemNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The plain text of an event for one or several subjects (previews, accessibility). */
export function systemLineText(event: SystemEvent, subjects?: readonly SystemSubject[]): string {
  const names = (subjects ?? [event.subject]).map((subject) => subject.name);
  const head = [joinSystemNames(names), event.verb].filter(Boolean).join(' ');
  const line = event.object?.text ? `${head} ${event.object.text}` : head;
  return event.consequence ? `${line} · ${event.consequence}` : line;
}

/** A caller's preview is plain display data, separate from Beeline's own line. */
export function webhookCallerMessage(event: SystemEvent | undefined): string | undefined {
  if (event?.kind !== 'subscription-fired' || !event.payload || typeof event.payload !== 'object') return undefined;
  const payload = event.payload as { source?: unknown; body?: unknown };
  if (payload.source !== 'webhook' || payload.body === undefined) return undefined;
  const body = payload.body;
  const fields = body && typeof body === 'object' ? body as { message?: unknown; text?: unknown } : undefined;
  const words = typeof body === 'string' ? body
    : typeof fields?.message === 'string' ? fields.message
      : typeof fields?.text === 'string' ? fields.text : JSON.stringify(body);
  if (!words) return undefined;
  const characters = Array.from(words);
  return characters.length > 280 ? `${characters.slice(0, 279).join('')}…` : words;
}
