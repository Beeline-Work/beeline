/** Per-person push delivery policy, evaluated by the server before FCM. */
export type PushLevel = 'off' | 'direct' | 'mine' | 'all';

export const PUSH_LEVELS = ['off', 'direct', 'mine', 'all'] as const satisfies readonly PushLevel[];
export const DEFAULT_PUSH_LEVEL: PushLevel = 'mine';

export function isPushLevel(value: unknown): value is PushLevel {
  return (PUSH_LEVELS as readonly unknown[]).includes(value);
}
