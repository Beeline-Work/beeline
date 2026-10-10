import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const NEXT_RUN = 1_790_000_000;

function shims(mobile: string): Record<string, string> {
  const contract = readFileSync(path.join(mobile, '../../docs/workflows/feedback-triage.json'), 'utf8');
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => Object.fromEntries(new URLSearchParams(location.search));
    export const router = { push: (href) => { (globalThis.__pushed ??= []).push(href); },
      replace: () => undefined, back: () => { globalThis.__back = (globalThis.__back ?? 0) + 1; } };`,
    '@/sync/transport/live-connection': `export const sharedLiveConnection = () => ({
      register: async () => () => undefined,
    });`,
    '@/sync/transport/monolith-operation': `export class MonolithPhoneOperationError extends Error {}
    export const monolithPhoneOperation = async (name, input) => {
      (globalThis.__operations ??= []).push(name);
      (globalThis.__inputs ??= []).push([name, input]);
      if (name === 'readRoomWebhooks') return {
        sources: [
          { id: 'hook-1', source: 'github', signed: true, revoked: false, agents: ['Speedy', 'Ruby'],
            reason: 'Wake reviewers when a PR opens on beeline.', requestedBy: 'Speedy' },
          { id: 'hook-2', source: 'old-feed', signed: false, revoked: true, agents: [] },
        ],
        requests: [],
        deliveries: [{ id: 'd-1', source: 'github', receivedAt: ${NEXT_RUN}, delivered: 1 }],
      };
      if (name === 'manageRoomWebhook' || name === 'deleteRoomSchedule') return {};
      if (name === 'readWorkflowDefinition') return { contract: ${contract}, runs: [] };
      if (name !== 'listRoomSchedules') throw new Error('unexpected ' + name);
      if (new URLSearchParams(location.search).has('failScheduleRead') && !globalThis.__failedScheduleRead) {
        globalThis.__failedScheduleRead = true;
        throw new Error('schedule read unavailable');
      }
      return {
      schedules: [
        { id: 'daily', workspaceId: 'workspace-1', roomId: 'room-1', agentId: 'agent-1',
          creatorId: 'agent-1', cadence: { kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'UTC' },
          message: "Summarize yesterday's merged PRs for the Room. Group them by area and link each PR.",
          nextRunAt: ${NEXT_RUN}, createdAt: 0, runCount: 14 },
        { id: 'video', workspaceId: 'workspace-1', roomId: 'corner-1', agentId: 'agent-2',
          creatorId: 'agent-2', cadence: { kind: 'cron', expression: '0 14 * * *', timeZone: 'America/New_York' },
          message: 'Start the feedback-triage workflow with start_workflow.', nextRunAt: ${NEXT_RUN}, createdAt: 0,
          runCount: 3, workflowSlug: 'feedback-triage', corner: { id: 'corner-1', name: 'issues-triage' } },
      ],
    };
    };`,
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async room() {
        return {
          room: { name: 'beeline' },
          viewer: { permissions: { manage: true } },
          members: [
            { identity: { kind: 'agent', pubkey: 'agent-1', name: 'Hoots' } },
            { identity: { kind: 'agent', pubkey: 'agent-2', name: 'Ruby' } },
          ],
        };
      }
    }`,
    '@expo/vector-icons': `import React from 'react';
    export const Ionicons = (props) => React.createElement('span', { 'data-icon': props.name });`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: '${'a'.repeat(64)}' });`,
  };
}

type Page = {
  beforeRetry: string[];
  text: string[];
  eyebrowFont: string | null;
  titleFont: string | null;
  eyebrowAboveTitle: boolean | null;
  glyphs: string[];
  steps: string[];
  pendingCircles: number;
  allCircles: number;
  pushed: unknown[];
  afterStop: string[];
  operationsBeforeConfirm: string[];
  operations: string[];
  inputs: [string, unknown][];
  back: number;
};

async function proof(query: string): Promise<Page> {
  const mobile = process.cwd();
  const { result, status, stderr } = await runBrowserProof({
    entry: path.join(mobile, 'scripts/scheduled-work-proof.tsx'),
    mobile,
    shims: shims(mobile),
    width: 390,
    query,
  });
  expect(status, stderr).toBe(0);
  if (process.env.PRINT_PROOF) console.log(result);
  expect(result.startsWith('{'), result).toBe(true);
  return JSON.parse(result) as Page;
}

const stopped = (page: Page, operation: string) => {
  // One tap asks; nothing is stopped until the confirm row is tapped.
  expect(page.operationsBeforeConfirm).not.toContain(operation);
  expect(page.operations).toContain(operation);
  expect(page.back).toBe(1);
};

describe.skipIf(!existsSync(CHROME))('Schedules and Webhooks pages in a browser', () => {
  it('lists each entry in one grammar and opens its own page', async () => {
    const page = await proof('?page=list&roomId=room-1&workspaceId=workspace-1');
    // The corner and workflow-run pages' header: small Room name over a bodyStrong title.
    expect(page.text.slice(0, 2)).toEqual(['#beeline', 'Schedules and Webhooks']);
    expect(page).toMatchObject({
      eyebrowFont: '13px SpaceGrotesk-Regular',
      titleFont: '16px SpaceGrotesk-SemiBold',
      eyebrowAboveTitle: true,
    });
    expect(page.text.slice(2)).toEqual([
      'SCHEDULES',
      "Summarize yesterday's merged PRs for the Room… · Weekdays at 09:00 UTC",
      '@Hoots · this Room',
      'feedback-triage workflow · Daily at 14:00 America/New_York',
      '@Ruby · #issues-triage',
      'WEBHOOKS',
      'github event payload · On each github delivery',
      '@Speedy, @Ruby · this Room',
    ]);
    // Only the workflow schedule wears a glyph; revoked webhooks stay hidden.
    expect(page.glyphs).toEqual(['scheduled-work-glyph-video']);
    expect(page.text.join(' ')).not.toMatch(/LAST|NEVER FIRED|STOP|REVOKE|old-feed/);
    expect(page.pushed).toEqual([
      { pathname: '/beeline/settings/schedule', params: { roomId: 'room-1', scheduleId: 'daily' } },
      {
        pathname: '/beeline/workflow',
        params: { roomId: 'corner-1', name: 'feedback-triage', scheduleId: 'video', parentRoomId: 'room-1' },
      },
      { pathname: '/beeline/settings/webhook', params: { roomId: 'room-1', webhookId: 'hook-1' } },
    ]);
  }, 120_000);

  it('opens a prompt schedule: Runs, Agent, Where, the full prompt, its run count, then Stop', async () => {
    const page = await proof('?page=schedule&roomId=room-1&scheduleId=daily');
    expect(page.text[0]).toBe('Schedules and Webhooks');
    expect(page.text[1]).toBe('Schedule');
    expect(page.text.slice(2)).toEqual([
      'Runs',
      expect.stringMatching(/^Weekdays at 09:00 UTC · next /),
      'Agent',
      '@Hoots',
      'Where',
      'this Room',
      'Prompt',
      "Summarize yesterday's merged PRs for the Room. Group them by area and link each PR.",
      'Runs so far',
      '14',
      'Stop schedule',
    ]);
    expect(page.afterStop.slice(-2)).toEqual(['Confirm: Stop schedule', 'Cancel']);
    stopped(page, 'deleteRoomSchedule');
    expect(page.inputs).toContainEqual(['deleteRoomSchedule', { roomId: 'room-1', scheduleId: 'daily' }]);
  }, 120_000);

  it('opens a webhook: what makes it fire and what a delivery does, with no delivery log', async () => {
    const page = await proof('?page=webhook&roomId=room-1&webhookId=hook-1');
    expect(page.text.slice(0, 2)).toEqual(['Schedules and Webhooks', 'github webhook']);
    expect(page.text.slice(2)).toEqual([
      'Runs',
      'On each github delivery · signed',
      'Agents',
      '@Speedy, @Ruby',
      'Where',
      'this Room',
      'Trigger',
      "Fires when github sends a request to this webhook's URL. The sender's own webhook settings choose which events it sends. Only requests signed with the shared secret are accepted.",
      'Why: "Wake reviewers when a PR opens on beeline." @Speedy',
      'Payload',
      'Each delivery wakes @Speedy and @Ruby with the event payload.',
      'Stop webhook',
    ]);
    expect(page.afterStop.slice(-2)).toEqual(['Confirm: Stop webhook', 'Cancel']);
    stopped(page, 'manageRoomWebhook');
    expect(page.inputs).toContainEqual([
      'manageRoomWebhook',
      { roomId: 'room-1', action: 'revoke', webhookId: 'hook-1' },
    ]);
  }, 120_000);

  it('opens a workflow schedule on the workflow page: its schedule rows, every step pending on the rail, then Stop', async () => {
    const page = await proof(
      '?page=workflow&roomId=corner-1&name=feedback-triage&scheduleId=video&parentRoomId=room-1',
    );
    expect(page.text[0]).toBe('Feedback triage');
    expect(page.text).toEqual(
      expect.arrayContaining([
        'Runs',
        expect.stringMatching(/^Daily at 14:00 America\/New_York · next /),
        'Agent',
        '@Ruby',
        'Where',
        '#issues-triage',
        'Steps',
        'History',
        'No runs yet.',
        'Stop schedule',
      ]),
    );
    // The contract's path from its start state, every step pending: no run status is claimed.
    expect(page.steps.length).toBeGreaterThan(2);
    expect(page.steps[0]).toBe('workflow-steps-step-notify');
    expect(page.pendingCircles).toBe(page.allCircles);
    expect(page.text.indexOf('Steps')).toBeLessThan(page.text.indexOf('History'));
    // The workflow is read from the schedule's own corner.
    expect(page.inputs).toContainEqual(['readWorkflowDefinition', { roomId: 'corner-1', name: 'feedback-triage' }]);
    stopped(page, 'deleteRoomSchedule');
    expect(page.inputs).toContainEqual(['deleteRoomSchedule', { roomId: 'room-1', scheduleId: 'video' }]);
  }, 120_000);

  it('shows a failed schedule read on the workflow page, and Retry restores its rows and Stop', async () => {
    const page = await proof(
      '?page=workflow&roomId=corner-1&name=feedback-triage&scheduleId=video&parentRoomId=room-1&failScheduleRead=1',
    );
    expect(page.beforeRetry).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Could not load schedules and webhooks: .*schedule read unavailable · Retry$/),
        'Steps',
      ]),
    );
    expect(page.beforeRetry).not.toContain('Stop schedule');
    expect(page.text).toEqual(expect.arrayContaining(['Agent', '@Ruby', '#issues-triage', 'Stop schedule']));
    expect(page.text.some((line) => line.includes('Could not load'))).toBe(false);
    stopped(page, 'deleteRoomSchedule');
  }, 120_000);
});
