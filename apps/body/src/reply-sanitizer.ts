import { stripAgentReplyPreamble } from './activity.js';

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
