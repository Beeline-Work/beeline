import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { CommunityRail } from '../sources/components/buzz/CommunityRail';
import { DesktopWorkspaceRail } from '../sources/components/buzz/DesktopWorkspaceRail';
import { groknight } from '../sources/buzz/groknight';

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

/**
 * Measures what actually painted: the picture's box against the tile it sits
 * in, and the picture's own corner radius. A seated picture shows the same
 * margin of slab on every side and never reaches the bezel.
 */
function SeatReadout({ tile, mark, name }: { tile: string; mark: string; name: string }) {
  const [lines, setLines] = React.useState<string[]>([]);
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const tileNode = document.querySelector(`[data-testid="${tile}"]`);
      const markNode = document.querySelector(`[data-testid="${mark}"]`);
      if (!tileNode || !markNode) return;
      const tileBox = tileNode.getBoundingClientRect();
      const markBox = markNode.getBoundingClientRect();
      const bezel = parseFloat(getComputedStyle(tileNode).borderTopWidth) || 0;
      const radius = getComputedStyle(markNode.parentElement!).borderTopLeftRadius;
      const round = (value: number) => Math.round(value * 100) / 100;
      setLines([
        `${name}: tile ${round(tileBox.width)}×${round(tileBox.height)}, bezel ${bezel}`,
        `picture ${round(markBox.width)}×${round(markBox.height)}, radius ${radius}`,
        `slab L${round(markBox.left - tileBox.left - bezel)} ` +
          `T${round(markBox.top - tileBox.top - bezel)} ` +
          `R${round(tileBox.right - bezel - markBox.right)} ` +
          `B${round(tileBox.bottom - bezel - markBox.bottom)}`,
      ]);
    });
    return () => cancelAnimationFrame(frame);
  }, [mark, name, tile]);
  return (
    <>
      {lines.map((line) => (
        <Text key={line} style={readout}>
          {line}
        </Text>
      ))}
    </>
  );
}

const page = {
  backgroundColor: groknight.bgVoid,
  flexDirection: 'row',
  height: 260,
} as const;
const desktopSlot = { width: 300, height: 260 } as const;
const drawerSlot = { width: 120, height: 260, paddingTop: 8 } as const;
const label = { color: groknight.textSecondary, fontSize: 10, paddingLeft: 8 } as const;
const readout = { color: groknight.textPrimary, fontSize: 9, paddingLeft: 8 } as const;

const root = createRoot(document.getElementById('root')!);
root.render(
  <View style={page}>
    <View style={desktopSlot}>
      <DesktopWorkspaceRail
        activeWorkspaceId="alpha"
        onAdd={() => undefined}
        onClose={() => undefined}
        onOpenAccount={() => undefined}
        onSelect={() => undefined}
        open
        workspaces={workspaces}
      />
      <View style={{ paddingLeft: 82, paddingTop: 150 } as const}>
        <Text style={label}>desktop rail</Text>
        <SeatReadout
          mark="desktop-workspace-mark-alpha"
          name="desktop"
          tile="desktop-workspace-tile-alpha"
        />
        <SeatReadout mark="workspace-avatar-alpha" name="drawer" tile="community-rail-alpha" />
      </View>
    </View>
    <View style={drawerSlot}>
      <Text style={label}>mobile drawer</Text>
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
  </View>,
);
