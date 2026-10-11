import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { TranscriptReference } from '../sources/components/buzz/TranscriptReference';
const { theme } = useUnistyles();
const hull = theme.buzz;
const before = new URLSearchParams(location.search).has('before');
createRoot(document.getElementById('root')!).render(
  <View style={{ backgroundColor: hull.bgBase, padding: 24, height: '100%' }}>
    <TranscriptReference>↳ Ruby · @lunchboxfortwo I've read the paper…</TranscriptReference>
    <Text style={{ ...hull.type.body, color: hull.textPrimary, marginBottom: 24 }}>
      Existing reply reference
    </Text>
    {['Viewing Brief · revision 1', 'Viewing shared browser'].map((context) => (
      <View key={context} style={{ marginBottom: 24 }}>
        {before ? null : (
          <TranscriptReference
            viewer
            testID="context"
            onPress={() => {
              document.documentElement.dataset.opened = 'yes';
            }}
          >
            {context}
          </TranscriptReference>
        )}
        <Text style={{ ...hull.type.body, color: hull.textPrimary }}>Could we simplify this?</Text>
        {before ? (
          <Text
            style={{
              ...hull.type.machine,
              alignSelf: 'flex-start',
              color: hull.accent,
              borderWidth: 1,
              borderColor: hull.borderStrong,
              borderRadius: 8,
              paddingHorizontal: 8,
              paddingVertical: 4,
              marginTop: 4,
            }}
          >
            ◉ {context.replace('Viewing ', 'Viewing artifact: ')}
          </Text>
        ) : null}
      </View>
    ))}
  </View>,
);
setTimeout(() => {
  const line = document.querySelector('[data-testid="context"]');
  if (line) {
    const children = Array.from(line.firstElementChild!.children).map((c) =>
      c.getBoundingClientRect(),
    );
    const centers = children.map((r) => r.y + r.height / 2);
    if (Math.abs(centers[0] - centers[1]) > 1) throw Error('not centered');
    (line as HTMLElement).click();
    if (document.documentElement.dataset.opened !== 'yes') throw Error('tap failed');
  }
  document.getElementById('result')!.textContent = 'PASS';
}, 300);
