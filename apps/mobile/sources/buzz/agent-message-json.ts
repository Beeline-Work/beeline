/**
 * Wrap a complete JSON object or array in a fenced block for agent narration.
 * The original bytes inside the outer whitespace are retained so indentation,
 * numeric spelling, key order, and duplicate keys are never changed by paint.
 */
export function agentMessageJsonMarkdown(text: string): string | null {
  const json = text.trim();
  const objectCandidate = json.startsWith('{') && json.endsWith('}');
  const arrayCandidate = json.startsWith('[') && json.endsWith(']');
  if (!objectCandidate && !arrayCandidate) return null;

  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') return null;
  } catch {
    return null;
  }

  return `\`\`\`json\n${json}\n\`\`\``;
}
