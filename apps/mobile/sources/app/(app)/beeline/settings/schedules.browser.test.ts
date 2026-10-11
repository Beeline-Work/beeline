import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const NEXT_RUN = 1_790_000_000;

function shims(mobile: string): Record<string, string> {
  const contract = readFileSync(path.join(mobile, '../../docs/workflows/feedback-triage.json'), 'utf8');
  return {
    ...webProofShims(mobile),
    'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
      const theme = { buzz: new URLSearchParams(location.search).get('theme') === 'light'
        ? beelineThemes.bone : beelineThemes.obsidian };
      export const StyleSheet = { create: factory => (typeof factory === 'function' ? factory(theme) : factory), hairlineWidth: 1,
        absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } };
      export const useUnistyles = () => ({ theme });`,
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
      if (name === 'listRoomSubscriptions') return {
        subscriptions: [{ id: 'sub-1', roomId: 'room-1', agentId: 'agent-2',
          source: 'repository', event: 'pull_request.opened', repository: 'owner/widgets',
          createdAt: 0, lastFiredAt: ${NEXT_RUN}, prompt: 'Triage incoming work.', firedCount: 3 },
          { id: 'sub-2', roomId: 'corner-1', agentId: 'agent-2', source: 'room', event: 'joined',
            prompt: 'Start feedback triage.', workflowSlug: 'feedback-triage',
            corner: { id: 'corner-1', name: 'issues-triage' } }],
      };
      if (name === 'deleteRoomSubscription' || name === 'deleteRoomSchedule') return {};
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

function fontsCss(mobile: string): string {
  return ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold',
    'IBMPlexMono-Regular', 'IBMPlexMono-Italic', 'IBMPlexMono-SemiBold']
    .map((name) => `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${name}.ttf`)).toString('base64')})}`)
    .join('');
}

