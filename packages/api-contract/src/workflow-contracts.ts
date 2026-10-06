import type { CornerLifecycleContract, CornerLifecycleState } from './corner-lifecycle-contract.js';
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

export type WorkflowTerminalState = {
  /** A short sentence for people reading the run. Optional on legacy revisions. */
  readonly does?: string;
  readonly hint?: string;
  readonly kind: 'terminal';
  /** `abandoned` is a human-closed run, distinct from a `failed` escalation. */
  readonly status: 'done' | 'failed' | 'abandoned';
};

export type WorkflowState =
  | WorkflowHandoffState
  | WorkflowGateState
  | WorkflowTerminalState;

export type WorkflowContract = {
  readonly version: 1;
  readonly name: string;
  readonly description: string;
  readonly summary?: string;
  readonly roles: readonly string[];
  readonly start: string;
  readonly handoffs: Readonly<Record<string, WorkflowState>>;
  /** Seconds a run may stay live before the engine closes it as failed. */
  readonly deadlineSeconds?: number;
};

/** Pinned reads retain the pre-split schema until their runs end. New saves use WorkflowContract. */
export type WorkflowReadContract = Omit<WorkflowContract, 'handoffs'> & {
  readonly handoffs: Readonly<Record<string, WorkflowReadState>>;
  readonly implicitEdges?: CornerLifecycleContract['implicitEdges'];
  readonly externalOutcomes?: CornerLifecycleContract['externalOutcomes'];
};
export type WorkflowReadState = WorkflowState | CornerLifecycleState;

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

/** Read pinned contracts with their original, pre-split validation rules. */
export function readWorkflowContract(value: unknown): WorkflowReadContract | null {
  return validateCornerWorkflow(value) === null ? (value as WorkflowReadContract) : null;
}

/** New saves accept only authored workflow states, with descriptions and bounded waits. */
export function validateSavedWorkflow(value: unknown): string | null {
  if (record(value))
    for (const field of ['implicitEdges', 'externalOutcomes'] as const)
      if (Object.hasOwn(value, field))
        return cornerEdgeError(field, value[field], record(value.handoffs) ? value.handoffs : {}) ??
          `${field} is corner-only and cannot be saved in a workflow`;
  const error = workflowHeaderError(value);
  if (error) return error;
  const contract = value as WorkflowContract;
  const roles = new Set(contract.roles);
  for (const [name, raw] of Object.entries(contract.handoffs as Record<string, unknown>)) {
    const at = `handoffs.${name}`;
    if (record(raw)) {
      if (raw.kind === 'server' || raw.kind === 'waiting')
        return workflowStateError(name, raw, roles, contract.handoffs) ??
          `${at}: kind ${raw.kind} is corner-only and cannot be saved in a workflow`;
      if (Object.hasOwn(raw, 'roleBinding'))
        return workflowStateError(name, raw, roles, contract.handoffs) ??
          `${at}: roleBinding is corner-only and cannot be saved in a workflow`;
    }
    const error = workflowStateError(name, raw, roles, contract.handoffs);
    if (error) return error;
  }
  const graphError = workflowGraphError(contract);
  if (graphError) return graphError;
  if (!contract.summary?.trim()) return 'summary is required and must be nonempty';
  for (const [name, state] of Object.entries(contract.handoffs)) {
    const at = `handoffs.${name}`;
    if (!state.does?.trim()) return `${at}: does is required and must be nonempty`;
    if ('on' in state && Object.hasOwn(state.on, WORKFLOW_BLOCKED_OUTCOME))
      return `${at}: "${WORKFLOW_BLOCKED_OUTCOME}" is built in; name this outcome something else`;
    if (state.kind === undefined && state.timeoutSeconds === undefined)
      return `${at}: timeoutSeconds is required, with a "timeout" outcome in on`;
    if (state.kind === 'gate' && (state.timeoutSeconds === undefined || state.default === undefined))
      return `${at}: a gate needs timeoutSeconds and default`;
  }
  return null;
}

/** Server lifecycle validation also preserves the shape accepted by pinned legacy reads. */
export function validateCornerWorkflow(value: unknown): string | null {
  const error = workflowHeaderError(value, ['implicitEdges', 'externalOutcomes']);
  if (error) return error;
  const contract = value as WorkflowReadContract;
  if (contract.externalOutcomes !== undefined &&
      !isIdentifierArray(contract.externalOutcomes, WORKFLOW_OUTCOMES_MAX, IDENTIFIER_PATTERN))
    return `externalOutcomes must be up to ${WORKFLOW_OUTCOMES_MAX} unique outcome names`;
  const roles = new Set(contract.roles);
  for (const [name, raw] of Object.entries(contract.handoffs)) {
    const error = workflowStateError(name, raw, roles, contract.handoffs);
    if (error) return error;
  }
  return workflowGraphError(contract);
}

