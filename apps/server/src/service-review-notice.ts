import type { SqlDatabase } from './database.js';

export const SERVICE_REVIEW_EFFECTIVE_AT = new Date('2026-11-15T19:00:00Z');
export const SERVICE_REVIEW_NOTICE = {
  subject: "We're updating our privacy policy",
  text: `We're updating Beeline's privacy policy, effective November 15, 2026.

To find bugs and improve the service, a small number of Moon Rice Limited staff and AI review agents under staff direction may read workspace content, including Room messages, agent activity and error records. Third-party AI providers process the content reviewed by those agents.

We never publish what we read. Shared findings describe problems without quoting you or naming you or your Rooms.

Service review is on by default. You can turn it off for a workspace in Workspace settings → Allow fix sweep. That workspace is then skipped by the daily sweep. Reports you send with Report issue are still read.

Privacy policy: https://usebeeline.app/privacy/
Providers: https://usebeeline.app/subprocessors/

Moon Rice Limited`,
};

export type NoticeRecipient = { identityId: string; email: string };
export type NoticeSender = (input: typeof SERVICE_REVIEW_NOTICE & { to: string; idempotencyKey: string }) => Promise<string>;

/** The operator supplies verified recipients; the app does not invent email addresses. */
export async function sendServiceReviewNotices(
  database: SqlDatabase, recipients: readonly NoticeRecipient[], send: NoticeSender, now = new Date(),
): Promise<number> {
  const remaining = SERVICE_REVIEW_EFFECTIVE_AT.getTime() - now.getTime();
  if (remaining < 14 * 86400_000 || remaining >= 15 * 86400_000)
    throw new Error('Send the notice on November 1, 2026, at least 14 days before activation; otherwise revise the published date first.');
  const people = await database.query<{ id: string }>(
    `SELECT id FROM identities WHERE kind='human' AND hidden_from_roster=false`);
  const byId = new Map(recipients.map((recipient) => [recipient.identityId, recipient]));
  if (!people.rows.length || people.rows.some((person) => !byId.has(person.id)))
    throw new Error('Verified recipient inventory must cover every current human account before notice delivery.');
  if (recipients.some((recipient) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email)))
    throw new Error('A verified recipient email is invalid.');
  let sent = 0;
  for (const person of people.rows) {
    await database.transaction(async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`service-review-notice:${person.id}`]);
      const existing = await db.query(`SELECT 1 FROM service_review_notice_deliveries WHERE identity_id=$1`, [person.id]);
      if (existing.rowCount) return;
      const providerId = await send({ ...SERVICE_REVIEW_NOTICE, to: byId.get(person.id)!.email,
        idempotencyKey: `service-review-2026-11-15/${person.id}` });
      await db.query(`INSERT INTO service_review_notice_deliveries(identity_id,provider_id,sent_at)
        VALUES($1,$2,$3)`, [person.id, providerId, now]);
      sent++;
    });
  }
  await database.query(`UPDATE service_review_rollout SET notice_sent_at=$1,effective_at=$2 WHERE id=1
    AND notice_sent_at IS NULL`, [now, SERVICE_REVIEW_EFFECTIVE_AT]);
  return sent;
}
