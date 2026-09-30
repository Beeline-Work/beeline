/**
 * Declarative, bounded workflow contracts: named roles (not specific agents),
 * handoffs between roles with required contents, loop caps with an
 * ask-a-human escape, human decision points via the existing choice cards,
 * and done/failed terminals. No run-state is stored anywhere: a run's
 * current step and loop count are derived from the transcript of the Room it
 * runs in (see the server's `workflow-runs.ts`).
 *
 * A workflow contract is stored as a `workspace_skills` row with
 * `kind='workflow'` (see `institutional-memory.ts`'s `WORKSPACE_SKILL_*`
 * constants, which this file reuses for the shared byte/description caps).
 */
import { CHOICE_LABEL_MAX_LENGTH } from './room-choices.js';

export const WORKFLOW_CONTRACT_VERSION = 1;
export const WORKFLOW_ROLES_MAX = 16;
export const WORKFLOW_STATES_MIN = 2;
export const WORKFLOW_STATES_MAX = 64;
export const WORKFLOW_REQUIRES_MAX = 32;
export const WORKFLOW_OUTCOMES_MIN = 1;
export const WORKFLOW_OUTCOMES_MAX = 16;
/** A gate reuses the ask_choice card directly, so it inherits that card's option bounds. */
export const WORKFLOW_GATE_OUTCOMES_MIN = 2;
export const WORKFLOW_GATE_OUTCOMES_MAX = 4;
export const WORKFLOW_LOOP_CAP_MAX = 100;
export const WORKFLOW_CONTENTS_MAX_BYTES = 16_384;
/** `agent_schedules` interval granularity is whole minutes; timeouts round up to it. */
export const WORKFLOW_TIMEOUT_SECONDS_MIN = 60;
export const WORKFLOW_TIMEOUT_SECONDS_MAX = 30 * 24 * 60 * 60;

export type WorkflowLoop = {
  readonly onEdge: string;
  readonly cap: number;
  readonly onExceeded: string;
};

/** An ordinary agent-to-agent handoff: whoever holds `role` acts and reports an outcome. */
export type WorkflowHandoffState = {
  readonly kind?: undefined;
  readonly role: string;
  /**
   * Resolve `role`'s bound agent LIVE at each dispatch (format `live:<dotted
   * path>`, e.g. `live:parent.reviewer_agent_id`) instead of the pinned
   * `roleBindings` recorded at `start_workflow` time — for a role whose
   * configuration can change after a run starts. The generic engine does not
   * interpret the path: only the server code that understands it can resolve
   * and act on it, and the pinned `roleBindings` value the generic engine
   * checks against is a non-agent marker string (the path itself), so
   * `handoff()`'s ordinary `boundAgentId !== command.agent_id` check can
   * never match a real agent and safely refuses every ordinary call.
   */
  readonly roleBinding?: string;
  readonly requires: readonly string[];
  readonly on: Readonly<Record<string, string>>;
  readonly loop?: WorkflowLoop;
  /** Seconds until the bound agent is reminded to move this state on. Gates cannot time out this way. */
  readonly timeoutSeconds?: number;
};

/** Posts an `ask_choice` card; `role`'s agent is woken once a human answers. */
export type WorkflowGateState = {
  readonly kind: 'gate';
  readonly role: string;
  readonly requires: readonly string[];
  readonly on: Readonly<Record<string, string>>;
};

/**
 * A transition the SERVER posts as a side effect of code it already runs
 * (webhook processing, an existing daemon operation) rather than an agent's
 * own `handoff()` tool call. `role` is advisory only (who this state is
 * conceptually "waiting on", for a readable card) and is never checked for
 * authorization the way a `WorkflowHandoffState`'s role is: `handoff()` and
 * `start_workflow` both refuse to advance a `kind:'server'` state at all, so
 * only the server's own write path can move one.
 */
export type WorkflowServerState = {
  readonly kind: 'server';
  readonly role?: string;
  readonly requires: readonly string[];
  readonly on: Readonly<Record<string, string>>;
  readonly loop?: WorkflowLoop;
};