function workflowHeaderError(value: unknown, extraKeys: readonly string[] = []): string | null {
  if (!record(value)) return 'contract must be a JSON object';
  const topKey = unknownKey(value, [
    'version', 'name', 'description', 'summary', 'roles', 'start', 'handoffs', 'deadlineSeconds', ...extraKeys,
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
  if (!record(value.handoffs)) return 'handoffs must be an object of named states';
  const stateCount = Object.keys(value.handoffs).length;
  if (stateCount < WORKFLOW_STATES_MIN || stateCount > WORKFLOW_STATES_MAX)
    return `handoffs must have ${WORKFLOW_STATES_MIN}-${WORKFLOW_STATES_MAX} states (got ${stateCount})`;
  if (typeof value.start !== 'string' || !Object.hasOwn(value.handoffs, value.start))
    return `start must name a state in handoffs (got ${JSON.stringify(value.start)})`;
  if (value.deadlineSeconds !== undefined && !timeoutInRange(value.deadlineSeconds))
    return `deadlineSeconds must be a whole number from ${WORKFLOW_TIMEOUT_SECONDS_MIN} to ${WORKFLOW_TIMEOUT_SECONDS_MAX}`;
  return null;
}

function workflowStateError(name: string, state: unknown, roles: ReadonlySet<string>, states: object): string | null {
  if (!IDENTIFIER_PATTERN.test(name))
    return `handoffs: state name "${name}" must be lowercase letters, digits, _ or -`;
  const at = `handoffs.${name}`;
  if (!record(state)) return `${at} must be an object`;
  if (state.does !== undefined && (!oneLine(state.does) || !state.does.trim()))
    return `${at}: does must be nonempty plaintext on one line, at most ${WORKFLOW_TEXT_MAX_LENGTH} characters`;
  if (state.hint !== undefined && typeof state.hint !== 'string') return `${at}: hint must be a string`;
  if (state.kind === 'terminal') {
    const key = unknownKey(state, ['kind', 'status', 'hint', 'does']);
    if (key !== undefined) return `${at}: unknown key "${key}" (a terminal allows kind, status, hint, does)`;
    if (state.status !== 'done' && state.status !== 'failed' && state.status !== 'abandoned')
      return `${at}: terminal status must be done, failed or abandoned`;
    return null;
  }
  if (state.kind === 'waiting') {
    const key = unknownKey(state, ['kind', 'role', 'hint', 'does']);
    if (key !== undefined) return `${at}: unknown key "${key}" (a waiting state allows kind, role, hint, does)`;
    if (state.role !== undefined && (typeof state.role !== 'string' || !roles.has(state.role)))
      return `${at}: role ${JSON.stringify(state.role)} is not in roles`;
    return null;
  }
  const isGate = state.kind === 'gate';
  const isServer = state.kind === 'server';
  if (state.kind !== undefined && !isGate && !isServer)
    return `${at}: kind must be gate, server, terminal or waiting, or omitted for a handoff`;
  const allowedKeys = isGate
    ? ['kind', 'role', 'requires', 'on', 'timeoutSeconds', 'default']
    : isServer
      ? ['kind', 'role', 'requires', 'on', 'loop']
      : ['role', 'roleBinding', 'requires', 'on', 'loop', 'timeoutSeconds'];
  allowedKeys.push('hint', 'does');
  const key = unknownKey(state, allowedKeys);
  if (key !== undefined)
    return `${at}: unknown key "${key}" (a ${isGate ? 'gate' : isServer ? 'server state' : 'handoff'} allows ${allowedKeys.join(', ')})`;
  if ((!isServer || state.role !== undefined) && (typeof state.role !== 'string' || !roles.has(state.role)))
    return `${at}: role ${JSON.stringify(state.role)} is not in roles`;
  if (state.kind === undefined && state.roleBinding !== undefined &&
      (typeof state.roleBinding !== 'string' || state.roleBinding.length > 128 || !ROLE_BINDING_PATTERN.test(state.roleBinding)))
    return `${at}: roleBinding must look like live:parent.field`;
  return transitionError(state, at, states);
}

function transitionError(state: Record<string, unknown>, at: string, states: object): string | null {
  const isGate = state.kind === 'gate', isServer = state.kind === 'server';
  if (!isIdentifierArray(state.requires, WORKFLOW_REQUIRES_MAX, FIELD_NAME_PATTERN))
    return `${at}: requires must be a list of up to ${WORKFLOW_REQUIRES_MAX} unique field names`;
  if (!record(state.on)) return `${at}: on must be an object of outcome -> state`;
  const outcomes = Object.entries(state.on);
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
  const on = state.on as Record<string, string>;
  if (!isServer && state.timeoutSeconds !== undefined && !timeoutInRange(state.timeoutSeconds))
    return `${at}: timeoutSeconds must be a whole number from ${WORKFLOW_TIMEOUT_SECONDS_MIN} to ${WORKFLOW_TIMEOUT_SECONDS_MAX}`;
  if (isGate) {
    if ((state.timeoutSeconds === undefined) !== (state.default === undefined))
      return `${at}: a gate declares timeoutSeconds and default together, or neither`;
    if (state.default !== undefined && (typeof state.default !== 'string' || !Object.hasOwn(on, state.default)))
      return `${at}: default ${JSON.stringify(state.default)} is not an outcome in on`;
  } else if (!isServer && state.timeoutSeconds !== undefined && !Object.hasOwn(on, 'timeout'))
    return `${at}: timeoutSeconds needs a "timeout" outcome in on`;
  if (!isGate && state.loop !== undefined) {
    const loop = state.loop;
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
  }
  return null;
}

/** Keep field-specific diagnostics even when a new save cannot use the field. */
function cornerEdgeError(field: 'implicitEdges' | 'externalOutcomes', value: unknown, states: Record<string, unknown>): string | null {
  if (value === undefined) return null;
  if (field === 'externalOutcomes') {
    if (!isIdentifierArray(value, WORKFLOW_OUTCOMES_MAX, IDENTIFIER_PATTERN))
      return `externalOutcomes must be up to ${WORKFLOW_OUTCOMES_MAX} unique outcome names`;
    const declared = new Set(Object.values(states).flatMap((state) => record(state) && record(state.on) ? Object.keys(state.on) : []));
    for (const outcome of value)
      if (!declared.has(outcome)) return `externalOutcomes: "${outcome}" is not an outcome of any state`;
  } else {
    if (!isIdentifierArray(value, WORKFLOW_STATES_MAX, IDENTIFIER_PATTERN))
      return 'implicitEdges must be a list of unique state names';
    const notTerminal = value.find((name) => !Object.hasOwn(states, name) || !record(states[name]) || states[name].kind !== 'terminal');
    if (notTerminal !== undefined) return `implicitEdges: "${notTerminal}" is not a terminal state`;
  }
  return null;
}

function workflowGraphError(contract: WorkflowReadContract): string | null {
  const states = contract.handoffs;
  const external = new Set(contract.externalOutcomes ?? []);
  const targets = (name: string, excluded: ReadonlySet<string> = new Set()): string[] => {
    const state = states[name]!;
    if (!('on' in state)) return [];
    const next = Object.entries(state.on).filter(([outcome]) => !excluded.has(outcome)).map(([, target]) => target);
    if ('loop' in state && state.loop) next.push(state.loop.onExceeded);
    return next;
  };
  const externalError = cornerEdgeError('externalOutcomes', contract.externalOutcomes, states);
  if (externalError) return externalError;
  if (!Object.values(states).some((state) => state.kind === 'terminal')) return 'at least one terminal state is required';
  if (states[contract.start]!.kind === 'terminal')
    return `start state "${contract.start}" must not be a terminal`;
  const implicitError = cornerEdgeError('implicitEdges', contract.implicitEdges, states);
  if (implicitError) return implicitError;
  // Implicit terminals are reachable from every state.
  const reachable = new Set<string>();
  const visitReachable = (name: string): void => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const next of targets(name)) visitReachable(next);
  };
  visitReachable(contract.start);
  for (const name of (contract.implicitEdges as string[] | undefined) ?? []) reachable.add(name);
  const orphan = Object.keys(states).find((name) => !reachable.has(name));
  if (orphan !== undefined) return `state "${orphan}" is not reachable from start`;
  if (reachable.size !== Object.keys(states).length) return 'implicitEdges must be a list of unique state names';
  // Gates, capped edges and external outcomes cannot create automatic loops.
  const visited = new Set<string>();
  /** The current DFS path, so an uncapped cycle can be named. */
  const active: string[] = [];
  let cycle: string[] = [];
  const walk = (name: string): boolean => {
    if (visited.has(name)) return true;
    const state = states[name]!;
    if (state.kind === 'gate') {
      visited.add(name);
      return true;
    }
    active.push(name);
    const loop = 'loop' in state ? state.loop : undefined;
    const loopTarget = loop && 'on' in state ? state.on[loop.onEdge] : undefined;
    for (const next of targets(name, external)) {
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
  if (!walk(contract.start)) return `cycle ${cycle.join(' -> ')} has no loop cap`;
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
  readonly contract: WorkflowReadContract;
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
