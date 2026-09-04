const CODEX_NOTICE =
  /^(?:⚠(?:️)?\s*)?(?:warning|notice):\s*(?:skill|tool|plugin) descriptions?\b.*\b(?:context budget|budget limit)\b/i;
const CODEX_CONTINUATION =
  /^(?:codex can still (?:see|access|read)|(?:use|open|read)\s+\S*skill\.md\b)/i;
const PI_VERSION = /^pi v\d+(?:\.\d+)+(?:[-+][\w.]+)?\s*$/i;
const PI_UPDATE =
  /^new version available:\s*v?\d+(?:\.\d+)+(?:[-+][\w.]+)?\s*\(installed\s*v?\d+(?:\.\d+)+(?:[-+][\w.]+)?\)\.\s*run:\s*`?npm i(?:nstall)? -g\s+\S+`?\.?\s*$/i;
const PI_HEADER = /^##\s+(?:Context|Skills|Prompts|Extensions)\s*$/i;
const PI_DIVIDER = /^-{3,}\s*$/;
const PI_PATH = /^[-*]\s+(?:\/|~\/|npm:)\S*$/;

function stripCodex(message: string): string {
  const lines = message.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  if (first < 0 || !CODEX_NOTICE.test(lines[first]!.trim())) return message;
  let i = first + 1;
  while (
    i < lines.length &&
    (!lines[i]!.trim() || CODEX_CONTINUATION.test(lines[i]!.trim()) || CODEX_NOTICE.test(lines[i]!.trim()))
  ) i++;
  return lines.slice(i).join('\n');
}

function nextMatches(lines: readonly string[], from: number, pattern: RegExp): boolean {
  let i = from;
  while (i < lines.length && !lines[i]!.trim()) i++;
  return i < lines.length && pattern.test(lines[i]!.trim());
}

function stripPi(message: string): string {
  const lines = message.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (i >= lines.length) return message;
  const first = lines[i]!.trim();
  if (
    !PI_VERSION.test(first) &&
    !PI_HEADER.test(first) &&
    !PI_UPDATE.test(first) &&
    !(PI_DIVIDER.test(first) && nextMatches(lines, i + 1, PI_UPDATE))
  ) return message;
  let section = PI_HEADER.test(first);
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line || PI_VERSION.test(line) || PI_DIVIDER.test(line) || PI_UPDATE.test(line)) {
      i++;
      continue;
    }
    if (PI_HEADER.test(line)) {
      section = true;
      i++;
      continue;
    }
    if (section && PI_PATH.test(line)) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n');
}

export function stripAgentReplyPreamble(message: string): string {
  return stripPi(stripCodex(message));
}

const THIN_ROOM_SCAFFOLD_ECHO =
  /^(?:[\p{L}\p{M}\p{N}_. -]{1,80},\s*)?(?:please\s+)?(?:answer|reply|respond)\s+(?:to\s+)?(?:the\s+)?(?:user(?:'s)?|human(?:'s)?)\s+(?:actual\s+)?(?:newest|latest)\s+message[.!]?$/iu;
const DIRECT_ANSWER_SCAFFOLD_ECHO =
  /^(?:please\s+)?answer\s+the\s+(?:newest|latest)\s+message\s+directly[.!]?$/iu;

/** Keep harness startup output and thin-loop instructions out of Room drafts and replies. */
export function sanitizeAgentReply(message: string): string {
  const visible = stripAgentReplyPreamble(message).trim();
  if (!visible) return '';
  const lines = visible.split(/\r?\n/);
  const first = lines[0]!.trim();
  if (!THIN_ROOM_SCAFFOLD_ECHO.test(first) && !DIRECT_ANSWER_SCAFFOLD_ECHO.test(first)) {
    return visible;
  }
  return lines.slice(1).join('\n').trim();
}

