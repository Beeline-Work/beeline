/** Declarative, bounded workflow definitions. No user supplied code executes here. */
import { isAgentKind, isServerEventKind } from './system-events.js';
export type WorkflowValueType = 'string' | 'number' | 'boolean' | 'object' | 'array';
export type WorkflowOutputField = WorkflowValueType | { type: 'string'; enum: string[] };
export type WorkflowStep = {
  role: string;
  skill: string;
  input?: Record<string, string>;
  effects?: ('merge' | 'order' | 'external-write')[];
  output: Record<string, WorkflowOutputField>;
  timeoutSeconds: number;
  retries: number;
};
export type WorkflowState =
  | {
      kind: 'step';
      step: WorkflowStep;
      on: Record<string, string>;
      guard?: { field: string };
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
  | {
      kind: 'wait';
      event: string;
      match?: Record<string, string>;
      timeoutSeconds: number;
      on: Record<string, string>;
      loop?: { to: string; maxIterations: number; onExceeded: string };
    }
  | { kind: 'gate'; human: string; timeoutSeconds: number; on: Record<string, string> }
  | { kind: 'terminal' };
export type WorkflowDefinition = {
  version: 1;
  name: string;
  purpose?: string;
  success?: string[];
  roles: string[];
  trigger: { kind: 'manual' | 'event' | 'schedule'; value?: string };
  start: string;
  states: Record<string, WorkflowState>;
};

const slug = /^[a-z][a-z0-9_-]{0,63}$/;
const eventName = /^[a-z][a-z0-9_.:-]{0,79}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown, maximum: number) =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= maximum;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

function validStep(value: unknown, roles: Set<string>): value is WorkflowStep {
  if (!record(value) || !keys(value, ['role', 'skill', 'input', 'effects', 'output', 'timeoutSeconds', 'retries']))
    return false;
  if (value.effects !== undefined && (!Array.isArray(value.effects) ||
    !value.effects.every((effect) => ['merge', 'order', 'external-write'].includes(effect))))
    return false;
  if (value.input !== undefined &&
    (!record(value.input) || Object.keys(value.input).length > 32 ||
      !Object.entries(value.input).every(([key, source]) => slug.test(key) &&
        typeof source === 'string' && /^\$\.[a-z][a-z0-9_-]{0,63}$/.test(source))))
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
  return Object.entries(value.output).every(([key, rule]) => {
    if (!slug.test(key)) return false;
    if (typeof rule === 'string')
      return ['string', 'number', 'boolean', 'object', 'array'].includes(rule);
    return (
      record(rule) &&
      keys(rule, ['type', 'enum']) &&
      rule.type === 'string' &&
      Array.isArray(rule.enum) &&
      rule.enum.length > 0 &&
      rule.enum.length <= 16 &&
      rule.enum.every((choice) => typeof choice === 'string' && slug.test(choice)) &&
      new Set(rule.enum).size === rule.enum.length
    );
  });
}

