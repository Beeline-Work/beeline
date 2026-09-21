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

const page = {
  backgroundColor: groknight.bgVoid,
  flexDirection: 'row',
  height: 260,
} as const;
const desktopSlot = { width: 300, height: 260 } as const;
const drawerSlot = { width: 120, height: 260, paddingTop: 8 } as const;
const label = { color: groknight.textSecondary, fontSize: 10, paddingLeft: 8 } as const;

const root = createRoot(document.getElementById('root')!);
root.render(
  <View style={page}>
    <View style={desktopSlot}>
      <DesktopWorkspaceRail
        activeWorkspaceId="alpha"
        onAdd={() => undefined}
        onClose={() => undefined}
        onSelect={() => undefined}
        open
        workspaces={workspaces}
      />
      <Text style={[label, { paddingLeft: 90, paddingTop: 200 }]}>desktop rail</Text>
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
