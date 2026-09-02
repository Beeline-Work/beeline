export interface AgentModelConfigOption {
  id: string;
  category: string;
  currentValue?: string;
  options: Array<{ id: string; name?: string }>;
}

const ALLOWED = new Set(['model', 'thought_level', 'effort', 'reasoning_effort']);

export function isAllowedAgentModelConfigCategory(category: string): boolean {
  return ALLOWED.has(category);
}
