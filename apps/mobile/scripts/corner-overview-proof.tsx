import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import type { CornerListItem, CornerListView } from '@beeline/buzz-client';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import BuzzCorners from '../sources/app/(app)/beeline/corners/[roomId]';

/**
 * The real corners page at desktop width: one cell per corner (owner agent and
 * full name, state on the right, the corner's objective panel under them),
 * Waiting / Mine / All filters with All first, and Read brief offered only on
 * corners that have a brief.
 */
const ROOM = '11111111-1111-4111-8111-111111111111';
const VIEWER = 'a'.repeat(64);
const SOMEONE = 'b'.repeat(64);

function corner(
  id: string,
  name: string,
  state: CornerListItem['state'],
  agent: string,
  about: string,
  extra: Partial<CornerListItem> = {},
): CornerListItem {
  return {
    corner: { id, name, about, workspaceId: 'w', parentId: ROOM },
    lifecycle: { lifecycle: 'working', checks: 'unknown' },
    state,
    stateAt: 1_790_000_000,
    initiator: { pubkey: SOMEONE, kind: 'human', name: 'Sam' },
    agent: { pubkey: agent.padEnd(64, 'f'), kind: 'agent', name: agent },
    ...extra,
  } as CornerListItem;
}

const CORNERS = [
  corner('corner-pane', 'Corner pane rules', 'waiting', 'Ruby',
    'Research when Slack and leading IDEs open a second pane, and propose clearer corner pane and list rules for Beeline web and desktop.',
    { initiator: { pubkey: VIEWER, kind: 'human', name: 'Me' }, briefRevision: 5 }),
  corner('corner-hyphen', 'Hyphenated room names', 'waiting', 'Earth',
    'Replace whitespace with hyphens during name entry and reject whitespace in room and corner names.',
    { awaitsViewer: true, briefRevision: 2 }),
  corner('corner-ios', 'iOS Settings title', 'working', 'BBC',
    'Reproduce the clipped trailing "s" in the iOS Settings page title at Medium text size, then fix it narrowly.',
    { briefRevision: 1 }),
  corner('corner-validators', 'Workflow validators', 'working', 'Sol',
    'Split corner and saved workflow validators so each reports its own failures.',
    { briefRevision: 3 }),
  corner('corner-release', 'Release Corner', 'review', 'Hoots',
    'Verify no run exists; dispatch main through unified workflow; confirm OTA promotion and record; never change, push, merge code or submit stores.',
    { initiator: { pubkey: VIEWER, kind: 'human', name: 'Me' } }),
  corner('corner-triage', 'Issues triage', 'idle', 'Milo',
    'Standing Feedback triage corner: run the Beeline feedback sweep daily, file or attach redacted issues, dismiss noise, and open fix corners.'),
];

const WORKFLOWS: WorkflowRunSummaryView[] = [
  {
    runId: 'run-1',
    workflowSlug: 'ship',
    description: 'Ship a change',
    roomId: 'corner-validators',
    roomName: 'Workflow validators',
    parentRoomId: ROOM,
    state: 'implement',
    status: 'live',
    viewerHolds: false,
    startedAt: 1,
    updatedAt: 2,
  },
];

const globals = globalThis as Record<string, unknown>;
globals.overviewView = (options?: { archived?: boolean }) =>
  ({
    room: { id: ROOM, name: 'beeline', workspaceId: 'w' },
    corners: options?.archived ? [] : CORNERS,
    apps: [],
    viewer: { identity: { pubkey: VIEWER, kind: 'human', name: 'Me' }, role: 'member', permissions: {} },
    watchFilters: [],
  }) as unknown as CornerListView;
globals.overviewWorkflows = WORKFLOWS;
globals.overviewOperations = [];
globals.overviewPushes = [];
const roomReads: string[] = [];
globals.overviewRoom = (id: string) => {
  roomReads.push(id);
  return { cornerBrief: { revision: 5, spec: '## Intent', attachments: [] } };
};
const briefsOpened: number[] = [];
globals.overviewBriefOpened = (brief: { revision: number }) => briefsOpened.push(brief.revision);

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const byTestId = (testID: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
const cells = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="room-corner-corner-"]')).map(
    (node) => node.dataset.testid!.slice('room-corner-'.length),
  );
const tap = async (testID: string) => {
  byTestId(testID)!.click();
  for (let i = 0; i < 4; i += 1) await pause();
};

async function run() {
  createRoot(document.getElementById('root')!).render(<BuzzCorners />);
  for (let i = 0; i < 8; i += 1) await pause();
  const lines: string[] = [];
  const filters = ['waiting', 'mine', 'all'].map((key) => byTestId(`room-corners-filter-${key}`)?.textContent);
  lines.push(`filters: ${filters.join(' | ')}`);
  assert(filters.join('|') === 'Waiting · 2|Mine · 3|All · 6', `filters: ${filters}`);

  const all = cells();
  lines.push(`All: ${all.join(',')}`);
  assert(all.length === 6, `all: ${all}`);
  for (const item of CORNERS) {
    const cell = byTestId(`room-corner-${item.corner.id}`)!;
    const text = cell.textContent ?? '';
    assert(text.includes(item.corner.name), `${item.corner.id} name`);
    assert(text.includes(item.state), `${item.corner.id} state word`);
    assert(text.includes(item.corner.about!), `${item.corner.id} objective is not shown in full`);
    const brief = Boolean(byTestId(`room-corner-objective-${item.corner.id}-brief`));
    assert(brief === Boolean(item.briefRevision), `${item.corner.id} Read brief ${brief}`);
    lines.push(`  ${item.corner.id}: "${item.corner.name}" ${item.state}, objective in full, Read brief ${brief ? 'yes' : 'no'}`);
  }
  lines.push(`phone operations: ${(globals.overviewOperations as string[]).join(',')}`);
  assert(
    (globals.overviewOperations as string[]).join(',') === `listRoomWorkflowRuns:${ROOM}`,
    'workflow runs were not read once for the Room',
  );
  const workflow = byTestId('room-corner-objective-corner-validators-workflow-copy')?.textContent;
  lines.push(`workflow line on corner-validators: ${workflow}`);
  assert(Boolean(workflow), 'live workflow line missing');
  assert(!byTestId('room-corner-objective-corner-ios-workflow'), 'workflow line on a corner with no run');

  await tap('room-corners-filter-waiting');
  lines.push(`Waiting: ${cells().join(',')}`);
  assert(cells().join(',') === 'corner-pane,corner-hyphen', `waiting: ${cells()}`);
  await tap('room-corners-filter-mine');
  lines.push(`Mine: ${cells().join(',')}`);
  assert(cells().join(',') === 'corner-pane,corner-hyphen,corner-release', `mine: ${cells()}`);
  await tap('room-corners-filter-all');
  assert(cells().length === 6, 'All did not restore every corner');

  const pushesBefore = (globals.overviewPushes as unknown[]).length;
  await tap('room-corner-objective-corner-pane-brief');
  assert((globals.overviewPushes as unknown[]).length === pushesBefore, 'Read brief also opened the corner');
  lines.push(`Read brief on corner-pane: read ${roomReads.join(',')}, opened revision ${briefsOpened.join(',')}`);
  assert(roomReads.join(',') === 'corner-pane' && briefsOpened.join(',') === '5', 'brief did not open');
  report(`PASS\n${lines.join('\n')}`);
}

run().catch((error) => report(`FAIL ${String(error)}`));
