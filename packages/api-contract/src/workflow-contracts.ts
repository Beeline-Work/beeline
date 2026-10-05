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
/** A saved workflow run started through `start_workflow` closes as failed after this long unless its contract sets `deadlineSeconds`. */
export const WORKFLOW_DEFAULT_DEADLINE_SECONDS = 24 * 60 * 60;
/**
 * The built-in outcome every handoff state accepts: the holder cannot do the
 * step, says why in `contents.reason`, and the step moves to the next eligible
 * agent on its role list. New saves may not declare it in `on`.
 */
export const WORKFLOW_BLOCKED_OUTCOME = 'blocked';
/** Agents one `start_workflow` role binding may list, tried in order. */
export const WORKFLOW_ROLE_AGENTS_MAX = 16;
export const WORKFLOW_TEXT_MAX_LENGTH = 140;
export const WORKFLOW_RECEIPT_REFS_MAX = 3;
export const WORKFLOW_RECEIPT_REF_KINDS = ['brief', 'file', 'message', 'pr', 'checks', 'memory', 'url'] as const;

export type WorkflowReceiptRef = {
  readonly kind: (typeof WORKFLOW_RECEIPT_REF_KINDS)[number];
  readonly label: string;
  readonly url: string;
};
export type WorkflowReceiptInput = {
  readonly line?: string;
  readonly refs?: readonly WorkflowReceiptRef[];
};
export type WorkflowReceipt = WorkflowReceiptInput & {
  /** Written by the engine, never accepted from the agent. */
  readonly exit: { readonly gate: string; readonly actorId: string };
};

const IDENTITY_ID_PATTERN = /^[0-9a-f]{64}$/;

/** True for a real identity id (always 64 lowercase hex characters). */
export function isAgentIdentityReference(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_ID_PATTERN.test(value);
}

/**
 * A `start_workflow` role binding: one agent, or an ordered list of agents.
 * A list role goes to the first healthy agent on it and fails over down the
 * list in order when the agent holding it fails or goes silent.
 */
export type WorkflowRoleBinding = string | readonly string[];

export type WorkflowLoop = {
  readonly onEdge: string;
  readonly cap: number;
  readonly onExceeded: string;
};

/** An ordinary agent-to-agent handoff: whoever holds `role` acts and reports an outcome. */
export type WorkflowHandoffState = {
  /** A short sentence for people reading the run. Optional on legacy revisions. */
  readonly does?: string;
  readonly hint?: string;
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
  /**
   * Seconds each agent on the role list gets. When it passes, the engine moves
   * the step to the next eligible agent; once the list is used up it applies
   * the `timeout` outcome itself.
   */
  readonly timeoutSeconds?: number;
};

/** Posts an `ask_choice` card; a person's answer moves the run on. */
export type WorkflowGateState = {
  /** A short sentence for people reading the run. Optional on legacy revisions. */
  readonly does?: string;
  readonly hint?: string;
  readonly kind: 'gate';
  readonly role: string;
  readonly requires: readonly string[];
  readonly on: Readonly<Record<string, string>>;
  /** Seconds until an unanswered gate takes `default`. Declared together with `default`. */
  readonly timeoutSeconds?: number;
  /** The outcome applied on timeout or on a person's Skip. One of `on`. */
  readonly default?: string;
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
  /** A short sentence for people reading the run. Optional on legacy revisions. */
  readonly does?: string;
  readonly hint?: string;
  readonly kind: 'server';
  readonly role?: string;
  readonly requires: readonly string[];
  readonly on: Readonly<Record<string, string>>;
  readonly loop?: WorkflowLoop;
};