export type WorkflowTerminalState = {
  readonly kind: 'terminal';
  /** `abandoned` is a human-closed run, distinct from a `failed` escalation. */
  readonly status: 'done' | 'failed' | 'abandoned';
};

/**
 * A parked, non-terminal state with no declared outgoing edges of its own —
 * used for a loop's ask-a-human escape when there is no real choice card
 * today, only a plain informational line. Distinct from `kind:'gate'`, which
 * stays available for a genuine human decision point. Only reachable by
 * `implicitEdges` after this (e.g. a human closing a stalled run), never by
 * an ordinary `on` edge or by `handoff()`/`start_workflow`.
 */
export type WorkflowWaitingState = {
  readonly kind: 'waiting';
  /** Advisory only, exactly like `WorkflowServerState.role` — who is conceptually active here. */
  readonly role?: string;
};

export type WorkflowState =
  | WorkflowHandoffState
  | WorkflowGateState
  | WorkflowServerState
  | WorkflowTerminalState
  | WorkflowWaitingState;

export type WorkflowContract = {
  readonly version: 1;
  readonly name: string;
  readonly description: string;
  readonly roles: readonly string[];
  readonly start: string;
  readonly handoffs: Readonly<Record<string, WorkflowState>>;
  /**
   * Terminal state names reachable from ANY non-terminal state at any time,
   * independent of graph position — a merge webhook or a human close request
   * doesn't wait for a run to be "at" a particular state. Each named state
   * must itself be `kind:'terminal'`.
   */
  readonly implicitEdges?: readonly string[];
  /**
   * Outcome names that only an event from outside the run can report — for
   * the corner, a new commit landing on its branch or GitHub refusing a merge.
   * The run cannot reach such an edge again on its own, so cycle detection
   * ignores edges with these outcomes. Each must be an outcome some state
   * declares.
   */
  readonly externalOutcomes?: readonly string[];
};

