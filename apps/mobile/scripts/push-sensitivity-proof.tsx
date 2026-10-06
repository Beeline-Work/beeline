import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { PushLevelSetting } from '../sources/components/buzz/PushLevelSetting';
import type { PushLevel } from '@beeline/api-contract/phone';

function Harness() {
  const { theme } = useUnistyles();
  const [level, setLevel] = React.useState<PushLevel>('mine');
  return (
    <View
      style={{ backgroundColor: theme.buzz.bgBase, minHeight: 900, padding: theme.buzz.space.md }}
    >
      <PushLevelSetting
        value={level}
        onSave={async (next) => {
          setLevel(next);
        }}
      />
    </View>
  );
}
async function run() {
  const fonts = [
    ['SpaceGrotesk-Regular', require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf')],
    ['SpaceGrotesk-Medium', require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf')],
    ['SpaceGrotesk-SemiBold', require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf')],
    ['IBMPlexMono-Regular', require('../sources/assets/fonts/IBMPlexMono-Regular.ttf')],
  ];
  const style = document.createElement('style');
  style.textContent =
    'body{margin:0}#result{display:none}' +
    fonts.map(([name, url]) => `@font-face{font-family:'${name}';src:url(${url})}`).join('');
  document.head.appendChild(style);
  createRoot(document.getElementById('root')!).render(<Harness />);
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.querySelector<HTMLElement>('[data-testid="push-notifications-setting"]')!.click();
  await new Promise((resolve) => setTimeout(resolve, 350));
  const labels = ['direct', 'mine', 'all'].map(
    (level) => document.querySelector(`[data-testid="push-level-${level}"]`)?.textContent,
  );
  document.getElementById('result')!.textContent = labels.every(Boolean)
    ? `PASS ${labels.join(' | ')}`
    : `FAIL ${JSON.stringify(labels)}`;
}
run().catch((error) => {
  document.getElementById('result')!.textContent = String(error);
});