export type WorkflowTerminalState = {
  /** A short sentence for people reading the run. Optional on legacy revisions. */
  readonly does?: string;
  readonly hint?: string;
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
  /** A short sentence for people reading the run. Optional on legacy revisions. */
  readonly does?: string;
  readonly hint?: string;
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
  readonly summary?: string;
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
  /** Seconds a run may stay live before the engine closes it as failed. */
  readonly deadlineSeconds?: number;
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
const unknownKey = (value: Record<string, unknown>, allowed: readonly string[]): string | undefined =>
  Object.keys(value).find((key) => !allowed.includes(key));
const isIdentifierArray = (value: unknown, max: number, pattern: RegExp): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((entry) => typeof entry === 'string' && pattern.test(entry)) &&
  new Set(value).size === value.length;

const timeoutInRange = (value: unknown): boolean =>
  Number.isInteger(value) &&
  (value as number) >= WORKFLOW_TIMEOUT_SECONDS_MIN &&
  (value as number) <= WORKFLOW_TIMEOUT_SECONDS_MAX;

const oneLine = (value: unknown): value is string =>
  typeof value === 'string' && Array.from(value).length <= WORKFLOW_TEXT_MAX_LENGTH &&
  !/[\r\n\u2028\u2029]/.test(value);

/** Validate the optional agent-supplied receipt before a transition is written. */
export function workflowReceiptError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!record(value) || unknownKey(value, ['line', 'refs']) !== undefined)
    return 'receipt must be an object with optional line and refs; exit is engine-owned';
  if (value.line !== undefined && !oneLine(value.line))
    return `receipt.line must be plaintext on one line, at most ${WORKFLOW_TEXT_MAX_LENGTH} characters`;
  if (value.refs !== undefined) {
    if (!Array.isArray(value.refs) || value.refs.length > WORKFLOW_RECEIPT_REFS_MAX)
      return `receipt.refs must contain 0-${WORKFLOW_RECEIPT_REFS_MAX} references`;
    for (const ref of value.refs) {
      if (!record(ref) || unknownKey(ref, ['kind', 'label', 'url']) !== undefined ||
          !(WORKFLOW_RECEIPT_REF_KINDS as readonly unknown[]).includes(ref.kind) ||
          typeof ref.label !== 'string' || !ref.label.trim() ||
          typeof ref.url !== 'string' || !/^https?:\/\//i.test(ref.url))
        return 'receipt refs need a supported kind, a label and an http(s) URL';
      try { new URL(ref.url); } catch { return 'receipt ref URL is invalid'; }
    }
  }
  return null;
}

/**
 * Reject a malformed, unreachable, or uncapped-loop contract before storage.
 * Mirrors the reachability/cycle-detection approach of the reverted engine's
 * `readWorkflowDefinition` (BFS reachability from `start`, DFS cycle check
 * with capped loop-edges excluded), rewritten against this smaller schema.
 */
export function readWorkflowContract(value: unknown): WorkflowContract | null {
  return workflowContractError(value) === null ? (value as WorkflowContract) : null;
}

/**
 * The reason `readWorkflowContract` rejects `value`, naming the rule and where
 * it failed (a field, or `handoffs.<state>`), or null when the contract is valid.
 */
