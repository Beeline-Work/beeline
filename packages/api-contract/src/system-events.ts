/**
 * One grammar for every system notification the server phrases.
 *
 * A system line is `<subject> <verb>[ <object>][ · <consequence>]`: the subject
 * is a name (a person, an agent, "GitHub", or the scheduler), the verb is past
 * tense and plain, the object is the thing, and the consequence is one short
 * clause. No colons, no em dashes, no trailing period, no URL in the text — a
 * URL rides on the object so the phone can link it. The server stores the text
 * beside this structured event (`messages.system_event`) so the phone can
 * render names as mentions and fold runs ("Candy, Terra and Codex joined").
 */
export type SystemSubjectKind = 'person' | 'agent' | 'github' | 'system';

export type SystemSubject = {
  readonly kind: SystemSubjectKind;
  /** The identity id when the subject is a Room identity; tappable on the phone. */
  readonly id?: string;
  readonly name: string;
};

export type SystemObject = {
  readonly text: string;
  /** An identity id when the object is a person or agent; tappable on the phone. */
  readonly id?: string;
  /** Where the object lives (a pull request, a check run); the phone links it. */
  readonly url?: string;
};

export type SystemEvent = {
  readonly subject: SystemSubject;
  readonly verb: string;
  readonly object?: SystemObject;
  readonly consequence?: string;
  /** What this line IS, for subscribers and daemons. Absent on a line nobody reacts to. */
  readonly kind?: SystemEventKind;
};

export const SYSTEM_LINE_SEPARATOR = ' · ';

/**
 * The event kinds — the machine half of a system line.
 *
 * `verb` is prose a person reads and an editor may reword; `kind` is the
 * contract a subscriber and a daemon match on. They are separate for exactly
 * that reason: `SCHEDULE_RAN_VERB` is display text, and a wording change must
 * never silently unsubscribe anybody. `kind` is additive — every verb keeps
 * the wording it already ships with.
 *
 * A server kind is a fact the SERVER authored, which is why a daemon may act
 * on it without re-checking who the row's author happens to be. An `agent:`
 * kind is a fact an agent emitted and stays gated on that agent's authority.
 */
export const SERVER_EVENT_KINDS = [
  'joined',
  'schedule-ran',
  'corner-opened',
  'check-passed',
  'check-failed',
  'merged',
  'grant-decided',
] as const;
export type ServerEventKind = (typeof SERVER_EVENT_KINDS)[number];
export type AgentEventKind = `agent:${string}`;
export type SystemEventKind = ServerEventKind | AgentEventKind;

const AGENT_KIND = /^agent:[a-z0-9-]{1,40}$/;

export function isServerEventKind(value: unknown): value is ServerEventKind {
  return (SERVER_EVENT_KINDS as readonly string[]).includes(value as string);
}
export function isAgentKind(value: unknown): value is AgentEventKind {
  return typeof value === 'string' && AGENT_KIND.test(value);
}
export function isSystemEventKind(value: unknown): value is SystemEventKind {
  return isServerEventKind(value) || isAgentKind(value);
}

/**
 * Kinds that RESUME a turn instead of starting one. A grant decision is the
 * answer to a turn already paused on the ask (`isGrantDecisionLine`); treating
 * it as a new trigger would run the same work twice.
 */
export const RESUME_KINDS: readonly SystemEventKind[] = ['grant-decided'];
export function isResumeKind(value: unknown): boolean {
  return RESUME_KINDS.includes(value as SystemEventKind);
}

/**
 * Bounds on an event cascade. The server derives depth and roots itself and
 * counts the turns one root may wake; an agent-emitted event may name at most
 * `MAX_MENTIONS_PER_EVENT` agents. Owned here so the server and the helper
 * read one number.
 */
export const MAX_EVENT_DEPTH = 4;
export const MAX_TURNS_PER_ROOT = 12;
export const MAX_MENTIONS_PER_EVENT = 3;
/** One clause, the length of a system line's consequence anywhere else. */
export const MAX_EVENT_CONSEQUENCE_LENGTH = 200;

/**
 * The refusal an agent reads when its event would extend a cascade past its
 * bounds. Phrased once, here, because the server raises it and the helper's
 * tool surfaces it verbatim: an agent that cannot tell "too deep" from "the
 * Room is out of turns" cannot decide what to do instead.
 */
export function eventDepthRefusal(depth: number): string {
  return (
    `this event would sit ${depth} events deep and the limit is ${MAX_EVENT_DEPTH}; ` +
    'nothing was posted. The chain that led here has run long enough - answer in the Room instead.'
  );
}
export function eventBudgetRefusal(woken: number): string {
  return (
    `the chain this event belongs to has already woken ${woken} turns and the limit is ` +
    `${MAX_TURNS_PER_ROOT}; nothing was posted. Answer in the Room instead of waking another agent.`
  );
}

/** "Candy" · "Candy and Terra" · "Candy, Terra and Codex". */
export function joinSystemNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The stored text for one event, or for a fold of several subjects sharing one verb. */
export function formatSystemLine(
  event: Omit<SystemEvent, 'subject'> & {
    readonly subject: SystemSubject | readonly SystemSubject[];
  },
): string {
  const subjects = Array.isArray(event.subject)
    ? (event.subject as readonly SystemSubject[])
    : [event.subject as SystemSubject];
  const head = [joinSystemNames(subjects.map((subject) => subject.name)), event.verb.trim()]
    .filter(Boolean)
    .join(' ');
  const line = event.object?.text ? `${head} ${event.object.text}` : head;
  return event.consequence ? `${line}${SYSTEM_LINE_SEPARATOR}${event.consequence}` : line;
}

export function isSystemEvent(value: unknown): value is SystemEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  const subject = event.subject as Record<string, unknown> | undefined;
  const object = event.object as Record<string, unknown> | undefined;
  return Boolean(
    subject &&
      typeof subject === 'object' &&
      (subject.kind === 'person' ||
        subject.kind === 'agent' ||
        subject.kind === 'github' ||
        subject.kind === 'system') &&
      (subject.id === undefined || typeof subject.id === 'string') &&
      typeof subject.name === 'string' &&
      typeof event.verb === 'string' &&
      (object === undefined ||
        (object &&
          typeof object === 'object' &&
          typeof object.text === 'string' &&
          (object.id === undefined || typeof object.id === 'string') &&
          (object.url === undefined || typeof object.url === 'string'))) &&
      (event.consequence === undefined || typeof event.consequence === 'string') &&
      (event.kind === undefined || isSystemEventKind(event.kind)),
  );
}
