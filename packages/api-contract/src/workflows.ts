/** Declarative, bounded workflow definitions. No user supplied code executes here. */
export type WorkflowValueType = 'string' | 'number' | 'boolean' | 'object' | 'array';
export type WorkflowStep = {
  role: string;
  skill: string;
  output: Record<string, WorkflowValueType>;
  timeoutSeconds: number;
  retries: number;
};
export type WorkflowState =
  | {
      kind: 'step';
      step: WorkflowStep;
      on: Record<string, string>;
      loop?: { to: string; maxIterations: number; onExceeded: string };
    }
  | {
      kind: 'parallel';
      steps: WorkflowStep[];
      join: 'all' | 'any' | 'quorum';
      quorum?: number;
      deadlineSeconds: number;
      on: Record<string, string>;
    }
  | { kind: 'wait'; event: string; timeoutSeconds: number; on: Record<string, string> }
  | { kind: 'gate'; human: string; timeoutSeconds: number; on: Record<string, string> }
  | { kind: 'terminal' };
export type WorkflowDefinition = {
  version: 1;
  name: string;
  roles: string[];
  trigger: { kind: 'manual' | 'event' | 'schedule'; value?: string };
  start: string;
  states: Record<string, WorkflowState>;
};

const slug = /^[a-z][a-z0-9_-]{0,63}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown, maximum: number) =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= maximum;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

function validStep(value: unknown, roles: Set<string>): value is WorkflowStep {
  if (!record(value) || !keys(value, ['role', 'skill', 'output', 'timeoutSeconds', 'retries']))
    return false;
  if (
    typeof value.role !== 'string' ||
    !roles.has(value.role) ||
    typeof value.skill !== 'string' ||
    !slug.test(value.skill)
  )
    return false;
  if (
    !record(value.output) ||
    Object.keys(value.output).length > 32 ||
    !positive(value.timeoutSeconds, 86_400)
  )
    return false;
  if (!Number.isInteger(value.retries) || Number(value.retries) < 0 || Number(value.retries) > 5)
    return false;
  return Object.entries(value.output).every(
    ([key, type]) =>
      slug.test(key) && ['string', 'number', 'boolean', 'object', 'array'].includes(String(type)),
  );
}

