import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { DesktopWorkspaceStrip } from '@/components/buzz/DesktopWorkspaceStrip';
import { CommunitySwitcherTrigger } from '@/components/buzz/CommunityRail';
import { RoomCornersList } from '@/components/buzz/RoomCornersList';
import { DesktopMessageAction } from '@/components/buzz/DesktopMessageAction';
import type { CornerListItem } from '@beeline/buzz-client';

const clicks: string[] = [];
const actions = ['copy', 'reply', 'react', 'bookmark', 'report', 'forward'] as const;
const corners = ['short', 'a-long-corner-title-that-wraps-across-several-lines'].map((name, i) => ({
  corner: {
    id: name,
    name,
    parentId: 'parent',
    workspaceId: 'workspace',
    about: i
      ? 'A long objective that wraps across multiple lines in the desktop cell to measure both ends of the rail.'
      : 'Review the desktop fix.',
  },
  state: i ? 'waiting' : 'working',
  stateAt: 1790000000,
  lifecycle: { lifecycle: 'working', checks: 'unknown' },
  agent: { pubkey: 'agent', kind: 'agent', name: 'Jellybean' },
  briefRevision: 1,
})) as unknown as CornerListItem[];

createRoot(document.getElementById('root')!).render(
  <div style={{ display: 'flex', height: 680 }}>
    <DesktopWorkspaceStrip
      workspaces={[{ id: 'workspace', name: 'Sample Workspace' } as any]}
      activeWorkspaceId="workspace"
      viewerName="Sample account with a longer name that must wrap"
      viewerPubkey="viewer"
      onSelect={() => {}}
      onAdd={() => {}}
      onAccount={() => clicks.push('settings')}
    />
    <div style={{ width: 480, padding: 24 }}>
      <CommunitySwitcherTrigger
        community={{ communityId: 'workspace', name: 'Sample Workspace' }}
        expanded={false}
        attention
        onPress={() => {}}
      />
      <RoomCornersList
        corners={corners}
        parentRoomId="parent"
        parentRoomName="Beeline"
        desktop
        onOpenBrief={() => {}}
      />
    </div>
    <div style={{ padding: 24, flex: 1 }}>
      <div style={{ display: 'flex', marginTop: 64 }}>
        {actions.map((action) => (
          <DesktopMessageAction
            key={action}
            action={action}
            label={action}
            tooltip={
              action === 'report'
                ? 'Report an issue'
                : action.charAt(0).toUpperCase() + action.slice(1)
            }
            testID={`proof-${action}`}
            onPress={() => clicks.push(action)}
            onFocus={() => {}}
            onBlur={() => {}}
          />
        ))}
      </div>
    </div>
  </div>,
);

setTimeout(async () => {
  const lines: string[] = [];
  const faults: string[] = [];
  const account = document.querySelector<HTMLElement>('[data-testid="desktop-strip-account"]')!;
  const caption = [...account.querySelectorAll('*')].find(
    (node) => node.textContent === 'Settings',
  );
  lines.push(`settings caption: ${caption ? 'visible' : 'missing'}`);
  if (!caption) faults.push('Settings caption missing');
  else {
    const box = caption.getBoundingClientRect();
    if (box.bottom > 680 || box.height < 19) faults.push('Settings caption clipped');
  }
  account.focus();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const label = document.querySelector('[data-testid="desktop-strip-account-label"]');
  lines.push(`settings focus label: ${label ? 'visible' : 'missing'}`);
  if (!label || label.getBoundingClientRect().bottom > 680)
    faults.push('Settings focus label missing or clipped');
  const overlay = !!document.querySelector('[data-testid="workspace-attention"]');
  lines.push(`desktop workspace overlay: ${overlay ? 'present' : 'absent'}`);
  if (overlay) faults.push('Workspace corner overlay present');
  for (const corner of corners) {
    const cell = document.querySelector(`[data-testid="room-corner-${corner.corner.id}"]`)!;
    const rail = document.querySelector(`[data-testid="room-corner-rail-${corner.corner.id}"]`);
    if (!rail) {
      lines.push(`${corner.corner.id}: rail does not span cell`);
      faults.push('No full-cell rail');
      continue;
    }
    const c = cell.getBoundingClientRect(),
      r = rail.getBoundingClientRect();
    const top = r.top - c.top,
      bottom = c.bottom - r.bottom - 1;
    lines.push(`${corner.corner.id}: rail insets ${top}/${bottom}`);
    if (top !== 8 || bottom !== 8) faults.push('Rail insets unequal');
  }
  for (const action of actions) {
    const button = document.querySelector<HTMLElement>(`[data-testid="proof-${action}"]`)!;
    button.focus();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const tip = document.querySelector(`[data-testid="proof-${action}-tooltip"]`);
    const svg = button.querySelector('svg')!;
    const box = button.getBoundingClientRect();
    if (
      !tip ||
      svg.getAttribute('width') !== '18' ||
      svg.getAttribute('height') !== '18' ||
      box.width !== 44 ||
      box.height !== 44
    )
      faults.push(`Invalid ${action} dimensions or tooltip`);
    button.click();
  }
  if (actions.some((action) => !clicks.includes(action))) faults.push('Action callback missing');
  lines.push('six action icons: 18×18; targets: 44×44; keyboard tooltips and callbacks checked');
  document.getElementById('result')!.textContent =
    `${faults.length ? 'FAIL' : 'PASS'}\n${lines.join('\n')}\n${faults.join('\n')}`;
}, 800);