export function workflowContractError(value: unknown): string | null {
  if (!record(value)) return 'contract must be a JSON object';
  const topKey = unknownKey(value, [
    'version',
    'name',
    'description',
    'summary',
    'roles',
    'start',
    'handoffs',
    'implicitEdges',
    'externalOutcomes',
    'deadlineSeconds',
  ]);
  if (topKey !== undefined) return `unknown key "${topKey}" at the top level`;
  if (value.version !== WORKFLOW_CONTRACT_VERSION) return `version must be ${WORKFLOW_CONTRACT_VERSION}`;
  if (typeof value.name !== 'string' || !CONTRACT_NAME_PATTERN.test(value.name) || value.name.length > 64)
    return `name must be lowercase words joined by hyphens, at most 64 characters (got ${JSON.stringify(value.name)})`;
  if (typeof value.description !== 'string') return 'description must be a string';
  if (value.description.length < 1 || value.description.length > WORKFLOW_DESCRIPTION_MAX_LENGTH)
    return `description must be 1-${WORKFLOW_DESCRIPTION_MAX_LENGTH} characters (got ${value.description.length})`;
  if (value.summary !== undefined && !oneLine(value.summary))
    return `summary must be plaintext on one line, at most ${WORKFLOW_TEXT_MAX_LENGTH} characters`;
  if (!isIdentifierArray(value.roles, WORKFLOW_ROLES_MAX, IDENTIFIER_PATTERN) || value.roles.length < 1)
    return `roles must be 1-${WORKFLOW_ROLES_MAX} unique lowercase names (letters, digits, _ or -)`;
  const roles = new Set(value.roles as string[]);
  if (!record(value.handoffs)) return 'handoffs must be an object of named states';
  const stateCount = Object.keys(value.handoffs).length;
  if (stateCount < WORKFLOW_STATES_MIN || stateCount > WORKFLOW_STATES_MAX)
    return `handoffs must have ${WORKFLOW_STATES_MIN}-${WORKFLOW_STATES_MAX} states (got ${stateCount})`;
  if (typeof value.start !== 'string' || !Object.hasOwn(value.handoffs, value.start))
    return `start must name a state in handoffs (got ${JSON.stringify(value.start)})`;
  const states = value.handoffs as Record<string, unknown>;
  if (value.deadlineSeconds !== undefined && !timeoutInRange(value.deadlineSeconds))
    return `deadlineSeconds must be a whole number from ${WORKFLOW_TIMEOUT_SECONDS_MIN} to ${WORKFLOW_TIMEOUT_SECONDS_MAX}`;
  if (
    value.externalOutcomes !== undefined &&
    !isIdentifierArray(value.externalOutcomes, WORKFLOW_OUTCOMES_MAX, IDENTIFIER_PATTERN)
  )
    return `externalOutcomes must be up to ${WORKFLOW_OUTCOMES_MAX} unique outcome names`;
  const external = new Set((value.externalOutcomes as string[] | undefined) ?? []);
  const edges = new Map<string, string[]>();
  /** The same edges minus those only an outside event can take (`externalOutcomes`). */
  const cycleEdges = new Map<string, string[]>();
  const declaredOutcomes = new Set<string>();
  let terminalCount = 0;
  for (const [name, raw] of Object.entries(states)) {
    if (!IDENTIFIER_PATTERN.test(name))
      return `handoffs: state name "${name}" must be lowercase letters, digits, _ or -`;
    const at = `handoffs.${name}`;
    if (!record(raw)) return `${at} must be an object`;
    if (raw.does !== undefined && (!oneLine(raw.does) || !raw.does.trim()))
      return `${at}: does must be nonempty plaintext on one line, at most ${WORKFLOW_TEXT_MAX_LENGTH} characters`;
    if (raw.hint !== undefined && typeof raw.hint !== 'string') return `${at}: hint must be a string`;
    if (raw.kind === 'terminal') {
      const key = unknownKey(raw, ['kind', 'status', 'hint', 'does']);
      if (key !== undefined) return `${at}: unknown key "${key}" (a terminal allows kind, status, hint, does)`;
      if (raw.status !== 'done' && raw.status !== 'failed' && raw.status !== 'abandoned')
        return `${at}: terminal status must be done, failed or abandoned`;
      terminalCount += 1;
      edges.set(name, []);
      cycleEdges.set(name, []);
      continue;
    }
    if (raw.kind === 'waiting') {
      const key = unknownKey(raw, ['kind', 'role', 'hint', 'does']);
      if (key !== undefined) return `${at}: unknown key "${key}" (a waiting state allows kind, role, hint, does)`;
      if (raw.role !== undefined && (typeof raw.role !== 'string' || !roles.has(raw.role)))
        return `${at}: role ${JSON.stringify(raw.role)} is not in roles`;
      edges.set(name, []);
      cycleEdges.set(name, []);
      continue;
    }
    const isGate = raw.kind === 'gate';
    const isServer = raw.kind === 'server';
    if (raw.kind !== undefined && !isGate && !isServer)
      return `${at}: kind must be gate, server, terminal or waiting, or omitted for a handoff`;
    const allowedKeys = isGate
      ? ['kind', 'role', 'requires', 'on', 'timeoutSeconds', 'default']
      : isServer
        ? ['kind', 'role', 'requires', 'on', 'loop']
        : ['role', 'roleBinding', 'requires', 'on', 'loop', 'timeoutSeconds'];
    allowedKeys.push('hint', 'does');
    const key = unknownKey(raw, allowedKeys);
    if (key !== undefined)
      return `${at}: unknown key "${key}" (a ${isGate ? 'gate' : isServer ? 'server state' : 'handoff'} allows ${allowedKeys.join(', ')})`;
    if (isServer) {
      if (raw.role !== undefined && (typeof raw.role !== 'string' || !roles.has(raw.role)))
        return `${at}: role ${JSON.stringify(raw.role)} is not in roles`;
    } else if (typeof raw.role !== 'string' || !roles.has(raw.role))
      return `${at}: role ${JSON.stringify(raw.role)} is not in roles`;
    if (
      !isGate &&
      !isServer &&
      raw.roleBinding !== undefined &&
      (typeof raw.roleBinding !== 'string' ||
        raw.roleBinding.length > 128 ||
        !ROLE_BINDING_PATTERN.test(raw.roleBinding))
    )
      return `${at}: roleBinding must look like live:parent.field`;
    if (!isIdentifierArray(raw.requires, WORKFLOW_REQUIRES_MAX, FIELD_NAME_PATTERN))
      return `${at}: requires must be a list of up to ${WORKFLOW_REQUIRES_MAX} unique field names`;
    if (!record(raw.on)) return `${at}: on must be an object of outcome -> state`;
    const outcomes = Object.entries(raw.on);
    const outcomeMin = isGate ? WORKFLOW_GATE_OUTCOMES_MIN : WORKFLOW_OUTCOMES_MIN;
    const outcomeMax = isGate ? WORKFLOW_GATE_OUTCOMES_MAX : WORKFLOW_OUTCOMES_MAX;
    if (outcomes.length < outcomeMin || outcomes.length > outcomeMax)
      return `${at}: ${isGate ? 'a gate needs' : 'on needs'} ${outcomeMin}-${outcomeMax} outcomes (got ${outcomes.length})`;
    const outcomeLabelMax = isGate ? CHOICE_LABEL_MAX_LENGTH : 64;
    for (const [outcome, target] of outcomes) {
      if (!IDENTIFIER_PATTERN.test(outcome))
        return `${at}: outcome "${outcome}" must be lowercase letters, digits, _ or -`;
      if (outcome.length > outcomeLabelMax)
        return `${at}: outcome "${outcome}" is longer than ${outcomeLabelMax} characters`;
      if (typeof target !== 'string' || !Object.hasOwn(states, target))
        return `${at}: outcome "${outcome}" goes to ${JSON.stringify(target)}, which is not a state`;
    }
    const on = raw.on as Record<string, string>;
    const targets = outcomes.map(([, target]) => target as string);
    const cycleTargets = outcomes
      .filter(([outcome]) => !external.has(outcome))
      .map(([, target]) => target as string);
    for (const [outcome] of outcomes) declaredOutcomes.add(outcome);
    if (!isServer && raw.timeoutSeconds !== undefined && !timeoutInRange(raw.timeoutSeconds))
      return `${at}: timeoutSeconds must be a whole number from ${WORKFLOW_TIMEOUT_SECONDS_MIN} to ${WORKFLOW_TIMEOUT_SECONDS_MAX}`;
    if (isGate) {
      if ((raw.timeoutSeconds === undefined) !== (raw.default === undefined))
        return `${at}: a gate declares timeoutSeconds and default together, or neither`;
      if (raw.default !== undefined && (typeof raw.default !== 'string' || !Object.hasOwn(on, raw.default)))
        return `${at}: default ${JSON.stringify(raw.default)} is not an outcome in on`;
    } else if (!isServer && raw.timeoutSeconds !== undefined && !Object.hasOwn(on, 'timeout'))
      return `${at}: timeoutSeconds needs a "timeout" outcome in on`;
    if (!isGate && raw.loop !== undefined) {
      const loop = raw.loop;
      if (!record(loop) || unknownKey(loop, ['onEdge', 'cap', 'onExceeded']) !== undefined)
        return `${at}: loop must be { onEdge, cap, onExceeded }`;
      if (typeof loop.onEdge !== 'string' || !Object.hasOwn(on, loop.onEdge))
        return `${at}: loop.onEdge ${JSON.stringify(loop.onEdge)} is not an outcome in on`;
      if (!Number.isInteger(loop.cap) || (loop.cap as number) < 1 || (loop.cap as number) > WORKFLOW_LOOP_CAP_MAX)
        return `${at}: loop.cap must be a whole number from 1 to ${WORKFLOW_LOOP_CAP_MAX}`;
      if (typeof loop.onExceeded !== 'string' || !Object.hasOwn(states, loop.onExceeded))
        return `${at}: loop.onExceeded ${JSON.stringify(loop.onExceeded)} is not a state`;
      if (loop.onExceeded === on[loop.onEdge])
        return `${at}: loop.onExceeded must differ from where loop.onEdge goes`;
      targets.push(loop.onExceeded);
      cycleTargets.push(loop.onExceeded);
    }
    edges.set(name, targets);
    cycleEdges.set(name, cycleTargets);
  }
  for (const outcome of external)
    if (!declaredOutcomes.has(outcome)) return `externalOutcomes: "${outcome}" is not an outcome of any state`;
  if (terminalCount < 1) return 'at least one terminal state is required';
  if ((states[value.start] as Record<string, unknown>).kind === 'terminal')
    return `start state "${value.start}" must not be a terminal`;
  if (value.implicitEdges !== undefined) {
    if (!isIdentifierArray(value.implicitEdges, WORKFLOW_STATES_MAX, IDENTIFIER_PATTERN))
      return 'implicitEdges must be a list of unique state names';
    const notTerminal = value.implicitEdges.find(
      (name) =>
        !Object.hasOwn(states, name) || (states[name] as Record<string, unknown>).kind !== 'terminal',
    );
    if (notTerminal !== undefined) return `implicitEdges: "${notTerminal}" is not a terminal state`;
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
  visitReachable(value.start);
  for (const name of (value.implicitEdges as string[] | undefined) ?? []) reachable.add(name);
  const orphan = Object.keys(states).find((name) => !reachable.has(name));
  if (orphan !== undefined) return `state "${orphan}" is not reachable from start`;
  if (reachable.size !== Object.keys(states).length) return 'implicitEdges must be a list of unique state names';
  // Cycle detection: only a loop's own declared edge, an edge only an outside
  // event can take (`externalOutcomes`), or a path through a gate, may close
  // a cycle. A gate always waits on a fresh human decision
  // before anything past it can run again, so nothing beyond it can be part
  // of an unbounded AUTOMATIC loop the way two ordinary handoffs could be.
  const visited = new Set<string>();
  /** The current DFS path, so an uncapped cycle can be named. */
  const active: string[] = [];
  let cycle: string[] = [];
  const walk = (name: string): boolean => {
    if (visited.has(name)) return true;
    const state = states[name] as Record<string, unknown>;
    if (state.kind === 'gate') {
      visited.add(name);
      return true;
    }
    active.push(name);
    const loop =
      state.kind === undefined || state.kind === 'server'
        ? (state.loop as WorkflowLoop | undefined)
        : undefined;
    const loopTarget = loop ? (state.on as Record<string, string>)[loop.onEdge] : undefined;
    for (const next of cycleEdges.get(name) ?? []) {
      if (loopTarget !== undefined && next === loopTarget) continue;
      if (active.includes(next)) {
        cycle = [...active.slice(active.indexOf(next)), next];
        return false;
      }
      if (!walk(next)) return false;
    }
    active.pop();
    visited.add(name);
    return true;
  };
  if (!walk(value.start)) return `cycle ${cycle.join(' -> ')} has no loop cap`;
  return null;
}

/** Validate a `handoff()` call's contents against a state's required field names. */
export function workflowContentsError(
  state: Pick<WorkflowHandoffState | WorkflowGateState, 'requires'>,
  contents: unknown,
): string | null {
  if (!record(contents)) return 'contents must be an object';
  if (Buffer.byteLength(JSON.stringify(contents), 'utf8') > WORKFLOW_CONTENTS_MAX_BYTES)
    return 'contents exceeds 16 KB';
  const missing = state.requires.filter((field) => contents[field] === undefined || contents[field] === null);
  if (missing.length) return missing.map((field) => `${field} is required`).join('; ');
  return null;
}

/** Agent read of a saved run, including the exact contract pinned at start. */
export type WorkflowRunReadResult = {
  readonly runId: string;
  readonly workflowSlug: string;
  readonly workflowVersion: number;
  readonly state: string;
  /** Pass this to `handoff`; it changes every time the step moves or is reassigned. */
  readonly attempt: number;
  readonly status: 'live' | 'done' | 'failed' | 'abandoned';
  readonly role?: string;
  readonly boundAgentId?: string;
  readonly allowedOutcomes: Readonly<Record<string, string>>;
  readonly requiredFields: readonly string[];
  readonly receiptHint?: string;
  readonly cancellation?: { readonly reason: string; readonly actorId: string };
  readonly contract: WorkflowContract;
  readonly history: readonly {
    readonly messageId: string;
    readonly actorId: string;
    readonly at: number;
    readonly fromState?: string;
    readonly toState: string;
    readonly outcome?: string;
    readonly contents?: unknown;
    readonly receipt?: WorkflowReceipt;
    readonly reassigned?: true;
    readonly status?: 'done' | 'failed' | 'abandoned';
    readonly cancellation?: { readonly reason: string; readonly actorId: string };
  }[];
};

/**
 * New saves require human descriptions, a timeout on every agent step and a
 * timeout with a default on every gate, so no run can wait on nobody;
 * pinned legacy reads keep their original contract.
 */
export function workflowSaveError(value: unknown): string | null {
  const error = workflowContractError(value);
  if (error) return error;
  const contract = value as WorkflowContract;
  for (const field of ['implicitEdges', 'externalOutcomes'] as const)
    if (Object.hasOwn(contract, field)) return `${field} is corner-only and cannot be saved in a workflow`;
  if (!contract.summary?.trim()) return 'summary is required and must be nonempty';
  for (const [name, state] of Object.entries(contract.handoffs)) {
    if (state.kind === 'server' || state.kind === 'waiting')
      return `handoffs.${name}: kind ${state.kind} is corner-only and cannot be saved in a workflow`;
    if (Object.hasOwn(state, 'roleBinding'))
      return `handoffs.${name}: roleBinding is corner-only and cannot be saved in a workflow`;
    if (!state.does?.trim()) return `handoffs.${name}: does is required and must be nonempty`;
    if ('on' in state && Object.hasOwn(state.on, WORKFLOW_BLOCKED_OUTCOME))
      return `handoffs.${name}: "${WORKFLOW_BLOCKED_OUTCOME}" is built in; name this outcome something else`;
    if (state.kind === undefined && state.timeoutSeconds === undefined)
      return `handoffs.${name}: timeoutSeconds is required, with a "timeout" outcome in on`;
    if (state.kind === 'gate' && (state.timeoutSeconds === undefined || state.default === undefined))
      return `handoffs.${name}: a gate needs timeoutSeconds and default`;
  }
  return null;
}
