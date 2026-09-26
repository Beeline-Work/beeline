/**
 * What the Room deck should show, or where it should send the person instead.
 * One decision, in one place, so no screen has to re-derive it from a mix of
 * cached rows and in-flight reads.
 *
 * The rule the deck keeps getting wrong when this is inlined: only a LIVE
 * Workspace read may claim somebody has no Workspace — a cached empty list
 * plus an unreachable server is a failed read to report, never a loader to
 * hold forever. (An invite parked before sign-in outranks every landing, but
 * that is decided in the deck's bootstrap, before any of these reads start.)
 */
export type DeckWorkspacesRead =
  | { readonly status: 'pending' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly count: number };

export type DeckChatsRead = 'pending' | 'failed' | 'ready';

export type DeckLanding =
  | { readonly kind: 'choice' }
  | { readonly kind: 'deck' }
  | { readonly kind: 'error' }
  | { readonly kind: 'loader' };

export function deckLanding(input: {
  readonly workspaces: DeckWorkspacesRead;
  readonly chats: DeckChatsRead;
}): DeckLanding {
  if (input.workspaces.status === 'ready' && input.workspaces.count === 0) return { kind: 'choice' };
  if (input.chats === 'ready') return { kind: 'deck' };
  if (input.workspaces.status === 'failed' || input.chats === 'failed') return { kind: 'error' };
  return { kind: 'loader' };
}
