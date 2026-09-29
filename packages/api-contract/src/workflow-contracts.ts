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

export type WorkflowTerminalState = {
  readonly kind: 'terminal';
  readonly status: 'done' | 'failed';
};

export type WorkflowState = WorkflowHandoffState | WorkflowGateState | WorkflowTerminalState;

export type WorkflowContract = {
  readonly version: 1;
  readonly name: string;
  readonly description: string;
  readonly roles: readonly string[];
  readonly start: string;
  readonly handoffs: Readonly<Record<string, WorkflowState>>;
};

/** The workflow's own name, stored as `workspace_skills.slug` (hyphen only, per that column's CHECK). */
const CONTRACT_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Role names, state names, and outcome words: lowercase, hyphen or underscore. */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** `requires` field names double as JS/JSON object keys, so camelCase is allowed. */
const FIELD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
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
    !keys(value, ['version', 'name', 'description', 'roles', 'start', 'handoffs']) ||
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
  const edges = new Map<string, string[]>();
  let terminalCount = 0;
  for (const [name, raw] of Object.entries(states)) {
    if (!IDENTIFIER_PATTERN.test(name) || !record(raw)) return null;
    if (raw.kind === 'terminal') {
      if (!keys(raw, ['kind', 'status']) || (raw.status !== 'done' && raw.status !== 'failed'))
        return null;
      terminalCount += 1;
      edges.set(name, []);
      continue;
    }
    const isGate = raw.kind === 'gate';
    if (raw.kind !== undefined && !isGate) return null;
    const allowedKeys = isGate
      ? ['kind', 'role', 'requires', 'on']
      : ['role', 'requires', 'on', 'loop', 'timeoutSeconds'];
    if (!keys(raw, allowedKeys)) return null;
    if (typeof raw.role !== 'string' || !roles.has(raw.role)) return null;
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
    if (!isGate && raw.timeoutSeconds !== undefined) {
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
    }
    edges.set(name, targets);
  }
  if (terminalCount < 1) return null;
  if ((states[value.start as string] as Record<string, unknown>).kind === 'terminal') return null;
  // Reachability: every declared state must be reached from `start`.
  const reachable = new Set<string>();
  const visitReachable = (name: string): void => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const next of edges.get(name) ?? []) visitReachable(next);
  };
  visitReachable(value.start as string);
  if (reachable.size !== Object.keys(states).length) return null;
  // Cycle detection: only a loop's own declared edge, or a path through a
  // gate, may close a cycle. A gate always waits on a fresh human decision
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
    const loop = state.kind === undefined ? (state.loop as WorkflowLoop | undefined) : undefined;
    const loopTarget = loop ? (state.on as Record<string, string>)[loop.onEdge] : undefined;
    for (const next of edges.get(name) ?? []) {
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
