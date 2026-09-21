import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { CommunityRail, CommunitySwitcherTrigger } from '../sources/components/buzz/CommunityRail';
import { DesktopWorkspaceRail } from '../sources/components/buzz/DesktopWorkspaceRail';
import WorkspaceSettings from '../sources/app/(app)/beeline/settings/workspace';

// A loud full-bleed square so the picture's own corners are unmistakable
// against the tile plate: white field, black corner blocks.
const PICTURE =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
      '<rect width="96" height="96" fill="#ffffff"/>' +
      '<rect x="0" y="0" width="28" height="28" fill="#000000"/>' +
      '<rect x="68" y="0" width="28" height="28" fill="#000000"/>' +
      '<rect x="0" y="68" width="28" height="28" fill="#000000"/>' +
      '<rect x="68" y="68" width="28" height="28" fill="#000000"/>' +
      '</svg>',
  );

const workspaces = [
  { id: 'alpha', name: 'Alpha', avatar: PICTURE, roomCount: 4, needsAttention: false },
  { id: 'bravo', name: 'Bravo', avatar: PICTURE, roomCount: 1, needsAttention: true },
];

const SURFACES = [
  { name: 'desktop-rail', tile: 'desktop-workspace-tile-alpha', mark: 'desktop-workspace-mark-alpha' },
  { name: 'mobile-drawer', tile: 'community-rail-alpha', mark: 'workspace-avatar-alpha' },
  { name: 'header-plate', tile: 'workspace-header-plate', mark: 'workspace-avatar-header' },
  { name: 'settings-tile', tile: 'workspace-picture-change', mark: 'workspace-picture-mark' },
];

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const round = (value: number) => Math.round(value * 100) / 100;
const report = (text: string) => {
  const target = document.getElementById('result');
  if (target) target.textContent = text;
};

/**
 * Measures what actually painted on one surface: the picture's box against the
 * tile it sits in, and the radius of whatever rounds the picture. A seated
 * picture shows the same slab of margin on all four sides, is rounded by its
 * own seat rather than cropped by the bezel, and carries the radius the tile's
 * own geometry derives — the tile radius less the bezel (the inner radius),
 * less that margin. Concentric curves, one even gap: the parity contract.
 */
function readSeat(surface: { name: string; tile: string; mark: string }): string {
  const tileNode = document.querySelector(`[data-testid="${surface.tile}"]`);
  const markNode = document.querySelector(`[data-testid="${surface.mark}"]`);
  if (!tileNode || !markNode) {
    return `${surface.name}: NOT RENDERED (${surface.tile} / ${surface.mark})`;
  }
  const tileStyle = getComputedStyle(tileNode);
  const tileBox = tileNode.getBoundingClientRect();
  const markBox = markNode.getBoundingClientRect();
  const bezel = parseFloat(tileStyle.borderTopWidth) || 0;
  const tileRadius = parseFloat(tileStyle.borderTopLeftRadius) || 0;
  const seatNode = markNode.parentElement!;
  const seatStyle = getComputedStyle(seatNode);
  const seatRadius = parseFloat(seatStyle.borderTopLeftRadius) || 0;
  const seats = seatNode !== tileNode && seatStyle.overflow === 'hidden';
  const slab = {
    left: round(markBox.left - tileBox.left - bezel),
    top: round(markBox.top - tileBox.top - bezel),
    right: round(tileBox.right - bezel - markBox.right),
    bottom: round(tileBox.bottom - bezel - markBox.bottom),
  };
  const margin = slab.left;
  const even = slab.top === margin && slab.right === margin && slab.bottom === margin && margin > 0;
  const derived = round(tileRadius - bezel - margin);
  const faults: string[] = [];
  if (!seats) faults.push('the picture has no seat — nothing rounds it inside the bezel');
  if (!even) faults.push('the slab is uneven');
  if (Math.abs(seatRadius - derived) > 0.01) {
    faults.push(`seat radius ${round(seatRadius)} is not the derived ${derived}`);
  }
  const measured =
    `${surface.name}: tile ${round(tileBox.width)}×${round(tileBox.height)} radius ${tileRadius} bezel ${bezel}, ` +
    `picture ${round(markBox.width)}×${round(markBox.height)} seat radius ${round(seatRadius)} ` +
    `(derived ${derived}), slab ${slab.left}/${slab.top}/${slab.right}/${slab.bottom}`;
  return faults.length === 0
    ? `${measured} — SEATED`
    : `${measured} — NOT SEATED: ${faults.join('; ')}`;
}

async function read() {
  createRoot(document.getElementById('root')!).render(
    <View style={{ flexDirection: 'row' } as const}>
      <View style={{ width: 300, height: 520 } as const}>
        <DesktopWorkspaceRail
          activeWorkspaceId="alpha"
          onAdd={() => undefined}
          onClose={() => undefined}
          onOpenAccount={() => undefined}
          onSelect={() => undefined}
          open
          workspaces={workspaces}
        />
      </View>
      <View style={{ width: 120, height: 520 } as const}>
        <CommunityRail
          activeCommunityId="alpha"
          communities={workspaces.map((workspace) => ({
            communityId: workspace.id,
            name: workspace.name,
            avatar: workspace.avatar,
          }))}
          onAdd={() => undefined}
          onSelect={() => undefined}
          onSettings={() => undefined}
        />
      </View>
      <View style={{ width: 360, height: 520 } as const}>
        <View style={{ flexDirection: 'row' } as const}>
          <CommunitySwitcherTrigger
            community={{ communityId: 'alpha', name: 'Alpha', avatar: PICTURE }}
            expanded={false}
            onPress={() => undefined}
          />
        </View>
        <View style={{ flex: 1 } as const}>
          <WorkspaceSettings />
        </View>
      </View>
    </View>,
  );
  // The settings screen loads its Workspace before it can paint the picture.
  await pause();
  await pause();

  const lines = SURFACES.map(readSeat);
  const failed = lines.filter((line) => !line.endsWith('— SEATED'));
  report(`${failed.length === 0 ? 'PASS' : 'FAIL'}\n${lines.join('\n')}`);
}

read().catch((error) => report(`FAIL ${String(error)}`));
