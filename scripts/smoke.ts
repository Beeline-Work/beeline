/**
 * Transport smoke test: prove the control-plane path end to end before wiring
 * up git. Creates a channel, sets roles, posts + reads back an approval event.
 * Asserts roles landed by querying Postgres directly (never trust an OK-true).
 */
import { execFileSync } from 'node:child_process';
import { newIdentity } from '../apps/gate/src/identity.js';
import { createChannel, setMemberRole } from '../apps/gate/src/buzz.js';
import { buildApproval, verifyApproval, APPROVAL_MARKER } from '../apps/gate/src/approval.js';
import { publishEvent, queryEvents } from '../apps/gate/src/relay.js';
import { KIND_STREAM_MESSAGE } from '../apps/gate/src/buzz.js';

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', 'buzzy-gate-postgres-1', 'psql', '-U', 'buzz', '-d', 'buzz', '-tAc', sql],
    { encoding: 'utf8' },
  ).trim();
}

async function main() {
  const worker = newIdentity('worker');
  const reviewer = newIdentity('reviewer');
  const agent = newIdentity('agent');
  console.log('worker  ', worker.publicKey);
  console.log('reviewer', reviewer.publicKey);
  console.log('agent   ', agent.publicKey);

  const channelId = await createChannel(worker, 'gate-proof');
  console.log('channel created:', channelId);

  await setMemberRole(worker, channelId, reviewer.publicKey, 'admin');
  await setMemberRole(worker, channelId, agent.publicKey, 'member');

  // Verify roles landed in Postgres (assert on real state).
  const rows = psql(
    `SELECT encode(pubkey,'hex') || '=' || role FROM channel_members WHERE channel_id='${channelId}' ORDER BY role;`,
  );
  console.log('DB channel_members:\n' + rows);
  const check = (pk: string, role: string) => {
    if (!rows.includes(`${pk}=${role}`))
      throw new Error(`role assert failed: ${pk} expected ${role}`);
  };
  check(worker.publicKey, 'owner');
  check(reviewer.publicKey, 'admin');
  check(agent.publicKey, 'member');
  console.log('OK: roles landed (worker=owner, reviewer=admin, agent=member)');

  // Post an approval as reviewer, read it back, verify binding.
  const target = {
    repo: `${worker.publicKey}/demo`,
    branch: 'refs/heads/main',
    tip: 'a'.repeat(40),
  };
  const approval = buildApproval(reviewer, channelId, target);
  const pub = await publishEvent(approval, reviewer);
  console.log('approval published, accepted =', pub.accepted);

  const back = await queryEvents(
    [
      {
        kinds: [KIND_STREAM_MESSAGE],
        authors: [reviewer.publicKey],
        '#h': [channelId],
        '#t': [APPROVAL_MARKER],
      },
    ],
    worker,
  );
  console.log('approvals read back:', back.length);
  const ok = back.some((ev) => verifyApproval(ev, reviewer.publicKey, target, channelId));
  if (!ok) throw new Error('approval round-trip / verifyApproval failed');
  console.log('OK: approval round-trips through the relay and verifies');

  // Negative: a forged approval (wrong signer) must NOT verify.
  const forged = buildApproval(agent, channelId, target); // signed by agent, not reviewer
  if (verifyApproval(forged, reviewer.publicKey, target, channelId)) {
    throw new Error('SECURITY: forged approval (wrong signer) verified!');
  }
  console.log('OK: forged approval (wrong signer) rejected');

  console.log('\nSMOKE PASSED');
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
