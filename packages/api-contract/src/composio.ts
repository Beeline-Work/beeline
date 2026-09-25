/** The server-approved Composio catalog visible to one helper. */
export type ComposioScope = {
  readonly ownerId: string;
  readonly toolkits: readonly string[];
  readonly tools: Readonly<Record<string, readonly string[]>>;
};

const toolkitSlug = /^[a-z][a-z0-9_]*$/;
const toolSlug = /^[A-Z][A-Z0-9_]*$/;

export function validateComposioScope(scope: ComposioScope): void {
  if (!scope.ownerId || scope.ownerId.length > 256 || !scope.toolkits.length)
    throw new Error('Composio owner and toolkits are required');
  if (scope.toolkits.length > 16 || new Set(scope.toolkits).size !== scope.toolkits.length)
    throw new Error('invalid Composio toolkit scope');
  if (Object.values(scope.tools).flat().length > 16)
    throw new Error('Composio tool scope is too large');
  for (const toolkit of scope.toolkits) {
    if (!toolkitSlug.test(toolkit)) throw new Error('invalid Composio toolkit scope');
    const tools = scope.tools[toolkit];
    if (!Array.isArray(tools) || !tools.length || tools.length > 64 ||
        new Set(tools).size !== tools.length ||
        tools.some((tool) => tool.length > 128 || !toolSlug.test(tool) ||
          !tool.startsWith(`${toolkit.toUpperCase()}_`)))
      throw new Error('invalid Composio tool scope');
  }
  if (Object.keys(scope.tools).some((toolkit) => !scope.toolkits.includes(toolkit)))
    throw new Error('invalid Composio tool scope');
}
