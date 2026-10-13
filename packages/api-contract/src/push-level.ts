/** Per-person push delivery policy, evaluated by the server before FCM. */
export type PushLevel = 'off' | 'attention' | 'full';

export const PUSH_LEVELS = ['off', 'attention', 'full'] as const satisfies readonly PushLevel[];
export const ATTENTION_PUSH_LEVEL: PushLevel = 'attention';

export function isPushLevel(value: unknown): value is PushLevel {
  return (PUSH_LEVELS as readonly unknown[]).includes(value);
}