const CORNER_OPEN_ECHO =
  /^(?:(?:ok(?:ay)?|done|sure|great|alright)[,.!:]?\s+)?(?:i(?:'ve| have|'ll| will|'m| am)?\s+)?(?:just\s+)?open(?:ed|ing)?\s+(?:up\s+)?(?:a\s+|the\s+|your\s+)?(?:new\s+|write(?:-enabled)?\s+|repository\s+)*corner\b/iu;
const CORNER_OPEN_ECHO_MAX_CHARS = 320;

/**
 * After a successful open_corner call the server's corner card already announces
 * the corner: drop the model's own "Opened corner <id> …" paragraph. Bounded to
 * the first paragraph, only when it starts as that announcement and stays short;
 * anything the model says after a blank line is kept.
 */
export function stripCornerOpenEcho(message: string): string {
  const visible = message.trim();
  if (!visible) return '';
  const paragraphs = visible.split(/\n\s*\n/);
  const first = paragraphs[0]!.trim();
  if (first.length > CORNER_OPEN_ECHO_MAX_CHARS || !CORNER_OPEN_ECHO.test(first)) return visible;
  return paragraphs.slice(1).join('\n\n').trim();
}

/** Words a status line spends without saying anything the corner does not already show. */
const STATUS_FILLER = new Set(
  (
    'a an the this that it its is are was were be been being has have had do does did ' +
    'now still remains remain remaining ready for review reviewing pr pull request all every ' +
    'both and or so to of in on at as with by no not nothing new further more else needed ' +
    'needs need required action actions change changes changed status state update updates ' +
    'updated waiting wait awaiting pending running progress idle done ok okay good great well ' +
    'fine confirmed confirm already again yet just currently right i we will can should would ' +
    'github remote upstream branch head latest current report reported noted note see looks ' +
    'look like everything nothing appears appear seems seem there here which what from ' +
    'without any'
  ).split(/\s+/),
);
/** Each system-line word admits its plain synonyms; nothing else is admitted. */
const STATUS_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  passed: ['pass', 'passed', 'passing', 'passes', 'green', 'succeeded', 'success', 'successful', 'successfully'],
  failed: ['fail', 'failed', 'failing', 'fails', 'red', 'broke', 'broken', 'failure', 'failures'],
  check: ['check', 'checks', 'ci', 'run', 'runs', 'workflow', 'workflows', 'build', 'builds', 'test', 'tests', 'suite'],
  started: ['start', 'started', 'starting', 'began', 'begun', 'kicked', 'off', 'queued'],
  merged: ['merge', 'merged', 'merging', 'landed', 'closed'],
};
const STATUS_RESTATEMENT_MAX_CHARS = 200;
const STATUS_RESTATEMENT_MAX_SENTENCES = 2;

function statusWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) ?? []).map((word) =>
    word.replace(/^'+|'+$/g, '').replace(/'s$/, ''),
  );
}

/**
 * True when a corner reply only restates the server's system line(s) that
 * triggered the turn ("PR checks have passed", "CI is green", "PR remains
 * ready for review"). Bounded: at most two short sentences, no URL, and every
 * word is either filler or a word (or plain synonym) of one of those lines.
 * Anything carrying a new word — a merge, a push, a failing check's name, a
 * reason — is kept.
 */
export function isCornerStatusRestatement(reply: string, systemLines: readonly string[]): boolean {
  const text = reply.trim();
  if (!text) return true;
  if (text.length > STATUS_RESTATEMENT_MAX_CHARS) return false;
  if (/https?:\/\/\S+/i.test(text)) return false;
  const sentences = text.split(/[.!?]+(?:\s+|$)/).filter((part) => part.trim());
  if (sentences.length > STATUS_RESTATEMENT_MAX_SENTENCES) return false;
  const admitted = new Set(STATUS_FILLER);
  for (const line of systemLines) {
    for (const word of statusWords(line)) {
      admitted.add(word);
      for (const synonym of STATUS_SYNONYMS[word] ?? []) admitted.add(synonym);
    }
  }
  return statusWords(text).every((word) => !word || admitted.has(word));
}
