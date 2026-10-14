import type { VoiceAgent } from './voice-providers.js';

const words = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const VOWEL_SOUND: [RegExp, string][] = [[/^(oo|ou|u)/, 'U'], [/^o/, 'O'], [/^a/, 'A'], [/^[ei]/, 'I']];
const ENDING_SOUND: [RegExp, string][] = [[/(ey|ie|ee|ea|y|i)$/, 'Y'], [/(ow|oh|o)$/, 'O'], [/(ah|a)$/, 'A']];

/** How a name sounds: its first vowel, consonant skeleton and sounded ending.
 * Speech-to-text spells one spoken name many ways: Gussie, Goosey and Goosy all become "Ugs-Y". */
export function nameSound(word: string): string {
  let text = word.toLowerCase().replace(/[^a-z]/g, '');
  const [ending, endingSound] = ENDING_SOUND.find(([pattern]) => pattern.test(text)) ?? [undefined, ''];
  if (ending) text = text.replace(ending, '');
  text = text.replace(/ph/g, 'f').replace(/ck|[cq]/g, 'k').replace(/z/g, 's').replace(/x/g, 'ks');
  const vowel = text.slice(text.search(/[aeiou]/));
  const vowelSound = /[aeiou]/.test(text) ? VOWEL_SOUND.find(([pattern]) => pattern.test(vowel))?.[1] ?? '' : '';
  const skeleton = text.replace(/[aeiouyhw]/g, '').replace(/(.)\1+/g, '$1');
  return `${vowelSound}${skeleton}-${endingSound}`;
}

function closeSpelling(left: string, right: string): boolean {
  if (left === right) return true;
  // Short names are too easy to confuse with ordinary words.
  if (Math.min(left.length, right.length) < 4) return false;
  if (nameSound(left) === nameSound(right)) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) row[j] = Math.min(row[j - 1]! + 1, previous[j]! + 1,
      previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[right.length] === 1;
}

/** The agent named at the start of the speech, optionally after a greeting. Ambiguous names match nobody. */
export function openingVoiceName(text: string, agents: readonly VoiceAgent[]): VoiceAgent | undefined {
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
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

/** Only an opening name changes the voice target. One human keeps the selected agent. */
export function namedVoiceTarget(text: string, agents: readonly VoiceAgent[], selected?: string, humans = 1): VoiceAgent | undefined {
  return openingVoiceName(text, agents) ??
    (humans === 1 ? agents.find(agent => agent.id === selected) ?? agents[0] : undefined);
}
