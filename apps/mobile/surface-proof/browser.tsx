import WorkbenchScreen from '../sources/app/(app)/beeline/settings/workbench';
import ConnectorServiceScreen from '../sources/app/(app)/beeline/settings/workbench/service';
import React from 'react';
// @ts-expect-error react-dom has no declarations in this workspace.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import ConnectAppScreen, {
  ConnectorsSearchSheet,
} from '../sources/app/(app)/beeline/settings/workbench/connect-app';
import { RepoPicker } from '../sources/components/buzz/RepoPicker';
import { beelineThemes } from '../sources/buzz/groknight';
const params = new URLSearchParams(location.search),
  surface = params.get('surface');
const theme = beelineThemes[params.get('theme') === 'bone' ? 'bone' : 'obsidian'];
const view = {
  companies: {
    suggestions: [
      {
        appKey: 'github',
        name: 'GitHub',
        domain: 'github.com',
        purpose: 'Work with repositories and issues.',
      },
    ],
  },
};
createRoot(document.getElementById('root')!).render(
  <View style={{ height: 820, backgroundColor: theme.appCanvas }}>
    {surface === 'workbench' ? (
      <WorkbenchScreen />
    ) : surface === 'service' ? (
      <ConnectorServiceScreen />
    ) : surface === 'sheet' ? (
      <ConnectorsSearchSheet
        visible
        onClose={() => {}}
        scope={{ workspaceId: 'fixture', viewerId: 'fixture' }}
        view={view as any}
      />
    ) : surface === 'page' ? (
      <ConnectAppScreen />
    ) : (
      <View style={{ margin: 16, padding: 8, backgroundColor: theme.bgHighlight }}>
        <RepoPicker
          candidates={Array.from({ length: 12 }, (_, i) => ({
            key: `repo-${i}`,
            name: `beeline-work/project-${i}`,
            remote: `https://github.com/beeline-work/project-${i}`,
            defaultBranch: 'main',
          }))}
          onSelect={() => {}}
          draftContext="proof"
        />
      </View>
    )}
  </View>,
);
setTimeout(() => {
  const title =
    surface === 'repos' ? 'BEELINE-WORK' : surface === 'service' ? 'YOUR COMPUTERS' : 'SUGGESTED';
  const header = Array.from(document.querySelectorAll('[role="heading"]')).find(
    (node) => node.textContent === title,
  ) as HTMLElement;
  document.getElementById('result')!.textContent = JSON.stringify({
    fill: header ? getComputedStyle(header.parentElement!).backgroundColor : 'missing',
    rowFill:
      header && surface === 'repos'
        ? getComputedStyle(header.parentElement!.parentElement!).backgroundColor
        : null,
    errors: (window as any).__console.filter((line: string) => line.startsWith('error:')),
  });
}, 1000);
