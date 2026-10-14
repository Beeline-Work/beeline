import type { VoiceAgent } from './voice-providers.js';

const words = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const spelling = (text: string) => text.replace(/ie$/, 'y');

function closeSpelling(left: string, right: string): boolean {
  left = spelling(left); right = spelling(right);
  if (left === right) return true;
  // Short names are too easy to confuse with ordinary words.
  if (Math.min(left.length, right.length) < 4 || Math.abs(left.length - right.length) > 1) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) row[j] = Math.min(row[j - 1]! + 1, previous[j]! + 1,
      previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[right.length] === 1;
}

/** Only an opening name, optionally after a greeting, changes the voice target. */
export function namedVoiceTarget(text: string, agents: readonly VoiceAgent[], selected?: string, humans = 1): VoiceAgent | undefined {
  const transcript = words(text);
  if (/^(hey|hi|hello|okay|ok|yo)$/.test(transcript[0] ?? '')) transcript.shift();
  const aliases = agents.flatMap(agent => [agent.name, agent.handle].map(name => ({ agent, parts: words(name) })))
    .filter(alias => alias.parts.length > 0);
  const exact = aliases.filter(({ parts }) => parts.every((part, i) => part === transcript[i]));
  // Prefer a full display name over another member's shorter alias.
  const longest = Math.max(0, ...exact.map(alias => alias.parts.length));
  const matches = longest ? exact.filter(alias => alias.parts.length === longest)
    : aliases.filter(({ parts }) => parts.length === 1 && closeSpelling(parts[0]!, transcript[0] ?? ''));
  const unique = new Map(matches.map(({ agent }) => [agent.id, agent]));
  if (unique.size === 1) return [...unique.values()][0];
  return humans === 1 ? agents.find(agent => agent.id === selected) ?? agents[0] : undefined;
}
