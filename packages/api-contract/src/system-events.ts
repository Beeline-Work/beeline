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
  /** The commit whose check state this object reports; groups one live CI batch. */
  readonly headSha?: string;
};

export type SystemEvent = {
  readonly subject: SystemSubject;
  readonly verb: string;
  readonly object?: SystemObject;
  readonly consequence?: string;
  /** What this line IS, for subscribers and daemons. Absent on a line nobody reacts to. */
  readonly kind?: SystemEventKind;
  /** Outside input, carried only by an untrusted webhook event. */
  readonly payload?: unknown;
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
  'squire-approval-decided',
  'connector-offer-decided',
  'turn-cancelled',
  'choice-answered',
  'choice-skipped',
  'poll-closed',
  'workflow-handoff',
  'webhook-request-decided',
] as const;
export type ServerEventKind = (typeof SERVER_EVENT_KINDS)[number];

/**
 * One line each, naming when a kind fires. The single source `subscribe_events`'s
 * tool description, the agent rulebook (`beeline-skill.ts`), and any other
 * catalog read from (`eventKindCatalogLines`): a kind added to
 * `SERVER_EVENT_KINDS` with no entry here is a type error, so the list a model
 * reads can never drift from the list the server actually fires.
 */
export const SERVER_EVENT_KIND_DETAIL: Readonly<Record<ServerEventKind, string>> = {
  'joined': 'fires when a person or agent joins this Room, or when a Workspace arrival projects into it',
  'schedule-ran': 'fires when a schedule you created runs',
  'corner-opened': 'fires when a corner opens under this Room',
  'check-passed': "fires when a corner's pull request checks turn green",
  'check-failed': "fires when a corner's pull request checks turn red",
  'merged': "fires when a corner's pull request merges",
  'grant-decided': 'carries the grant id and status and resumes the turn that asked for the grant',
  'squire-approval-decided':
    'carries what was approved or denied and the Squire approval id, and resumes the turn that asked',
  'connector-offer-decided':
    'fires when a human accepts or declines an offered connector, or a reconnect ceremony finishes, and resumes the turn that offered it',
  'turn-cancelled': 'fires when a running turn is stopped',
  'choice-answered': 'fires when a human answers a posted choice, starting a new turn for the asking agent',
  'choice-skipped':
    "fires when a posted choice's window closes unanswered, starting a new turn for the asking agent",
  'poll-closed': 'fires when a posted poll closes, starting a new turn for the asking agent',
  'workflow-handoff': 'fires when a workflow run starts or hands off to its next role',
  'webhook-request-decided': 'answers one webhook request and resumes its requesting agent',
};

/**
 * Kinds that answer ONE ask - a specific grant, choice, poll, approval, or
 * turn - whose owner is woken directly (`wakes: [...]` at the call site that
 * fires the event), with no subscription involved. A Room-wide subscription
 * to one of these would wake the subscriber on every OTHER agent's item too,
 * forever - effectively a standing hook on everyone else's turns, not a
 * description of what wakes the subscriber's own work. So none of these may
 * be subscribed to; only Room-level news stays subscribable.
 */
export const PER_ITEM_EVENT_KINDS: readonly ServerEventKind[] = [
  'grant-decided',
  'squire-approval-decided',
  'connector-offer-decided',
  'turn-cancelled',
  'choice-answered',
  'choice-skipped',
  'poll-closed',
  'webhook-request-decided',
];
export function isPerItemEventKind(value: unknown): value is ServerEventKind {
  return (PER_ITEM_EVENT_KINDS as readonly string[]).includes(value as string);
}

/** The kinds a Room-wide subscription may react to: Room-level news only. */
export const SUBSCRIBABLE_EVENT_KINDS: readonly ServerEventKind[] = SERVER_EVENT_KINDS.filter(
  (kind) => !isPerItemEventKind(kind),
);
export function isSubscribableEventKind(value: unknown): value is ServerEventKind | WebhookEventKind {
  return isWebhookKind(value) || (SUBSCRIBABLE_EVENT_KINDS as readonly string[]).includes(value as string);
}

/** The one-line refusal `subscribe_events` gives for a per-item kind. */
export function perItemSubscriptionRefusal(kind: string): string {
  return (
    `${kind} wakes its own item's owner automatically, with no subscription needed; ` +
    `a Room-wide subscription to it is refused. Subscribable kinds are ${SUBSCRIBABLE_EVENT_KINDS.join(', ')}.`
  );
}

/** "kind detail" for every subscribable kind, in catalog order. */
export function eventKindCatalogLines(
  kinds: readonly ServerEventKind[] = SUBSCRIBABLE_EVENT_KINDS,
): readonly string[] {
  return kinds.map((kind) => `${kind} ${SERVER_EVENT_KIND_DETAIL[kind]}`);
}
export type AgentEventKind = `agent:${string}`;
export type WebhookEventKind = `webhook:${string}`;
export type SystemEventKind = ServerEventKind | AgentEventKind | WebhookEventKind;

export function isWebhookKind(value: unknown): value is WebhookEventKind {
  return typeof value === 'string' && /^webhook:[a-z0-9-]{1,40}$/.test(value);
}

const AGENT_KIND = /^agent:[a-z0-9-]{1,40}$/;

export function isServerEventKind(value: unknown): value is ServerEventKind {
  return (SERVER_EVENT_KINDS as readonly string[]).includes(value as string);
}
export function isAgentKind(value: unknown): value is AgentEventKind {
  return typeof value === 'string' && AGENT_KIND.test(value);
}
export function isSystemEventKind(value: unknown): value is SystemEventKind {
  return isServerEventKind(value) || isAgentKind(value) || isWebhookKind(value);
}

/**
 * Kinds that RESUME a turn instead of starting one. A grant decision is the
 * answer to a turn already paused on the ask (`isGrantDecisionLine`); treating
 * it as a new trigger would run the same work twice. An accepted connector
 * offer answers a turn paused the same way (`connector-offers.ts`). Choice
 * answers start a new `input` turn (`choice-answered` / `choice-skipped` /
 * `poll-closed`) because the asking turn already ended — they are not resume
 * kinds.
 */
export const RESUME_KINDS: readonly SystemEventKind[] = [
  'grant-decided',
  'squire-approval-decided',
  'connector-offer-decided',
  'webhook-request-decided',
];
export function isResumeKind(value: unknown): boolean {
  return RESUME_KINDS.includes(value as SystemEventKind);
}

/**
 * Kinds that CONTROL a turn already running instead of starting one. A stop
 * request names the request id of the turn it ends: the daemon reads it,
 * cancels that session and publishes nothing. Waking a new turn on it would
 * start the very work the person asked to stop, so it is excluded from the
 * subscribed-event path the way a resume kind is — and for the same reason.
 *
 * A control kind still MENTIONS the agent, because a mention is the only thing
 * that wakes its daemon, and a stop that waits for the next poll is a stop the
 * person watches not happen.
 */
export const CONTROL_KINDS: readonly SystemEventKind[] = ['turn-cancelled'];
export function isControlKind(value: unknown): boolean {
  return CONTROL_KINDS.includes(value as SystemEventKind);
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

/** Display a workflow run id in prose; structured fields keep the full id. */
export function shortRunId(id: string): string {
  return id.slice(0, 8);
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
        (object.url === undefined || typeof object.url === 'string') &&
        (object.headSha === undefined ||
          (typeof object.headSha === 'string' && /^[0-9a-f]{40}$/i.test(object.headSha))))) &&
    (event.consequence === undefined || typeof event.consequence === 'string') &&
    (event.kind === undefined || isSystemEventKind(event.kind)),
  );
}
