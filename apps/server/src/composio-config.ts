import { validateComposioScope, type ComposioScope } from '@beeline/api-contract/composio';

/** Server-owned allowlist. The project key never reaches agents or helpers. */
export function composioScopeForOwner(ownerId: string): ComposioScope | undefined {
  if (!process.env.BEELINE_COMPOSIO_API_KEY) return undefined;
  const raw = process.env.BEELINE_COMPOSIO_SCOPE;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { toolkits?: unknown; tools?: unknown };
    if (!Array.isArray(parsed.toolkits) || !parsed.tools || typeof parsed.tools !== 'object' ||
        Array.isArray(parsed.tools)) return undefined;
    const scope: ComposioScope = {
      ownerId,
      toolkits: parsed.toolkits as string[],
      tools: parsed.tools as Record<string, string[]>,
    };
    validateComposioScope(scope);
    return scope;
  } catch {
    return undefined;
  }
}

export function storedComposioScope(value: unknown, ownerId: string): ComposioScope {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Composio connector scope is unavailable');
  const scope = value as ComposioScope;
  if (scope.ownerId !== ownerId) throw new Error('Composio connector scope owner changed');
  validateComposioScope(scope);
  return scope;
}

export function approvedComposioTools(value: unknown, ownerId: string): readonly string[] {
  try {
    return Object.values(storedComposioScope(value, ownerId).tools).flat();
  } catch {
    return [];
  }
}