/** Reject malformed, unbounded, and unreachable definitions before storage. */
export function readWorkflowDefinition(value: unknown): WorkflowDefinition | null {
  if (
    !record(value) ||
    !keys(value, ['version', 'name', 'purpose', 'success', 'roles', 'trigger', 'start', 'states']) ||
    value.version !== 1
  )
    return null;
  if (
    typeof value.name !== 'string' ||
    !slug.test(value.name) ||
    (value.purpose !== undefined &&
      (typeof value.purpose !== 'string' || value.purpose.length > 160)) ||
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
    !Object.hasOwn(value.states, value.start)
  )
    return null;
  const states = value.states;
  if (value.success !== undefined &&
    (!Array.isArray(value.success) || value.success.length === 0 ||
      !value.success.every((name) => typeof name === 'string' &&
        Object.hasOwn(states, name) && record(states[name]) && states[name].kind === 'terminal')))
    return null;
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
        ([outcome, target]) =>
          slug.test(outcome) && typeof target === 'string' && Object.hasOwn(states, target),
      )
    )
      return null;
    const targets = Object.values(raw.on) as string[];
    if (raw.kind === 'step') {
      if (
        !keys(raw, ['kind', 'step', 'on', 'guard', 'loop']) ||
        !validStep(raw.step, roles) ||
        (raw.guard === undefined && !('success' in raw.on)) ||
        !('failure' in raw.on) ||
        !('timeout' in raw.on)
      )
        return null;
      if (raw.guard !== undefined) {
        if (
          !record(raw.guard) ||
          !keys(raw.guard, ['field']) ||
          typeof raw.guard.field !== 'string' ||
          !record(raw.step)
        )
          return null;
        const output = raw.step.output as Record<string, WorkflowOutputField>;
        const rule = output[raw.guard.field];
        const outcomes = raw.on;
        if (
          !record(rule) ||
          rule.type !== 'string' ||
          !Array.isArray(rule.enum) ||
          !rule.enum.every((choice) => typeof choice === 'string' && choice in outcomes)
        )
          return null;
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
        !keys(raw, ['kind', 'event', 'match', 'timeoutSeconds', 'on', 'loop']) ||
        typeof raw.event !== 'string' ||
        !eventName.test(raw.event) ||
        !positive(raw.timeoutSeconds, 604_800) ||
        !('success' in raw.on) ||
        !('timeout' in raw.on)
      )
        return null;
      if (
        raw.match !== undefined &&
        (!record(raw.match) ||
          Object.keys(raw.match).length > 16 ||
          !Object.entries(raw.match).every(
            ([key, expected]) =>
              slug.test(key) && typeof expected === 'string' && expected.length <= 160,
          ))
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
    if ((raw.kind === 'step' || raw.kind === 'wait') && raw.loop !== undefined) {
      if (
        !record(raw.loop) ||
        !keys(raw.loop, ['to', 'maxIterations', 'onExceeded']) ||
        typeof raw.loop.to !== 'string' ||
        !Object.hasOwn(states, raw.loop.to) ||
        !positive(raw.loop.maxIterations, 100) ||
        typeof raw.loop.onExceeded !== 'string' ||
        !Object.hasOwn(states, raw.loop.onExceeded) ||
        raw.loop.onExceeded === raw.loop.to ||
        !Object.values(raw.on).includes(raw.loop.to)
      ) return null;
      targets.push(raw.loop.onExceeded);
    }
    edges.set(name, targets);
  }
  if (terminalCount < 1 || (states[value.start] as WorkflowState).kind === 'terminal') return null;
  const reachable = new Set<string>();
  const visit = (name: string): void => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const next of edges.get(name) ?? []) visit(next);
  };
  visit(value.start);
  if (reachable.size !== Object.keys(states).length) return null;
  const visited = new Set<string>();
  const active = new Set<string>();
  const walk = (name: string): boolean => {
    if (active.has(name)) return false;
    if (visited.has(name)) return true;
    active.add(name);
    for (const next of edges.get(name) ?? []) {
      const state = states[name] as WorkflowState;
      // Capped edges are removed before cycle detection, independent of key order.
      if ((state.kind === 'step' || state.kind === 'wait') && state.loop?.to === next) continue;
      if (active.has(next) || !walk(next)) return false;
    }
    active.delete(name);
    visited.add(name);
    return true;
  };
  if (!walk(value.start)) return null;
  return value as WorkflowDefinition;
}

export function workflowOutputError(step: WorkflowStep, output: unknown): string | null {
  if (!record(output)) return 'output must be an object';
  if (JSON.stringify(output).length > 16_384) return 'output exceeds 16 KB';
  for (const [key, rule] of Object.entries(step.output)) {
    const item = output[key];
    const type = typeof rule === 'string' ? rule : rule.type;
    const valid =
      type === 'array'
        ? Array.isArray(item)
        : type === 'object'
          ? record(item)
          : typeof item === type;
    if (!valid) return `${key} must be ${type}`;
    if (typeof rule === 'object' && !rule.enum.includes(String(item)))
      return `${key} must be one of ${rule.enum.join(', ')}`;
  }
  return null;
}

export type WorkflowCheckError = {
  rule: string;
  state: string;
  path: string;
  message: string;
};
export type WorkflowCheckResult = {
  ok: boolean;
  errors: WorkflowCheckError[];
  bounds: { durationMs: number; agentTurns: number };
  nonSuccessRoutes: { terminal: string; path: string[] }[];
};

