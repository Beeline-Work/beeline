#!/usr/bin/env node
import { createBuzzClient, loadIdentityFromNsec } from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';

async function main() {
  const relay = process.env.RELAY_URL || 'https://usebeeline.app';
  const agentNsec = process.env.PROOF_AGENT_NSEC;
  const cornerId = process.env.PROOF_CORNER_ID;

  if (!agentNsec || !cornerId) {
    throw new Error('Set PROOF_AGENT_NSEC and PROOF_CORNER_ID from scripts/provision-smoke.ts.');
  }

  const identity = loadIdentityFromNsec(agentNsec, 'tool-ledger-proof');
  const client = createBuzzClient({ baseUrl: relay, identity });
  await client.connect();

  const sessionId = 'smoke-corner-session';
  const output = (formattedOutput: string, exitCode: number) =>
    JSON.stringify({ formatted_output: formattedOutput, exit_code: exitCode });
  const updates = [
    {
      sessionUpdate: 'tool_activity',
      toolCallId: 'proof-types',
      title: 'Run typecheck',
      kind: 'execute',
      status: 'completed',
      command: 'npm run typecheck',
      output: output('TypeScript found 0 errors.', 0),
    },
    {
      sessionUpdate: 'tool_activity',
      toolCallId: 'proof-read',
      title: 'Read gateway.ts',
      kind: 'read',
      status: 'completed',
      input: 'apps/mobile/sources/buzz/gateway.ts',
      output: 'Read 184 lines.',
    },
    {
      sessionUpdate: 'tool_activity',
      toolCallId: 'proof-edit',
      title: 'Edit ActivityTimeline.tsx',
      kind: 'edit',
      status: 'completed',
      files: [
        { path: 'apps/mobile/sources/components/buzz/ActivityTimeline.tsx', status: 'modified' },
      ],
      output: 'Applied compact ledger rendering.',
    },
    {
      sessionUpdate: 'tool_activity',
      toolCallId: 'proof-failure',
      title: 'fast gate',
      kind: 'execute',
      status: 'failed',
      command: 'pnpm fast-gate',
      output: output(
        'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL\nnpm error code 127\npnpm: command not found\nELIFECYCLE Command failed',
        127,
      ),
    },
    {
      sessionUpdate: 'tool_activity',
      toolCallId: 'proof-search',
      title: 'Search ledger rows',
      kind: 'search',
      status: 'completed',
      command: 'rg "activity-step" apps/mobile/sources',
      output: '18 matches.',
    },
    {
      sessionUpdate: 'tool_activity',
      toolCallId: 'proof-tests',
      title: 'Run mobile tests',
      kind: 'execute',
      status: 'completed',
      command: 'npm test',
      output: output('92 tests passed.', 0),
    },
    {
      sessionUpdate: 'activity_summary',
      thoughtMs: 51_000,
    },
  ];

  await client.publish(
    signEvent(
      {
        pubkey: identity.publicKey,
        created_at: Math.floor(Date.now() / 1_000),
        kind: 9,
        tags: [
          ['h', cornerId],
          ['t', 'agent-activity'],
          ['session', sessionId],
        ],
        content: JSON.stringify({
          sessionId,
          update: { sessionUpdate: 'activity_batch', updates },
          projected: true,
        }),
      },
      identity.secretKey,
    ),
  );
  await client.messageSubmit(
    cornerId,
    'The ledger proof is ready. Machine detail stays quiet; this narrative remains the star.',
    { extraTags: [['t', 'agent-message']] },
  );
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await client.publish(
    signEvent(
      {
        pubkey: identity.publicKey,
        created_at: Math.floor(Date.now() / 1_000),
        kind: 9,
        tags: [
          ['h', cornerId],
          ['t', 'agent-activity'],
          ['session', 'smoke-landing-session'],
        ],
        content: JSON.stringify({
          sessionId: 'smoke-landing-session',
          update: {
            sessionUpdate: 'activity_batch',
            updates: [
              {
                sessionUpdate: 'tool_activity',
                toolCallId: 'landing-approval',
                title: 'Verify owner approval',
                kind: 'execute',
                status: 'completed',
                command: 'verify signed owner approval',
                output: 'Owner approval verified for this corner.',
              },
              {
                sessionUpdate: 'tool_activity',
                toolCallId: 'landing-sync',
                title: 'Sync target branch',
                kind: 'execute',
                status: 'completed',
                command: 'git merge origin/main',
                output: 'Target branch already current.',
              },
              {
                sessionUpdate: 'tool_activity',
                toolCallId: 'landing-push',
                title: 'Land approved change',
                kind: 'execute',
                status: 'completed',
                command: 'git push origin HEAD:main',
                output: 'Landing push accepted.',
              },
            ],
          },
          projected: true,
        }),
      },
      identity.secretKey,
    ),
  );
  client.disconnect();
  console.log(`Published tool ledger proof to ${cornerId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
