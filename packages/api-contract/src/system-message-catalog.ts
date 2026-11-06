import { SYSTEM_MESSAGE_AWAY_AUTO_PAUSE } from './system-message-catalog-away-auto-pause.js';
import { SYSTEM_MESSAGE_DAEMON_SERVICE } from './system-message-catalog-daemon-service.js';
import { SYSTEM_MESSAGE_VOICE_SERVICE } from './system-message-catalog-voice-service.js';
import { SYSTEM_MESSAGE_TURN_SILENCE } from './system-message-catalog-turn-silence.js';

/** Owner-approved System wording. Writers supply data to these templates by key.
 * Wording changes and new keys require the owner's approval; code refactors do not.
 * variables describe the ordered slots; parts preserve every byte around them.
 */
export const SYSTEM_MESSAGE_CATALOG = {
  ...SYSTEM_MESSAGE_AWAY_AUTO_PAUSE,
  ...SYSTEM_MESSAGE_DAEMON_SERVICE,
  ...SYSTEM_MESSAGE_VOICE_SERVICE,
  ...SYSTEM_MESSAGE_TURN_SILENCE,
} as const;

export type SystemMessageKey = keyof typeof SYSTEM_MESSAGE_CATALOG;
type Catalog = typeof SYSTEM_MESSAGE_CATALOG;
type SlotValues<T extends readonly string[]> = { [I in keyof T]: unknown };
type Inputs<K extends SystemMessageKey> = SlotValues<Catalog[K]['variables']>;
type Output<K extends SystemMessageKey> = Catalog[K]['parts'] extends readonly [
  infer Text extends string,
]
  ? Text
  : string;

/** Interpolate with JavaScript template-literal coercion, preserving whitespace and punctuation. */
export function systemMessage<K extends SystemMessageKey>(key: K, ...values: Inputs<K>): Output<K> {
  const entry = SYSTEM_MESSAGE_CATALOG[key];
  if (values.length !== entry.variables.length)
    throw new Error(`System message ${key} needs ${entry.variables.length} variables`);
  let text: string = entry.parts[0];
  for (let index = 0; index < values.length; index++)
    text += `${values[index]}${entry.parts[index + 1]}`;
  return text as Output<K>;
}