type Page = {
  beforeRetry: string[];
  text: string[];
  eyebrowFont: string | null;
  titleFont: string | null;
  eyebrowAboveTitle: boolean | null;
  glyphs: string[];
  workflowFills: Array<string | null>;
  loadedFonts: string[];
  listAxes: number[][];
  listPolygonCounts: number[];
  listLines: Array<{ height: number; leadVisible: boolean; sameLine: boolean; tailOneLine: boolean } | null>;
  detailAxis: number[];
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
    head: `<style>${fontsCss(mobile)}</style>`,
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

describe.skipIf(!existsSync(CHROME))('Schedules and subscriptions pages in a browser', () => {
  it('lists each entry in one grammar and opens its own page', async () => {
    const page = await proof('?page=list&roomId=room-1&workspaceId=workspace-1');
    // The corner and workflow-run pages' header: small Room name over a bodyStrong title.
    expect(page.text.slice(0, 2)).toEqual(['#beeline', 'Schedules and subscriptions']);
    expect(page).toMatchObject({
      eyebrowFont: '13px SpaceGrotesk-Regular',
      titleFont: '16px SpaceGrotesk-SemiBold',
      eyebrowAboveTitle: true,
    });
    expect(page.text.slice(2)).toEqual([
      "Summarize yesterday's merged PRs for the Room…",
      'Weekdays at 09:00 UTC',
      '· @Hoots ·',
      'this Room',
      'Triage incoming work',
      'On new pull request in owner/widgets',
      '· @Ruby ·',
      'this Room',
      'Feedback triage',
      'Daily at 14:00 America/New_York',
      '· @Ruby ·',
      'issues-triage',
      'Feedback triage',
      'On someone joining this Room',
      '· @Ruby ·',
      'issues-triage',
    ]);
    expect(page.glyphs).toEqual(['scheduled-work-glyph-video', 'subscription-glyph-sub-2']);
    expect(page.workflowFills).toEqual(['#b08a4a', '#b08a4a']);
    expect(page.loadedFonts).toEqual(expect.arrayContaining(['SpaceGrotesk-Regular', 'SpaceGrotesk-SemiBold']));
    expect(page.listAxes).toEqual([[45, 45], [45, 45], [45, 45], [45, 45]]);
    expect(page.listPolygonCounts).toEqual([0, 2, 0, 2]);
    expect(page.listLines).toEqual(Array(4).fill({ height: 64, leadVisible: true, sameLine: true, tailOneLine: true }));
    expect(page.text.join(' ')).not.toMatch(/LAST|NEVER FIRED|STOP|REVOKE/);
    expect(page.pushed).toEqual([
      { pathname: '/beeline/settings/schedule', params: { roomId: 'room-1', scheduleId: 'daily' } },
      { pathname: '/beeline/settings/schedule', params: { roomId: 'room-1', scheduleId: 'video' } },
      { pathname: '/beeline/settings/subscription', params: { roomId: 'room-1', subscriptionId: 'sub-1' } },
      { pathname: '/beeline/settings/subscription', params: { roomId: 'room-1', subscriptionId: 'sub-2' } },
    ]);
  }, 120_000);

  it('uses dark brass workflow marks on the light list', async () => {
    const page = await proof('?page=list&roomId=room-1&workspaceId=workspace-1&theme=light');
    expect(page.workflowFills).toEqual(['#8a6323', '#8a6323']);
    expect(page.listLines).toEqual(Array(4).fill({ height: 64, leadVisible: true, sameLine: true, tailOneLine: true }));
  }, 120_000);

  it('opens a prompt schedule with When, Agent, Where, Does, then Stop', async () => {
    const page = await proof('?page=schedule&roomId=room-1&scheduleId=daily');
    expect(page.text[0]).toBe('Schedules and subscriptions');
    expect(page.text[1]).toBe('Schedule');
    expect(page.text.slice(2)).toEqual([
      'When',
      expect.stringMatching(/^Weekdays at 09:00 UTC · next /),
      'Agent',
      '@Hoots',
      'Where',
      'this Room',
      'Does',
      "Summarize yesterday's merged PRs for the Room. Group them by area and link each PR.",
      'Stop schedule',
    ]);
    expect(page.afterStop.slice(-2)).toEqual(['Confirm: Stop schedule', 'Cancel']);
    expect(page.detailAxis).toEqual([16, 16, 16, 16, 16, 16]);
    stopped(page, 'deleteRoomSchedule');
    expect(page.inputs).toContainEqual(['deleteRoomSchedule', { roomId: 'room-1', scheduleId: 'daily' }]);
  }, 120_000);

  it('shows the saved workflow steps on timer and event detail pages', async () => {
    for (const [pageName, id, stop] of [
      ['schedule', 'video', 'deleteRoomSchedule'],
      ['subscription', 'sub-2', 'deleteRoomSubscription'],
    ] as const) {
      const page = await proof(`?page=${pageName}&roomId=room-1&${pageName === 'schedule' ? 'scheduleId' : 'subscriptionId'}=${id}`);
      expect(page.text).toEqual(expect.arrayContaining(['When', 'Agent', 'Where', 'Does', 'Feedback triage']));
      expect(page.steps.length).toBeGreaterThan(2);
      expect(page.pendingCircles).toBe(page.allCircles);
      expect(page.detailAxis).toEqual([16, 16, 16, 16, 16, 16, 16]);
      expect(page.inputs).toContainEqual(['readWorkflowDefinition', { roomId: 'corner-1', name: 'feedback-triage' }]);
      if (pageName === 'subscription') expect(page.pushed).toContainEqual({
        pathname: '/beeline/workflow', params: { roomId: 'corner-1', name: 'feedback-triage' },
      });
      stopped(page, stop);
    }
  }, 120_000);

  it('opens a subscription: its event and source, with the same stop control', async () => {
    const page = await proof('?page=subscription&roomId=room-1&subscriptionId=sub-1');
    expect(page.text.slice(0, 2)).toEqual(['Schedules and subscriptions', 'Subscription']);
    expect(page.text.slice(2)).toEqual([
      'When',
      'On new pull request in owner/widgets',
      'Agent',
      '@Ruby',
      'Where',
      'this Room',
      'Does',
      'Triage incoming work.',
      'Stop subscription',
    ]);
    expect(page.afterStop.slice(-2)).toEqual(['Confirm: Stop subscription', 'Cancel']);
    expect(page.detailAxis).toEqual([16, 16, 16, 16, 16, 16]);
    stopped(page, 'deleteRoomSubscription');
    expect(page.inputs).toContainEqual([
      'deleteRoomSubscription',
      { roomId: 'room-1', subscriptionId: 'sub-1' },
    ]);
  }, 120_000);

  it('opens a workflow schedule on the workflow page: its schedule rows, every step pending on the rail, then Stop', async () => {
    const page = await proof(
      '?page=workflow&roomId=corner-1&name=feedback-triage&scheduleId=video&parentRoomId=room-1',
    );
    expect(page.text[0]).toBe('Feedback triage');
    expect(page.text).toEqual(
      expect.arrayContaining([
        'When',
        expect.stringMatching(/^Daily at 14:00 America\/New_York · next /),
        'Agent',
        '@Ruby',
        'Where',
        'issues-triage',
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
        expect.stringMatching(/^Could not load schedules and subscriptions: .*schedule read unavailable · Retry$/),
        'Steps',
      ]),
    );
    expect(page.beforeRetry).not.toContain('Stop schedule');
    expect(page.text).toEqual(expect.arrayContaining(['Agent', '@Ruby', 'issues-triage', 'Stop schedule']));
    expect(page.text.some((line) => line.includes('Could not load'))).toBe(false);
    stopped(page, 'deleteRoomSchedule');
  }, 120_000);
});
