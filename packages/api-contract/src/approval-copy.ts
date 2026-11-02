import { systemMessage } from './system-message-catalog.js';
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
    case 'fetch_credential': return systemMessage("approval-copy.reveal-a-key");
    case 'inject_card': return systemMessage("approval-copy.buy", first || systemMessage("approval-copy.an-item"));
    case 'edit_credential': return systemMessage("approval-copy.edit-a-key");
    case 'delete_credential': return systemMessage("approval-copy.delete-a-key");
    case 'edit_payment_card': return systemMessage("approval-copy.edit-a-card");
    case 'operate_login':
    case 'operate_fill_credential': return systemMessage("approval-copy.sign-in-to", first.replace(/^Sign in to /i, '') || systemMessage("approval-copy.a-site"));
    case 'Link': return systemMessage("approval-copy.confirm-a-purchase");
    default: return linkKind === 'vouch' ? systemMessage("approval-copy.request-a-vouch") : linkKind === 'passkey' ? systemMessage("approval-copy.use-a-passkey") : systemMessage("approval-copy.use-trusty-squire");
  }
}
