/** Shared tool search and tune-only frequency evidence for the subscription replay. */
export const FIND_TOOLS = { name: 'find_tools', description: 'Load full tool definitions by exact names or a plain-language query. Wait for results before calling loaded tools.',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false } };
const definition = t => ({ name: t.name, description: t.description, input_schema: t.inputSchema });
const words = text => text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
export function deniesAvailableTool(text, tools) {
  return text.split(/[.!?\n]/).some(sentence => {
    if (/\b(?:permission|approval|authorized|hold|policy|forbidden)\b/i.test(sentence)) return false;
    const tokens = words(sentence);
    const denial = /(?:\btool\b.{0,40}(?:unavailable|not available)|(?:do not have|don't have|cannot access|can't access|lack).{0,60}\btools?\b|(?:no|without) (?:available |callable )?(?:[a-z_]+ )?tools?\b)/i.test(sentence);
    return denial && /\btools?\b/i.test(sentence) &&
      (tools.some(t => tokens.includes(t.name.toLowerCase())) || /(?:no|without|lack of) (?:available |callable )?tools\b/i.test(sentence));
  });
}
export function findTools(tools, query) {
  const terms = words(query).filter(w => !['a', 'an', 'the', 'to', 'for', 'tool', 'tools', 'i', 'need', 'and', 'with'].includes(w));
  const exact = tools.filter(t => terms.includes(t.name.toLowerCase()));
  if (exact.length) return exact.map(definition);
  const ranked = tools.map(t => ({ t, score: terms.filter(w => words(`${t.name.replaceAll('_', ' ')} ${t.description}`).includes(w)).length }))
    .filter(t => t.score).sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  return ranked.slice(0, 5).map(({ t }) => definition(t));
}
