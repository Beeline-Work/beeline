export interface AgentModelConfigOption {
  id: string;
  category: string;
  currentValue?: string;
  /** `description` is the harness's note; for an alias (`default`) it names the model it runs. */
  options: Array<{ id: string; name?: string; description?: string }>;
}

const ALLOWED = new Set(['model', 'thought_level', 'effort', 'reasoning_effort']);

export function isAllowedAgentModelConfigCategory(category: string, id?: string): boolean {
  return ALLOWED.has(category) || (category === 'model_config' && id === 'fast-mode');
}
