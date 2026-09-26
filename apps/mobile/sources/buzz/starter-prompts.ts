import type { ComposerMention } from '@/buzz/composer-fill';

/**
 * The first Room teaches by doing, so every starter it offers must actually
 * do something. A Room with an agent member offers the two agent starters,
 * tagged with that agent's handle — an untagged "ask an agent" line reaches
 * nobody and teaches the opposite of what it says.
 *
 * A Room with no agent asks for the one the Workspace can still give it: the
 * pairing command only when the WORKSPACE has no agent at all, otherwise the
 * Room's own agent picker, because minting a second agent for a Workspace
 * that already has one is the wrong answer. An unread roster counts as "has
 * agents": the picker can always route on to the pairing command, while the
 * command cannot undo an agent nobody needed.
 */
export type RoomStarterPrompt = {
  readonly lead: string;
  readonly detail: string;
  readonly testID: string;
  readonly action:
    | { readonly kind: 'fill'; readonly text: string; readonly mention: ComposerMention }
    | { readonly kind: 'add-room-agent' }
    | { readonly kind: 'connect-agent' }
    | { readonly kind: 'invite-person' };
};

const INVITE_PROMPT: RoomStarterPrompt = {
  lead: 'Invite someone',
  detail: 'who should see the result',
  testID: 'starter-invite',
  action: { kind: 'invite-person' },
};

export function roomStarterPrompts(input: {
  readonly roomAgent?: { readonly pubkey: string; readonly handle?: string } | null;
  /** Agents in this Workspace, or null while that roster read is in flight. */
  readonly workspaceAgentCount: number | null;
  /** Only a Workspace manager may add an existing agent to this Room. */
  readonly canAddRoomMembers: boolean;
}): readonly RoomStarterPrompt[] {
  const handle = input.roomAgent?.handle;
  if (!handle) {
    if (input.workspaceAgentCount === 0)
      return [
        {
          lead: 'Connect an agent',
          detail: 'so this Room has someone to ask',
          testID: 'starter-connect-agent',
          action: { kind: 'connect-agent' },
        },
        INVITE_PROMPT,
      ];
    if (input.canAddRoomMembers)
      return [
        {
          lead: 'Add an agent',
          detail: 'to this Room',
          testID: 'starter-add-agent',
          action: { kind: 'add-room-agent' },
        },
        INVITE_PROMPT,
      ];
    return [INVITE_PROMPT];
  }
  const mention: ComposerMention = { handle, pubkey: input.roomAgent!.pubkey };
  return [
    {
      lead: 'Ask an agent',
      detail: 'to turn an idea into a plan',
      testID: 'starter-ask-agent',
      action: {
        kind: 'fill',
        text: `@${handle} Help me turn this idea into a plan: `,
        mention,
      },
    },
    {
      lead: 'Open a corner',
      detail: 'for focused work with its own branch',
      testID: 'starter-open-corner',
      action: { kind: 'fill', text: `@${handle} Open a corner to `, mention },
    },
    INVITE_PROMPT,
  ];
}