/** Check the same definition used by storage and execution. Duration excludes queue delay. */
export function checkWorkflowDefinition(value: unknown, options?: {
  knownSkills?: ReadonlySet<string>;
}): WorkflowCheckResult {
  const errors: WorkflowCheckError[] = [];
  const add = (rule: string, state: string, path: string, message: string) => {
    if (!errors.some((item) => item.rule === rule && item.path === path && item.message === message))
      errors.push({ rule, state, path, message });
  };
  const invalid = (): WorkflowCheckResult => ({
    ok: false, errors, bounds: { durationMs: 0, agentTurns: 0 }, nonSuccessRoutes: [],
  });
  if (!record(value) || !record(value.states)) {
    add('structure', '', '$', 'workflow must have states');
    return invalid();
  }
  const states = value.states;
  for (const [name, raw] of Object.entries(states)) {
    if (!record(raw)) continue;
    const steps = raw.kind === 'step' ? [raw.step] : raw.kind === 'parallel' ? raw.steps : [];
    if (Array.isArray(steps) && options?.knownSkills) {
      for (const [index, step] of steps.entries()) {
        if (record(step) && typeof step.skill === 'string' &&
          !options.knownSkills.has(step.skill))
          add('skill', name, raw.kind === 'step' ? `$.states.${name}.step.skill` :
            `$.states.${name}.steps.${index}.skill`, `unknown workspace skill ${step.skill}`);
      }
    }
    if (raw.kind === 'wait' &&
      !(isServerEventKind(raw.event) || isAgentKind(raw.event) || raw.event === 'check-completed'))
      add('event', name, `$.states.${name}.event`, `unknown event ${String(raw.event)}`);
    if (raw.kind === 'step' && record(raw.step) && record(raw.step.output) && record(raw.guard)) {
      const field = raw.guard.field;
      const contract = typeof field === 'string' ? raw.step.output[field] : undefined;
      if (!record(contract) || !Array.isArray(contract.enum))
        add('guard-field', name, `$.states.${name}.guard.field`, 'guard requires an enum output');
      else if (record(raw.on)) {
        const possible = new Set(contract.enum);
        for (const option of contract.enum) {
          if (typeof option === 'string' && typeof raw.on[option] !== 'string')
            add('guard-route', name, `$.states.${name}.on`, `no route for ${option}`);
        }
        for (const option of Object.keys(raw.on)) {
          if (!possible.has(option) && option !== 'failure' && option !== 'timeout')
            add('guard-unreachable', name, `$.states.${name}.on.${option}`, `unreachable route ${option}`);
        }
      }
    }
  }
  if (!Array.isArray(value.success) || !value.success.length) {
    add('success', '', '$.success', 'declare at least one successful terminal state');
  }
  const definition = readWorkflowDefinition(value);
  if (!definition) {
    if (!errors.some((item) => item.rule === 'structure'))
      add('structure', '', '$', 'workflow has an invalid or unbounded graph');
    return invalid();
  }
  const successes = new Set(definition.success ?? []);
  const failures: { terminal: string; path: string[] }[] = [];
  let reachesSuccess = false;
  let durationMs = 0;
  let agentTurns = 0;
  let explored = 0;
  const visit = (
    name: string,
    fields: Set<string>,
    loops: Record<string, number>,
    duration: number,
    turns: number,
    path: string[],
  ): void => {
    const state = definition.states[name]!;
    if (++explored > 50_000) {
      add('analysis-limit', name, '$.states', 'workflow has more than 50,000 bounded route visits');
      return;
    }
    if (state.kind === 'terminal') {
      durationMs = Math.max(durationMs, duration);
      agentTurns = Math.max(agentTurns, turns);
      if (successes.has(name)) reachesSuccess = true;
      else failures.push({ terminal: name, path });
      return;
    }
    const references = state.kind === 'wait'
      ? Object.entries(state.match ?? {}).map(([key, source]) => [key, source, `$.states.${name}.match.${key}`])
      : state.kind === 'step'
        ? Object.entries(state.step.input ?? {}).map(([key, source]) => [key, source, `$.states.${name}.step.input.${key}`])
        : state.kind === 'parallel'
          ? state.steps.flatMap((step, index) => Object.entries(step.input ?? {})
            .map(([key, source]) => [key, source, `$.states.${name}.steps.${index}.input.${key}`]))
          : [];
    for (const [, source, sourcePath] of references) {
      if (source?.startsWith('$.') && !fields.has(source.slice(2)))
        add('field-flow', name, sourcePath!, `${source} is not available on every incoming path`);
    }
    const nextFields = new Set(fields);
    if (state.kind === 'step') {
      for (const key of Object.keys(state.step.output)) nextFields.add(key);
    } else if (state.kind === 'parallel') {
      for (const step of state.steps) for (const key of Object.keys(step.output)) nextFields.add(key);
    }
    const cost = state.kind === 'step'
      ? { duration: state.step.timeoutSeconds * (state.step.retries + 1) * 1000,
          turns: state.step.retries + 1 }
      : state.kind === 'parallel'
        ? { duration: state.deadlineSeconds * 1000,
            turns: state.steps.reduce((sum, step) => sum + step.retries + 1, 0) }
        : { duration: state.timeoutSeconds * 1000, turns: 0 };
    for (const [outcome, target] of Object.entries(state.on)) {
      const isSuccessOutput = state.kind === 'step'
        ? outcome !== 'failure' && outcome !== 'timeout'
        : state.kind === 'parallel' ? outcome === 'success' : false;
      const available = isSuccessOutput ? nextFields : fields;
      let destination = target;
      let nextLoops = loops;
      if ((state.kind === 'step' || state.kind === 'wait') && state.loop?.to === target) {
        nextLoops = { ...loops, [name]: (loops[name] ?? 0) + 1 };
        if (nextLoops[name]! > state.loop.maxIterations) destination = state.loop.onExceeded;
      }
      visit(destination, available, nextLoops, duration + cost.duration,
        turns + cost.turns, [...path, `${name}:${outcome}`, destination]);
    }
  };
  visit(definition.start, new Set(), {}, 0, 0, [definition.start]);
  if (!reachesSuccess) add('success-unreachable', '', '$.success', 'no route reaches a declared success state');
  return { ok: errors.length === 0, errors, bounds: { durationMs, agentTurns },
    nonSuccessRoutes: failures };
}
