/** Per-person push delivery policy, evaluated by the server before FCM. */
export type PushLevel = 'off' | 'default' | 'full';

export const PUSH_LEVELS = ['off', 'default', 'full'] as const satisfies readonly PushLevel[];
export const DEFAULT_PUSH_LEVEL: PushLevel = 'default';

export function isPushLevel(value: unknown): value is PushLevel {
  return (PUSH_LEVELS as readonly unknown[]).includes(value);
}
