export type BuiltInSlashVerbId =
  | 'build'
  | 'poll'
  | 'catch-up'
  | 'schedule'
  | 'workflow'
  | 'open-corner'
  | 'rename'
  | 'close-corner'
  | 'change-target-branch'
  | 'add-agent'
  | 'invite';

export type BuiltInSlashVerb = {
  id: BuiltInSlashVerbId;
  command: string;
  label: string;
  description: string;
};

export type SlashVerbAvailability = {
  canBuild: boolean;
  canCreatePoll: boolean;
  canCatchUp: boolean;
  canManageSchedules: boolean;
  canRunWorkflows: boolean;
  canOpenCorner: boolean;
  canRename: boolean;
  canCloseCorner: boolean;
  canChangeTargetBranch: boolean;
  canAddAgent: boolean;
  canInvitePerson: boolean;
};

const BUILT_IN_SLASH_VERBS: readonly (BuiltInSlashVerb & {
  available: keyof SlashVerbAvailability;
})[] = [
  {
    id: 'build',
    command: 'build',
    label: 'Build something',
    description: 'Start a new corner in this Room',
    available: 'canBuild',
  },
  {
    id: 'poll',
    command: 'poll',
    label: 'Create poll',
    description: 'Ask this Room a question with a closing time',
    available: 'canCreatePoll',
  },
  {
    id: 'catch-up',
    command: 'catch-up',
    label: 'Catch up',
    // The verb opens the catch-up report over the unread range, which is what
    // the strip and the badge open. It used to scroll to the first unread row
    // and say so; the report is where that row is now described.
    description: 'See what you missed',
    available: 'canCatchUp',
  },
  {
    id: 'schedule',
    command: 'schedule',
    label: 'Scheduled work',
    description: 'View or stop recurring Agent work',
    available: 'canManageSchedules',
  },
  {
    id: 'workflow',
    command: 'workflow',
    label: 'Run workflow',
    description: 'Choose a repository workflow to dispatch',
    available: 'canRunWorkflows',
  },
  {
    id: 'open-corner',
    command: 'open-corner',
    label: 'Open edit corner',
    description: 'Allow the pending repository edit request',
    available: 'canOpenCorner',
  },
  {
    id: 'rename',
    command: 'rename',
    label: 'Rename Room',
    description: "Change this Room's display name",
    available: 'canRename',
  },
  {
    id: 'change-target-branch',
    command: 'change-target-branch',
    label: 'Change target branch',
    description: 'Confirm the pending target-branch proposal',
    available: 'canChangeTargetBranch',
  },
  {
    id: 'add-agent',
    command: 'add-agent',
    label: 'Add Agent',
    description: 'Choose an Agent from the workspace roster',
    available: 'canAddAgent',
  },
  {
    id: 'invite',
    command: 'invite',
    label: 'Invite person',
    description: 'Choose a person from the workspace roster',
    available: 'canInvitePerson',
  },
  {
    id: 'close-corner',
    command: 'close-corner',
    label: 'Close corner',
    description: 'End this edit session and archive the corner',
    available: 'canCloseCorner',
  },
];

/** A command is active only while the whole composer contains one slash token. */
export function slashVerbQuery(text: string): string | null {
  const match = /^\/([a-z0-9-]*)$/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/** One command an agent's harness advertises, as the composer palette renders it. */
export type AgentPaletteCommand = {
  name: string;
  description?: string;
  inputHint?: string;
};

/**
 * A slash token typed right after a completed @Agent mention, e.g.
 * `@lena /lo`. The palette then shows THAT agent's advertised commands;
 * `null` when the composer is not in that shape (the plain whole-text slash
 * query above still governs the built-in-verbs path).
 */
export type AgentMentionSlash = {
  /** The mention token immediately before the slash (without `@`). */
  mention: string;
  /** The slash token typed so far, without the leading `/` ('' when just '/'). */
  query: string;
};

const AGENT_MENTION_SLASH_PATTERN = /(?:^|[\s])@(\S+)[ \t]+\/([a-z0-9-]*)$/i;

/** Detect `@mention /query` at the end of the composer text (a trailing space closes it). */
export function agentMentionSlashQuery(text: string): AgentMentionSlash | null {
  const match = AGENT_MENTION_SLASH_PATTERN.exec(text);
  if (!match) return null;
  return { mention: match[1] ?? '', query: (match[2] ?? '').toLowerCase() };
}

/** Match a palette query against a command's name, description, or hint. */
export function matchesAgentCommand(command: AgentPaletteCommand, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return (
    command.name.toLowerCase().startsWith(normalizedQuery) ||
    (command.description?.toLowerCase().includes(normalizedQuery) ?? false) ||
    (command.inputHint?.toLowerCase().includes(normalizedQuery) ?? false)
  );
}

/** Restart is a Beeline lifecycle action, available even without a harness catalog. */
export function availableAgentMentionCommands(
  advertised: readonly AgentPaletteCommand[],
  query: string,
): AgentPaletteCommand[] {
  const restart = { name: 'restart', description: 'Restart this agent' };
  return [restart, ...advertised.filter((command) => command.name.toLowerCase() !== 'restart')]
    .filter((command) => matchesAgentCommand(command, query));
}

/** Replace only the active slash token, preserving the exact agent mention that authorizes it. */
export function insertAgentSlashCommand(text: string, command: string): string {
  return text.replace(/\/[a-z0-9-]*$/i, `/${command} `);
}

export function availableSlashVerbs(
  availability: SlashVerbAvailability,
  query: string,
): BuiltInSlashVerb[] {
  const normalizedQuery = query.trim().toLowerCase();
  return BUILT_IN_SLASH_VERBS.filter(
    (verb) =>
      availability[verb.available] &&
      (!normalizedQuery ||
        verb.command.startsWith(normalizedQuery) ||
        verb.label.toLowerCase().includes(normalizedQuery)),
  ).map(({ available: _available, ...verb }) => verb);
}

/** Corner-owned commands arrive with RoomView and need no hardcoded client inventory. */
export function availableCornerAppCommands(
  apps: readonly CornerAppView[],
  query: string,
): CornerAppView[] {
  const normalizedQuery = query.trim().toLowerCase();
  return apps.filter(
    (app) =>
      !normalizedQuery ||
      app.command.startsWith(normalizedQuery) ||
      app.title.toLowerCase().includes(normalizedQuery) ||
      app.description?.toLowerCase().includes(normalizedQuery),
  );
}
import type { CornerAppView } from '@beeline/api-contract/phone';
