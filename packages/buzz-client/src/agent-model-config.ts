/**
 * The only `configOptions` categories a picker may ever read or write.
 * `mode` / `collaboration_mode` (or any other permission axis) must never
 * appear here. Only the exact `fast-mode` id is admitted from `model_config`.
 */
export const ALLOWED_AGENT_MODEL_CONFIG_CATEGORIES = [
  'model',
  'thought_level',
  'effort',
  'reasoning_effort',
] as const;

export function isAllowedAgentModelConfigCategory(category: string, id?: string): boolean {
  return (
    (ALLOWED_AGENT_MODEL_CONFIG_CATEGORIES as readonly string[]).includes(category) ||
    (category === 'model_config' && id === 'fast-mode')
  );
}
