/**
 * The two command vocabularies that share one message box.
 *
 * Beeline defines a small set of composer slash commands (see
 * `BEELINE_SLASH_COMMANDS`). Coding harnesses define their own — `/loop`,
 * `/init`, `/compact`, … — and an agent model will happily interpret any
 * unrecognized `/word` as a command it is supposed to carry out. When a
 * person sends one of those to a Room, nothing on Beeline's side marks the
 * text, so the collision between the two vocabularies is silent: the message
 * reaches the harness verbatim and is executed with the *harness's* meaning,
 * not Beeline's.
 *
 * `matchSlashCommand` recognizes the shape of a command invocation so the
 * daemon can mark it visibly before the turn runs. It deliberately stays
 * narrow so ordinary prose that happens to start with a slash keeps flowing
 * as prose:
 *
 * - the first whitespace-delimited token must be a single slash word
 *   (`/loop`, `/open-corner`) — a second `/` inside the token (`/etc/hosts`)
 *   or args that begin with one (`/etc hosts`) reads as a filesystem path,
 *   not a command;
 * - the token starts with a letter and is bounded in length.
 */

export const BEELINE_SLASH_COMMANDS = [
  'open-corner',
  'approve',
  'change-target-branch',
  'add-agent',
  'invite',
  'close-corner',
] as const;

export type BeelineSlashCommand = (typeof BEELINE_SLASH_COMMANDS)[number];

/** A message whose first token is shaped like a slash-command invocation. */
export type SlashCommandInput = {
  /** The verb, without the leading slash, lowercased (e.g. `loop`). */
  command: string;
  /** Everything after the first token; `''` when the verb stands alone. */
  args: string;
};

const SLASH_COMMAND_PATTERN = /^\/([a-z][a-z0-9-]{0,23})(?:\s+([\s\S]*))?$/i;

export function matchSlashCommand(text: string): SlashCommandInput | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  // Only the first line can open a command invocation; anything else is a
  // multi-line message that merely begins with a slash-shaped line.
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  const match = SLASH_COMMAND_PATTERN.exec(firstLine);
  if (!match) return null;
  const args = match[2] ?? trimmed.slice(firstLine.length).trimStart();
  // A path continuation ("/etc/hosts", "/usr/bin/env run") is prose.
  if (args.startsWith('/')) return null;
  return { command: (match[1] ?? '').toLowerCase(), args };
}

export function isBeelineSlashCommand(command: string): boolean {
  return (BEELINE_SLASH_COMMANDS as readonly string[]).includes(command.toLowerCase());
}

/** Human-readable list of Beeline's own commands, each with its leading slash. */
export function beelineSlashCommandList(): string {
  return BEELINE_SLASH_COMMANDS.map((command) => `/${command}`).join(', ');
}
