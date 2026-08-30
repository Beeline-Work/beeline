import { ModelSelectionUnavailableError } from './model-config.js';

export interface ModelUnavailableState {
  kind: 'model-unavailable' | 'validation-unavailable';
  selection: { model?: string; effort?: string };
  unavailable: { label: 'model' | 'effort' | 'selection'; value: string };
  detail: string;
  recovery: string;
}

const SECRET_VALUE = /(?:token|key|secret|password)=?[^\s,;]*/gi;

function safeGuidance(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(SECRET_VALUE, 'credential=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function safeIdentifier(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Convert startup validation failures into the bounded, Room-safe state. */
export function modelUnavailableState(
  selection: { model?: string; effort?: string },
  error: unknown,
): ModelUnavailableState {
  const safeSelection = {
    ...(selection.model ? { model: safeIdentifier(selection.model) } : {}),
    ...(selection.effort ? { effort: safeIdentifier(selection.effort) } : {}),
  };
  const selected = safeSelection.model ?? safeSelection.effort ?? '(unset)';
  const typed = error instanceof ModelSelectionUnavailableError;
  const unavailable = typed
    ? { label: error.label, value: safeIdentifier(error.value) }
    : { label: 'selection' as const, value: selected };
  return {
    kind: typed ? 'model-unavailable' : 'validation-unavailable',
    selection: safeSelection,
    unavailable,
    detail: typed
      ? safeGuidance(error.message)
      : `The live harness catalog could not verify "${selected}".`,
    recovery: typed
      ? 'Open this agent’s settings, choose a value from the live model catalog, then restart the agent.'
      : 'Restore access to the selected harness and its live catalog, then restart the agent.',
  };
}

/** Grok Mono Hull system-line copy: terse state, mono-friendly id, direct recovery. */
export function modelUnavailableRoomMessage(state: ModelUnavailableState): string {
  const title =
    state.kind === 'model-unavailable' ? 'Model unavailable' : 'Model validation unavailable';
  return `${title} · ${state.unavailable.value}\n${state.detail}\n${state.recovery}`;
}

/** Typed tags that keep the durable conversation line machine-inspectable. */
export function modelUnavailableEventTags(state: ModelUnavailableState): string[][] {
  return [
    ['t', 'buzz-agent-model-unavailable'],
    ['status', state.kind],
    ['unavailable', state.unavailable.label],
    ['unavailable-value', state.unavailable.value],
    ...(state.selection.model ? [['model', state.selection.model]] : []),
    ...(state.selection.effort ? [['effort', state.selection.effort]] : []),
  ];
}

/** Typed resolution marker for a previously published model-unavailable Room state. */
export function modelAvailableEventTags(selection: {
  model?: string;
  effort?: string;
}): string[][] {
  const model = selection.model ? safeIdentifier(selection.model) : undefined;
  const effort = selection.effort ? safeIdentifier(selection.effort) : undefined;
  return [
    ['t', 'buzz-agent-model-unavailable'],
    ['status', 'model-available'],
    ...(model ? [['model', model]] : []),
    ...(effort ? [['effort', effort]] : []),
  ];
}