/** Reject malformed, unbounded, and unreachable definitions before storage. */
export function readWorkflowDefinition(value: unknown): WorkflowDefinition | null {
  if (
    !record(value) ||
    !keys(value, ['version', 'name', 'roles', 'trigger', 'start', 'states']) ||
    value.version !== 1
  )
    return null;
  if (
    typeof value.name !== 'string' ||
    !slug.test(value.name) ||
    !Array.isArray(value.roles) ||
    value.roles.length < 1 ||
    value.roles.length > 16
  )
    return null;
  if (
    !value.roles.every((role) => typeof role === 'string' && slug.test(role)) ||
    new Set(value.roles).size !== value.roles.length
  )
    return null;
  const roles = new Set<string>(value.roles);
  if (
    !record(value.trigger) ||
    !keys(value.trigger, ['kind', 'value']) ||
    !['manual', 'event', 'schedule'].includes(String(value.trigger.kind))
  )
    return null;
  if (
    value.trigger.kind !== 'manual' &&
    (typeof value.trigger.value !== 'string' ||
      value.trigger.value.length < 1 ||
      value.trigger.value.length > 160)
  )
    return null;
  if (value.trigger.kind === 'manual' && value.trigger.value !== undefined) return null;
  if (
    !record(value.states) ||
    Object.keys(value.states).length < 2 ||
    Object.keys(value.states).length > 64 ||
    typeof value.start !== 'string' ||
    !(value.start in value.states)
  )
    return null;
  const states = value.states;
  const edges = new Map<string, string[]>();
  let terminalCount = 0;
  for (const [name, raw] of Object.entries(states)) {
    if (!slug.test(name) || !record(raw)) return null;
    if (raw.kind === 'terminal') {
      if (!keys(raw, ['kind'])) return null;
      terminalCount++;
      edges.set(name, []);
      continue;
    }
    if (
      !record(raw.on) ||
      Object.keys(raw.on).length < 1 ||
      Object.keys(raw.on).length > 16 ||
      !Object.entries(raw.on).every(
        ([outcome, target]) => slug.test(outcome) && typeof target === 'string' && target in states,
      )
    )
      return null;
    const targets = Object.values(raw.on) as string[];
    if (raw.kind === 'step') {
      if (
        !keys(raw, ['kind', 'step', 'on', 'loop']) ||
        !validStep(raw.step, roles) ||
        !('success' in raw.on) ||
        !('failure' in raw.on) ||
        !('timeout' in raw.on)
      )
        return null;
      if (raw.loop !== undefined) {
        if (
          !record(raw.loop) ||
          !keys(raw.loop, ['to', 'maxIterations', 'onExceeded']) ||
          typeof raw.loop.to !== 'string' ||
          !(raw.loop.to in states) ||
          !positive(raw.loop.maxIterations, 100) ||
          typeof raw.loop.onExceeded !== 'string' ||
          !(raw.loop.onExceeded in states)
        )
          return null;
        targets.push(raw.loop.to, raw.loop.onExceeded);
      }
    } else if (raw.kind === 'parallel') {
      if (
        !keys(raw, ['kind', 'steps', 'join', 'quorum', 'deadlineSeconds', 'on']) ||
        !Array.isArray(raw.steps) ||
        raw.steps.length < 2 ||
        raw.steps.length > 16 ||
        !raw.steps.every((step) => validStep(step, roles)) ||
        !['all', 'any', 'quorum'].includes(String(raw.join)) ||
        !positive(raw.deadlineSeconds, 86_400) ||
        !('success' in raw.on) ||
        !('deadline' in raw.on)
      )
        return null;
      if (
        raw.join === 'quorum' ? !positive(raw.quorum, raw.steps.length) : raw.quorum !== undefined
      )
        return null;
    } else if (raw.kind === 'wait') {
      if (
        !keys(raw, ['kind', 'event', 'timeoutSeconds', 'on']) ||
        typeof raw.event !== 'string' ||
        !slug.test(raw.event) ||
        !positive(raw.timeoutSeconds, 604_800) ||
        !('success' in raw.on) ||
        !('timeout' in raw.on)
      )
        return null;
    } else if (raw.kind === 'gate') {
      if (
        !keys(raw, ['kind', 'human', 'timeoutSeconds', 'on']) ||
        typeof raw.human !== 'string' ||
        !slug.test(raw.human) ||
        !positive(raw.timeoutSeconds, 604_800) ||
        !('approved' in raw.on) ||
        !('denied' in raw.on) ||
        !('timeout' in raw.on)
      )
        return null;
    } else return null;
    edges.set(name, targets);
  }
  if (terminalCount < 1 || (states[value.start] as WorkflowState).kind === 'terminal') return null;
  const visited = new Set<string>();
  const active = new Set<string>();
  const walk = (name: string): boolean => {
    if (active.has(name)) return false;
    if (visited.has(name)) return true;
    active.add(name);
    for (const next of edges.get(name) ?? []) {
      // Every back-edge must carry its own explicit cap on the source state.
      const state = states[name] as WorkflowState;
      if (active.has(next) && !(state.kind === 'step' && state.loop?.to === next)) return false;
      if (!active.has(next) && !walk(next)) return false;
    }
    active.delete(name);
    visited.add(name);
    return true;
  };
  if (!walk(value.start) || visited.size !== Object.keys(states).length) return null;
  return value as WorkflowDefinition;
}

export function workflowOutputError(step: WorkflowStep, output: unknown): string | null {
  if (!record(output)) return 'output must be an object';
  for (const [key, type] of Object.entries(step.output)) {
    const item = output[key];
    const valid =
      type === 'array'
        ? Array.isArray(item)
        : type === 'object'
          ? record(item)
          : typeof item === type;
    if (!valid) return `${key} must be ${type}`;
  }
  return null;
}
