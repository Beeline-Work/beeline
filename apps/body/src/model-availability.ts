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

/** Bounded local diagnostic for logs and rejected ACP activation errors. */
export function modelUnavailableDiagnostic(state: ModelUnavailableState): string {
  const title =
    state.kind === 'model-unavailable' ? 'Model unavailable' : 'Model validation unavailable';
  return `${title} · ${state.unavailable.value}\n${state.detail}\n${state.recovery}`;
}
