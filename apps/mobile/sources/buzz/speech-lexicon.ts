/**
 * The words dictation should favour in one conversation: its own names, the
 * people in it, Beeline's product vocabulary, and the terms its messages keep
 * using. A recogniser hears "beauty line" unless it is told "Beeline" exists.
 */
import { CORNER_LABEL, ROOM_LABEL, WORKSPACE_LABEL } from './vocabulary';

// iOS documents contextualStrings as best kept to about 100 phrases.
export const SPEECH_LEXICON_LIMIT = 100;
// Only recent talk shapes the project's lexicon; older history is not scanned.
const MESSAGE_SCAN_LIMIT = 200;
const MINED_TERM_LIMIT = 40;

/** Beeline's own terms, which no general speech model expects. */
export const BEELINE_LEXICON: readonly string[] = [
  'Beeline',
  WORKSPACE_LABEL,
  ROOM_LABEL,
  CORNER_LABEL,
  'corner app',
  'brief',
  'handoff',
  'grant',
  'yolo',
  'workflow',
  'reviewer',
  'Trusty Squire',
  'Squire',
];

export type SpeechLexiconSource = {
  roomName?: string | null;
  parentRoomName?: string | null;
  /** `owner/name` as the Room's repository binding shows it. */
  repositoryName?: string | null;
  memberNames?: readonly (string | null | undefined)[];
  memberHandles?: readonly (string | null | undefined)[];
  /** Message bodies, oldest first. */
  messages?: readonly string[];
};

/** A name as written plus, when it is a slug, the words a person says. */
function nameForms(name: string | null | undefined): string[] {
  const bare = name?.trim().replace(/^[#@]+/, '');
  if (!bare) return [];
  const spoken = bare
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return spoken && spoken !== bare ? [bare, spoken] : [bare];
}

function repositoryForms(repository: string | null | undefined): string[] {
  if (!repository?.trim()) return [];
  return repository.split('/').flatMap(nameForms);
}

const CODE_SPAN = /`([^`\n]{2,40})`/g;
// camelCase, PascalCase with an inner capital, and Capitalised-Hyphenated names.
const COINED_WORD =
  /\b(?:[a-z]+[A-Z][A-Za-z]*|[A-Z][a-z]+[A-Z][A-Za-z]*|[A-Z][A-Za-z]+(?:-[A-Za-z]+)+)\b/g;
// A capitalised word that does not begin a sentence is usually a proper noun.
const MID_SENTENCE_PROPER = /[a-z,;:)]\s+([A-Z][a-z]{2,})\b/g;
const URL = /\bhttps?:\/\/\S+/g;

/**
 * Terms this conversation coins or names: code spans, camel/Pascal words,
 * hyphenated proper names, and mid-sentence proper nouns that recur, most
 * frequent first.
 */
export function minedProjectTerms(messages: readonly string[]): string[] {
  const counts = new Map<string, { term: string; count: number; lastSeen: number }>();
  const recent = messages.slice(-MESSAGE_SCAN_LIMIT);
  recent.forEach((raw, index) => {
    const text = raw.replace(URL, ' ');
    const found = [
      ...[...text.matchAll(CODE_SPAN)].map((match) => match[1]!.trim()),
      ...(text.replace(CODE_SPAN, ' ').match(COINED_WORD) ?? []),
      ...[...text.replace(CODE_SPAN, ' ').matchAll(MID_SENTENCE_PROPER)].map((match) => match[1]!),
    ];
    for (const term of found) {
      // Paths, hashes, and numbers are read, not spoken.
      if (!/^[A-Za-z][A-Za-z '-]*$/.test(term) || term.split(' ').length > 3) continue;
      const key = term.toLowerCase();
      const entry = counts.get(key);
      if (entry) {
        entry.count += 1;
        entry.lastSeen = index;
      } else {
        counts.set(key, { term, count: 1, lastSeen: index });
      }
    }
  });
  // A term said once is as likely a typo as vocabulary.
  return [...counts.values()]
    .filter((entry) => entry.count > 1)
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
    .slice(0, MINED_TERM_LIMIT)
    .map((entry) => entry.term);
}

/** The ordered, de-duplicated phrase list handed to the speech recogniser. */
export function buildSpeechLexicon(source: SpeechLexiconSource): string[] {
  const phrases = [
    ...nameForms(source.roomName),
    ...nameForms(source.parentRoomName),
    ...repositoryForms(source.repositoryName),
    ...(source.memberNames ?? []).flatMap(nameForms),
    ...(source.memberHandles ?? []).flatMap(nameForms),
    ...BEELINE_LEXICON,
    ...minedProjectTerms(source.messages ?? []),
  ];
  // Spelling is what the recogniser copies, so "beeline" and "Beeline" both stay.
  return [...new Set(phrases)].slice(0, SPEECH_LEXICON_LIMIT);
}
