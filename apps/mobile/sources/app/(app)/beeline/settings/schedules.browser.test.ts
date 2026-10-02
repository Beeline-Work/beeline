import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const NEXT_RUN = 1_790_000_000;

function shims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({ roomId: 'room-1', workspaceId: 'workspace-1' });
    export const router = { push: (href) => { (globalThis.__pushed ??= []).push(href); },
      replace: () => undefined, back: () => undefined };`,
    '@/sync/transport/monolith-operation': `export class MonolithPhoneOperationError extends Error {}
    export const monolithPhoneOperation = async (name) => name === 'listRoomWorkflowRuns' ? ({
      workflows: [
        { runId: 'run-1', workflowSlug: 'feedback-triage', description: 'Daily feedback sweep',
          roomId: 'corner-2', roomName: 'Issues triage', parentRoomId: 'room-1', state: 'approve',
          status: 'live', holder: { id: 'agent-1', name: 'Candy', kind: 'agent' }, viewerHolds: true,
          startedAt: ${NEXT_RUN}, updatedAt: ${NEXT_RUN}, earlierRunCount: 6 },
      ],
    }) : ({
      schedules: [
        { id: 'daily', workspaceId: 'workspace-1', roomId: 'room-1', agentId: 'agent-1',
          creatorId: 'agent-1', cadence: { kind: 'cron', expression: '0 8 * * *', timeZone: 'UTC' },
          message: 'Post the morning standup summary', nextRunAt: ${NEXT_RUN}, createdAt: 0 },
        { id: 'hourly', workspaceId: 'workspace-1', roomId: 'room-1', agentId: 'agent-1',
          creatorId: 'agent-1', cadence: { kind: 'interval', everyMinutes: 60 },
          message: 'Check the deploy queue', nextRunAt: ${NEXT_RUN}, createdAt: 0,
          corner: { id: 'corner-1', name: 'quiet amber corner' } },
      ],
    });`,
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async room() {
        return {
          room: { name: 'beeline' },
          viewer: { permissions: { manage: true } },
          members: [{ identity: { kind: 'agent', pubkey: 'agent-1', name: 'Niglet' } }],
        };
      }
    }`,
    '@expo/vector-icons': `import React from 'react';
    export const Ionicons = (props) => React.createElement('span', { 'data-icon': props.name });`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: '${'a'.repeat(64)}' });`,
  };
}

describe.skipIf(!existsSync(CHROME))('Scheduled work page in a browser', () => {
  it('titles the page Room over Scheduled Work and says each cadence in words', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/scheduled-work-proof.tsx'),
      mobile,
      shims: shims(mobile),
      width: 390,
    });
    expect(status, stderr).toBe(0);
    if (process.env.PRINT_PROOF) console.log(result);
    expect(result.startsWith('{'), result).toBe(true);
    const page = JSON.parse(result) as {
      text: string[];
      back: boolean;
      eyebrowFont: string | null;
      titleFont: string | null;
      eyebrowAboveTitle: boolean | null;
      pushed: unknown[];
    };
    // The corner and workflow-run pages' header: small Room name over a bodyStrong title.
    expect(page.text.slice(0, 2)).toEqual(['#beeline', 'Scheduled Work']);
    expect(page).toMatchObject({
      back: true,
      eyebrowFont: '13px SpaceGrotesk-Regular',
      titleFont: '16px SpaceGrotesk-SemiBold',
      eyebrowAboveTitle: true,
    });
    // Workflows come first, then Schedules, each under its section head.
    expect(page.text.slice(2, 11)).toEqual([
      'Workflows',
      '1',
      'Feedback triage',
      'Approve · you',
      '@Candy',
      'Daily feedback sweep',
      'Issues triage',
      'Open →',
      'Schedules',
    ]);
    // Open → goes to the workflow's run page, not to the corner it runs in.
    expect(page.pushed).toEqual([
      { pathname: '/beeline/workflow-run', params: { roomId: 'corner-2', runId: 'run-1' } },
    ]);
    // No explainer paragraph, and no raw cron expression.
    expect(page.text.join(' ')).not.toMatch(/repository notifications|Agents create/);
    expect(page.text.join(' ')).not.toContain('0 8 * * *');
    expect(page.text).toContain('Daily at 08:00 UTC');
    expect(page.text).toContain('Every hour');
  }, 120_000);
});
