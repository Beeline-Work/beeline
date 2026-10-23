/** Safe, non-secret presentation metadata relayed with a Squire approval. */
export type SquireApprovalDetails = {
  readonly action?: string;
  readonly reason?: string;
  readonly facts?: readonly { readonly label: string; readonly value: string }[];
  readonly reference?: string;
};

/** Older helpers supply only title/detail; keep their approval cards readable. */
export function squireApprovalAction(tool: string, detail: string, linkKind?: string): string {
  const first = detail.split(' · ')[0]?.trim() ?? '';
  switch (tool) {
    case 'fetch_credential': return 'reveal a key';
    case 'inject_card': return `buy ${first || 'an item'}`;
    case 'edit_credential': return 'edit a key';
    case 'delete_credential': return 'delete a key';
    case 'edit_payment_card': return 'edit a card';
    case 'operate_login':
    case 'operate_fill_credential': return `sign in to ${first.replace(/^Sign in to /i, '') || 'a site'}`;
    case 'Link': return 'confirm a purchase';
    default: return linkKind === 'vouch' ? 'request a vouch' : linkKind === 'passkey' ? 'use a passkey' : 'use Trusty Squire';
  }
}
