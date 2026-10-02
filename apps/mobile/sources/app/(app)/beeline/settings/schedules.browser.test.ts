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
    export const monolithPhoneOperation = async (name) => {
      (globalThis.__operations ??= []).push(name);
      if (name !== 'listRoomSchedules') throw new Error('unexpected ' + name);
      return {
      schedules: [
        { id: 'daily', workspaceId: 'workspace-1', roomId: 'room-1', agentId: 'agent-1',
          creatorId: 'agent-1', cadence: { kind: 'cron', expression: '0 8 * * *', timeZone: 'UTC' },
          message: 'Post the morning standup summary', nextRunAt: ${NEXT_RUN}, createdAt: 0 },
        { id: 'hourly', workspaceId: 'workspace-1', roomId: 'room-1', agentId: 'agent-1',
          creatorId: 'agent-1', cadence: { kind: 'interval', everyMinutes: 60 },
          message: 'Check the deploy queue', nextRunAt: ${NEXT_RUN}, createdAt: 0,
          corner: { id: 'corner-1', name: 'quiet amber corner' } },
      ],
    };
    };`,
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
  it('lists schedules only, titled Room over Scheduled Work, each cadence in words', async () => {
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
      afterStop: string[];
      back: boolean;
      eyebrowFont: string | null;
      titleFont: string | null;
      eyebrowAboveTitle: boolean | null;
      pushed: unknown[];
      workflowSection: boolean;
      operations: string[];
    };
    // The corner and workflow-run pages' header: small Room name over a bodyStrong title.
    expect(page.text.slice(0, 2)).toEqual(['#beeline', 'Scheduled Work']);
    expect(page).toMatchObject({
      back: true,
      eyebrowFont: '13px SpaceGrotesk-Regular',
      titleFont: '16px SpaceGrotesk-SemiBold',
      eyebrowAboveTitle: true,
    });
    // Schedules only: no Workflows section, no section heads, and no workflow read.
    expect(page.workflowSection).toBe(false);
    expect(page.text).not.toContain('Workflows');
    expect(page.text).not.toContain('Schedules');
    expect(page.operations).toEqual(['listRoomSchedules']);
    expect(page.text.slice(2)).toEqual([
      'Daily at 08:00 UTC',
      expect.stringMatching(/^NEXT /),
      '@Niglet',
      'Post the morning standup summary',
      'STOP',
      'Every hour',
      expect.stringMatching(/^NEXT /),
      '@Niglet',
      'Check the deploy queue',
      'quiet amber corner',
      'STOP',
    ]);
    // A schedule in a corner opens that corner; STOP asks to confirm, as before.
    expect(page.pushed).toEqual([
      {
        pathname: '/beeline/chat/[channelId]',
        params: { channelId: 'corner-1', parent: 'room-1', title: 'quiet amber corner' },
      },
    ]);
    expect(page.afterStop).toContain('CANCEL');
    expect(page.afterStop).toContain('CONFIRM STOP');
    // No explainer paragraph, and no raw cron expression.
    expect(page.text.join(' ')).not.toMatch(/repository notifications|Agents create/);
    expect(page.text.join(' ')).not.toContain('0 8 * * *');
    expect(page.text).toContain('Daily at 08:00 UTC');
    expect(page.text).toContain('Every hour');
  }, 120_000);
});
