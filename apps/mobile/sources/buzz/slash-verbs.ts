export type BuiltInSlashVerbId =
  'open-corner' | 'close-corner' | 'approve' | 'change-target-branch' | 'add-agent' | 'invite';

export type BuiltInSlashVerb = {
  id: BuiltInSlashVerbId;
  command: string;
  label: string;
  description: string;
};

export type SlashVerbAvailability = {
  canOpenCorner: boolean;
  canCloseCorner: boolean;
  canApprove: boolean;
  canChangeTargetBranch: boolean;
  canAddAgent: boolean;
  canInvitePerson: boolean;
};

const BUILT_IN_SLASH_VERBS: readonly (BuiltInSlashVerb & {
  available: keyof SlashVerbAvailability;
})[] = [
  {
    id: 'open-corner',
    command: 'open-corner',
    label: 'Open edit corner',
    description: 'Allow the pending repository edit request',
    available: 'canOpenCorner',
  },
  {
    id: 'approve',
    command: 'approve',
    label: 'Approve & merge',
    description: 'Approve the reviewed change for landing',
    available: 'canApprove',
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
