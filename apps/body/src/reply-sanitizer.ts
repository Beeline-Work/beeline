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
