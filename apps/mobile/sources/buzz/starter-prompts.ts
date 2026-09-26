import type { ComposerMention } from '@/buzz/composer-fill';

/**
 * The first Room teaches by doing, so every starter it offers must actually
 * do something. A Room with an agent member offers the two agent starters,
 * tagged with that agent's handle; a Room with none offers the pairing
 * command instead — an untagged "ask an agent" line reaches nobody and
 * teaches the opposite of what it says.
 */
export type RoomStarterPrompt = {
  readonly lead: string;
  readonly detail: string;
  readonly testID: string;
  readonly action:
    | { readonly kind: 'fill'; readonly text: string; readonly mention: ComposerMention }
    | { readonly kind: 'connect-agent' }
    | { readonly kind: 'invite-person' };
};

const INVITE_PROMPT: RoomStarterPrompt = {
  lead: 'Invite someone',
  detail: 'who should see the result',
  testID: 'starter-invite',
  action: { kind: 'invite-person' },
};

export function roomStarterPrompts(
  agent?: { readonly pubkey: string; readonly handle?: string } | null,
): readonly RoomStarterPrompt[] {
  if (!agent?.handle)
    return [
      {
        lead: 'Connect an agent',
        detail: 'so this Room has someone to ask',
        testID: 'starter-connect-agent',
        action: { kind: 'connect-agent' },
      },
      INVITE_PROMPT,
    ];
  const mention: ComposerMention = { handle: agent.handle, pubkey: agent.pubkey };
  return [
    {
      lead: 'Ask an agent',
      detail: 'to turn an idea into a plan',
      testID: 'starter-ask-agent',
      action: {
        kind: 'fill',
        text: `@${agent.handle} Help me turn this idea into a plan: `,
        mention,
      },
    },
    {
      lead: 'Open a corner',
      detail: 'for focused work with its own branch',
      testID: 'starter-open-corner',
      action: { kind: 'fill', text: `@${agent.handle} Open a corner to `, mention },
    },
    INVITE_PROMPT,
  ];
}
