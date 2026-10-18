import { PostgresDatabase } from './database.js';
import { sendServiceReviewNotices, type NoticeRecipient } from './service-review-notice.js';

// Verified identity/email inventory is supplied privately over stdin, never argv.
if (!process.env.DATABASE_URL || !process.env.RESEND_API_KEY || !process.env.BEELINE_NOTICE_FROM)
  throw new Error('Configure the granted database, Resend sender and API access before sending.');
let input = '';
for await (const chunk of process.stdin) input += String(chunk);
const recipients: unknown = JSON.parse(input);
if (!Array.isArray(recipients) || recipients.some((item) => !item || typeof item.identityId !== 'string' || typeof item.email !== 'string'))
  throw new Error('Expected a verified identityId/email inventory.');
const database = new PostgresDatabase(process.env.DATABASE_URL, 1);
try {
  const count = await sendServiceReviewNotices(database, recipients as NoticeRecipient[], async (notice) => {
    const result = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
        'Idempotency-Key': notice.idempotencyKey },
      body: JSON.stringify({ from: process.env.BEELINE_NOTICE_FROM, to: [notice.to], subject: notice.subject, text: notice.text }),
    });
    if (!result.ok) throw new Error(`Notice provider returned HTTP ${result.status}; rollout remains disabled.`);
    const response = await result.json() as { id?: unknown };
    if (typeof response.id !== 'string') throw new Error('Notice provider did not acknowledge the email.');
    return response.id;
  });
  console.log(JSON.stringify({ sent: count }));
} finally { await database.close(); }
