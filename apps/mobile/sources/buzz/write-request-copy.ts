function firstFileName(value: string): string | undefined {
  return value.match(/\b[\w.-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|html|py|go|rs|java)\b/i)?.[0];
}

/**
 * Converts the agent's requested implementation detail into the concise
 * operator-facing explanation shown before a person opens an edit corner.
 */
export function describeWriteRequest(tool: string): string {
  const request = tool.trim();
  if (!request) return 'The agent needs to change repository files.';

  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|add)\b/i.test(request)) {
    return /--ignore-scripts/i.test(request)
      ? 'The agent wants to install project dependencies without running setup scripts.'
      : 'The agent wants to install project dependencies.';
  }

  if (/\b(?:str_replace|write|patch|edit|replace|create)\b/i.test(request)) {
    const file = firstFileName(request);
    return file ? `The agent wants to update ${file}.` : 'The agent wants to update repository files.';
  }

  if (/\b(?:rm|remove|delete)\b/i.test(request)) {
    const file = firstFileName(request);
    return file ? `The agent wants to remove ${file}.` : 'The agent wants to remove repository files.';
  }

  return 'The agent needs to make a repository change.';
}