/** The workflow's own name, stored as `workspace_skills.slug` (hyphen only, per that column's CHECK). */
const CONTRACT_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Role names, state names, and outcome words: lowercase, hyphen or underscore. */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** `requires` field names double as JS/JSON object keys, so camelCase is allowed. */
const FIELD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
/** `roleBinding`: `live:` followed by a dotted lowercase path, e.g. `live:parent.reviewer_agent_id`. */
const ROLE_BINDING_PATTERN = /^live:[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const WORKFLOW_DESCRIPTION_MAX_LENGTH = 60;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const isIdentifierArray = (value: unknown, max: number, pattern: RegExp): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((entry) => typeof entry === 'string' && pattern.test(entry)) &&
  new Set(value).size === value.length;

/**
 * Reject a malformed, unreachable, or uncapped-loop contract before storage.
 * Mirrors the reachability/cycle-detection approach of the reverted engine's
 * `readWorkflowDefinition` (BFS reachability from `start`, DFS cycle check
 * with capped loop-edges excluded), rewritten against this smaller schema.
 */
export function readWorkflowContract(value: unknown): WorkflowContract | null {
  if (
    !record(value) ||
    !keys(value, [
      'version',
      'name',
      'description',
      'roles',
      'start',
      'handoffs',
      'implicitEdges',
      'externalOutcomes',
    ]) ||
    value.version !== WORKFLOW_CONTRACT_VERSION
  )
    return null;
  if (typeof value.name !== 'string' || !CONTRACT_NAME_PATTERN.test(value.name) || value.name.length > 64)
    return null;
  if (
    typeof value.description !== 'string' ||
    value.description.length < 1 ||
    value.description.length > WORKFLOW_DESCRIPTION_MAX_LENGTH
  )
    return null;
  if (!isIdentifierArray(value.roles, WORKFLOW_ROLES_MAX, IDENTIFIER_PATTERN) || value.roles.length < 1)
    return null;
  const roles = new Set(value.roles as string[]);
  if (
    !record(value.handoffs) ||
    Object.keys(value.handoffs).length < WORKFLOW_STATES_MIN ||
    Object.keys(value.handoffs).length > WORKFLOW_STATES_MAX ||
    typeof value.start !== 'string' ||
    !Object.hasOwn(value.handoffs, value.start)
  )
    return null;
  const states = value.handoffs as Record<string, unknown>;
  if (
    value.externalOutcomes !== undefined &&
    !isIdentifierArray(value.externalOutcomes, WORKFLOW_OUTCOMES_MAX, IDENTIFIER_PATTERN)
  )
    return null;
  const external = new Set((value.externalOutcomes as string[] | undefined) ?? []);
  const edges = new Map<string, string[]>();
  /** The same edges minus those only an outside event can take (`externalOutcomes`). */
  const cycleEdges = new Map<string, string[]>();
  const declaredOutcomes = new Set<string>();
  let terminalCount = 0;
  for (const [name, raw] of Object.entries(states)) {
    if (!IDENTIFIER_PATTERN.test(name) || !record(raw)) return null;
    if (raw.kind === 'terminal') {
      if (
        !keys(raw, ['kind', 'status']) ||
        (raw.status !== 'done' && raw.status !== 'failed' && raw.status !== 'abandoned')
      )
        return null;
      terminalCount += 1;
      edges.set(name, []);
      cycleEdges.set(name, []);
      continue;
    }
    if (raw.kind === 'waiting') {
      if (!keys(raw, ['kind', 'role'])) return null;
      if (raw.role !== undefined && (typeof raw.role !== 'string' || !roles.has(raw.role)))
        return null;
      edges.set(name, []);
      cycleEdges.set(name, []);
      continue;
    }
    const isGate = raw.kind === 'gate';
    const isServer = raw.kind === 'server';
    if (raw.kind !== undefined && !isGate && !isServer) return null;
    const allowedKeys = isGate
      ? ['kind', 'role', 'requires', 'on']
      : isServer
        ? ['kind', 'role', 'requires', 'on', 'loop']
        : ['role', 'roleBinding', 'requires', 'on', 'loop', 'timeoutSeconds'];
    if (!keys(raw, allowedKeys)) return null;
    if (isServer) {
      if (raw.role !== undefined && (typeof raw.role !== 'string' || !roles.has(raw.role)))
        return null;
    } else if (typeof raw.role !== 'string' || !roles.has(raw.role)) return null;
    if (
      !isGate &&
      !isServer &&
      raw.roleBinding !== undefined &&
      (typeof raw.roleBinding !== 'string' ||
        raw.roleBinding.length > 128 ||
        !ROLE_BINDING_PATTERN.test(raw.roleBinding))
    )
      return null;
    if (!isIdentifierArray(raw.requires, WORKFLOW_REQUIRES_MAX, FIELD_NAME_PATTERN)) return null;
    if (!record(raw.on)) return null;
    const outcomes = Object.entries(raw.on);
    const outcomeMin = isGate ? WORKFLOW_GATE_OUTCOMES_MIN : WORKFLOW_OUTCOMES_MIN;
    const outcomeMax = isGate ? WORKFLOW_GATE_OUTCOMES_MAX : WORKFLOW_OUTCOMES_MAX;
    if (outcomes.length < outcomeMin || outcomes.length > outcomeMax) return null;
    const outcomeLabelMax = isGate ? CHOICE_LABEL_MAX_LENGTH : 64;
    if (
      !outcomes.every(
        ([outcome, target]) =>
          IDENTIFIER_PATTERN.test(outcome) &&
          outcome.length <= outcomeLabelMax &&
          typeof target === 'string' &&
          Object.hasOwn(states, target),
      )
    )
      return null;
    const on = raw.on as Record<string, string>;
    const targets = outcomes.map(([, target]) => target as string);
    const cycleTargets = outcomes
      .filter(([outcome]) => !external.has(outcome))
      .map(([, target]) => target as string);
    for (const [outcome] of outcomes) declaredOutcomes.add(outcome);
    if (!isGate && !isServer && raw.timeoutSeconds !== undefined) {
      if (
        !Number.isInteger(raw.timeoutSeconds) ||
        (raw.timeoutSeconds as number) < WORKFLOW_TIMEOUT_SECONDS_MIN ||
        (raw.timeoutSeconds as number) > WORKFLOW_TIMEOUT_SECONDS_MAX ||
        !Object.hasOwn(on, 'timeout')
      )
        return null;
    }
    if (!isGate && raw.loop !== undefined) {
      const loop = raw.loop;
      if (
        !record(loop) ||
        !keys(loop, ['onEdge', 'cap', 'onExceeded']) ||
        typeof loop.onEdge !== 'string' ||
        !Object.hasOwn(on, loop.onEdge) ||
        !Number.isInteger(loop.cap) ||
        (loop.cap as number) < 1 ||
        (loop.cap as number) > WORKFLOW_LOOP_CAP_MAX ||
        typeof loop.onExceeded !== 'string' ||
        !Object.hasOwn(states, loop.onExceeded) ||
        loop.onExceeded === on[loop.onEdge as string]
      )
        return null;
      targets.push(loop.onExceeded as string);
      cycleTargets.push(loop.onExceeded as string);
    }
    edges.set(name, targets);
    cycleEdges.set(name, cycleTargets);
  }
  if (![...external].every((outcome) => declaredOutcomes.has(outcome))) return null;
  if (terminalCount < 1) return null;
  if ((states[value.start as string] as Record<string, unknown>).kind === 'terminal') return null;
  if (value.implicitEdges !== undefined) {
    if (
      !isIdentifierArray(value.implicitEdges, WORKFLOW_STATES_MAX, IDENTIFIER_PATTERN) ||
      !(value.implicitEdges as string[]).every(
        (name) =>
          Object.hasOwn(states, name) &&
          (states[name] as Record<string, unknown>).kind === 'terminal',
      )
    )
      return null;
  }
  // Reachability: every declared state must be reached from `start`, plus
  // every `implicitEdges` terminal — reachable from anywhere by definition,
  // so a target used ONLY by an implicit edge is not an orphan.
  const reachable = new Set<string>();
  const visitReachable = (name: string): void => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const next of edges.get(name) ?? []) visitReachable(next);
  };
  visitReachable(value.start as string);
  for (const name of (value.implicitEdges as string[] | undefined) ?? []) reachable.add(name);
  if (reachable.size !== Object.keys(states).length) return null;
  // Cycle detection: only a loop's own declared edge, an edge only an outside
  // event can take (`externalOutcomes`), or a path through a gate, may close
  // a cycle. A gate always waits on a fresh human decision
  // before anything past it can run again, so nothing beyond it can be part
  // of an unbounded AUTOMATIC loop the way two ordinary handoffs could be.
  const visited = new Set<string>();
  const active = new Set<string>();
  const walk = (name: string): boolean => {
    if (active.has(name)) return false;
    if (visited.has(name)) return true;
    const state = states[name] as Record<string, unknown>;
    if (state.kind === 'gate') {
      visited.add(name);
      return true;
    }
    active.add(name);
    const loop =
      state.kind === undefined || state.kind === 'server'
        ? (state.loop as WorkflowLoop | undefined)
        : undefined;
    const loopTarget = loop ? (state.on as Record<string, string>)[loop.onEdge] : undefined;
    for (const next of cycleEdges.get(name) ?? []) {
      if (loopTarget !== undefined && next === loopTarget) continue;
      if (active.has(next) || !walk(next)) return false;
    }
    active.delete(name);
    visited.add(name);
    return true;
  };
  if (!walk(value.start as string)) return null;
  return value as unknown as WorkflowContract;
}

/** Validate a `handoff()` call's contents against a state's required field names. */
export function workflowContentsError(
  state: Pick<WorkflowHandoffState | WorkflowGateState, 'requires'>,
  contents: unknown,
): string | null {
  if (!record(contents)) return 'contents must be an object';
  if (Buffer.byteLength(JSON.stringify(contents), 'utf8') > WORKFLOW_CONTENTS_MAX_BYTES)
    return 'contents exceeds 16 KB';
  for (const field of state.requires) {
    if (contents[field] === undefined || contents[field] === null) return `${field} is required`;
  }
  return null;
}
