import { createHash } from 'node:crypto';

/**
 * The read-only `@system` identity that DMs each person when a release is
 * delivered (apps/server/src/release-notify.ts). It is an ordinary human
 * identity — no daemon, no agent row, no owner — like REVIEW_IDENTITY_ID
 * (apps/server/src/review-access.ts) or SCHEDULE_SCHEDULER_ID
 * (scheduled-prompts.ts), distinguished only by this fixed id and
 * `hidden_from_roster=true`. That flag keeps it out of every roster listing
 * AND out of `seedDefaultWorkspace`'s automatic Workspace/#welcome human
 * backfill (default-workspace.ts excludes hidden identities from it), so it
 * is never a member of a shared Room and therefore never taggable there. Its
 * only memberships are the one-per-person read-only DM Rooms release-notify
 * creates directly.
 */
export const SYSTEM_IDENTITY_ID = createHash('sha256')
  .update('beeline:system-identity')
  .digest('hex');
export const SYSTEM_IDENTITY_NAME = 'System';
export const SYSTEM_IDENTITY_HANDLE = 'system';

/**
 * The hidden author that remains after a person deletes their account
 * (PhoneService.deleteAccount). Messages in shared Rooms and DMs stay
 * readable as the conversation record (the privacy page's "Room content may
 * remain available" rule), but every one of them — and every one authored by
 * an agent the account owned — is re-attributed to this identity and stripped
 * of its mention of the deleted ids. Like the other fixed hidden humans it
 * is never a member of a shared Room and never taggable: `hidden_from_roster`
 * keeps it out of rosters and out of the #welcome backfill.
 */
export const DELETED_ACCOUNT_IDENTITY_ID = createHash('sha256')
  .update('beeline:deleted-account')
  .digest('hex');
export const DELETED_ACCOUNT_NAME = 'Deleted account';
